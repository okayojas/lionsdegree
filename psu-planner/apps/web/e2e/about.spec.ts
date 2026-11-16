/** About, as a page of its own (#62).
 *
 * About and Contact were two sections at the bottom of the landing page:
 * somewhere you scrolled to, not somewhere you could link to. They are a page
 * now, at /about/, with the same words.
 *
 * What is NOT repeated here: that the page sits on cream, wears the shared
 * header, fits a phone and passes axe. `/about/` is in the header's page list,
 * so site-pages.spec.ts holds it to all of that along with the others.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/** The address a student writes to. A literal, so the test does not agree
 * with whatever the page happens to say. */
const ADDRESS = "ovk5113@psu.edu";

test.describe("/about/ with JavaScript turned off", () => {
  // A crawler, a link previewer and a student on a locked-down machine all
  // read this page without running anything.
  test.use({ javaScriptEnabled: false });

  test("says who built this, and that they are a student", async ({ page }) => {
    const res = await page.goto("/about/");
    expect(res?.status(), "/about/ did not serve").toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("About");
    // One student, named. Copy implying a team or a company would be the kind
    // of small lie that makes the honest parts read as marketing too; and an
    // About that never says WHO owes its reader the one thing it is for.
    const text = (await page.locator("main").innerText()).toLowerCase();
    expect(text, "about does not say who built this").toMatch(/ojas/);
    expect(text, "about does not say they are a student").toMatch(/student/);
    expect(text, "about claims a team that does not exist").not.toMatch(/\bour team\b|\bwe are a company\b/);
    // The claim a reader can check for themselves.
    await expect(page.locator("main").getByRole("link", { name: /open source/i })).toHaveAttribute(
      "href",
      "https://github.com/okayojas/lionsdegree",
    );
  });

  test("the words are the ones the landing page had", async ({ page }) => {
    // The ticket moves the sections; it does not rewrite them. One sentence
    // from each paragraph, so an edit to any of them shows up here.
    await page.goto("/about/");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    for (const sentence of [
      "a Penn State student studying Engineering Science and AI Engineering",
      "every student I know ends up building the same slightly-wrong spreadsheet",
      "It's free and it always will be.",
      "Found a requirement read wrong?",
    ]) {
      expect(text, `"${sentence}" is not on the page`).toContain(sentence);
    }
  });

  test("contact reaches a human, privately, with no script", async ({ page }) => {
    // The form is script-driven. If it were the ONLY route, a student on a
    // locked-down machine would have a bug to report and nowhere to put it.
    // And the address matters for a second reason: a request about someone's
    // own data must not have to be filed on a public tracker.
    await page.goto("/about/");
    const contact = page.locator("#contact");
    await expect(contact.getByRole("heading", { name: "Contact" })).toBeVisible();
    const mail = contact.getByRole("link", { name: ADDRESS });
    await expect(mail).toBeVisible();
    await expect(mail).toHaveAttribute("href", `mailto:${ADDRESS}`);
    await expect(contact.locator("#feedback-form"), "the form shows before it can work").toBeHidden();
  });

  test("has a title and a description of its own", async ({ page }) => {
    await page.goto("/about/");
    const about = { title: await page.title(), description: await page.locator('meta[name="description"]').getAttribute("content") };
    expect(about.title).toMatch(/About/);
    expect(about.description?.length ?? 0, "no description for a preview card to show").toBeGreaterThan(40);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/about\/$/);
    for (const other of ["/", "/connect/"]) {
      await page.goto(other);
      expect(await page.title(), `${other} and /about/ share a title`).not.toBe(about.title);
      expect(await page.locator('meta[name="description"]').getAttribute("content"), `${other} and /about/ share a description`)
        .not.toBe(about.description);
    }
  });
});

test.describe("the feedback form", () => {
  /** Nothing in this block may reach the real database: the build under test
   * can be a configured one, and a test run is not feedback. Every request to
   * the backend is answered here, and the ones that arrive are kept. */
  async function intercept(page: Page): Promise<{ inserts: Record<string, unknown>[] }> {
    const seen = { inserts: [] as Record<string, unknown>[] };
    await page.route(/supabase\.co/, async (route) => {
      const req = route.request();
      if (req.method() === "POST" && /\/rest\/v1\/feedback/.test(req.url())) {
        seen.inserts.push(req.postDataJSON() as Record<string, unknown>);
        return route.fulfill({ status: 201, contentType: "application/json", body: "" });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    return seen;
  }

  test("appears once the script can drive it", async ({ page }) => {
    await page.goto("/about/");
    const form = page.locator("#feedback-form");
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute("data-enhanced", "true");
    await expect(form.getByLabel("What is on your mind?")).toBeVisible();
    // Email is optional: feedback that requires identifying yourself is
    // feedback you do not get.
    await expect(form.locator("#fb-email")).not.toHaveAttribute("required", /.*/);
  });

  test("refuses an empty message instead of sending nothing", async ({ page }) => {
    const seen = await intercept(page);
    await page.goto("/about/");
    await page.getByRole("button", { name: "Send feedback" }).click();
    await expect(page.locator("#feedback-form [data-status]")).toBeVisible();
    await expect(page.locator("#feedback-form")).toHaveAttribute("data-state", "error");
    expect(seen.inserts).toEqual([]);
  });

  test("sends what was typed, and says so", async ({ page }) => {
    const seen = await intercept(page);
    await page.goto("/about/");
    const form = page.locator("#feedback-form");
    await expect(form).toHaveAttribute("data-enhanced", "true");
    // Decided at build time. A build with no account service has nowhere to
    // send it; what it owes the student then is the truth and the address.
    const configured = (await form.getAttribute("data-state")) !== "unavailable";

    const message = "CMPSC 465 shows as needing MATH 230, but the Bulletin says MATH 220.";
    await form.getByLabel("What is on your mind?").fill(message);
    await page.getByRole("button", { name: "Send feedback" }).click();
    const status = form.locator("[data-status]");

    if (!configured) {
      await expect(status).toContainText(/isn't available on this build/i);
      await expect(form.getByLabel("What is on your mind?"), "a failed send threw the message away").toHaveValue(message);
      return;
    }
    await expect(form).toHaveAttribute("data-state", "sent");
    await expect(status).toContainText(/that's been sent/i);
    expect(seen.inserts).toHaveLength(1);
    // The same row the landing page wrote, from the page it is on now.
    expect(seen.inserts[0]).toMatchObject({ body: message, email: null, page: "/about/" });
    await expect(form.getByLabel("What is on your mind?")).toHaveValue("");
  });

  test("a bot that fills the hidden field is thanked and sent nowhere", async ({ page }) => {
    const seen = await intercept(page);
    await page.goto("/about/");
    const trap = page.locator("#fb-website");
    await expect(trap).toHaveCount(1);
    // Off-screen, not display:none, and out of the tab order, so a keyboard
    // user never lands in a field they cannot see.
    await expect(trap).toHaveAttribute("tabindex", "-1");
    await expect(page.locator(".fb-trap")).toHaveAttribute("aria-hidden", "true");
    const box = (await trap.boundingBox())!;
    expect(box.x + box.width, "the trap is on screen").toBeLessThan(0);

    await page.getByLabel("What is on your mind?").fill("Buy cheap course codes at example dot com");
    await trap.evaluate((el: HTMLInputElement) => { el.value = "https://example.com"; });
    await page.getByRole("button", { name: "Send feedback" }).click();
    await expect(page.locator("#feedback-form")).toHaveAttribute("data-state", "sent");
    expect(seen.inserts, "the honeypot let a bot's message through").toEqual([]);
  });

  test("the fields can be read and the button can be pressed", async ({ page }) => {
    // The form moved from a dark page to a cream one, under a stylesheet whose
    // bare `button` rules repaint a pressed button paper-coloured. Measured
    // rather than assumed, in both states a sighted student meets.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/about/");
    const send = page.getByRole("button", { name: "Send feedback" });
    await expect(send).toBeVisible();
    const contrast = () =>
      send.evaluate((b) => {
        const lum = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const L = (css: string) => {
          const [r, g, bl] = css.match(/[\d.]+/g)!.map(Number);
          return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(bl);
        };
        const fg = L(getComputedStyle(b).color), bg = L(getComputedStyle(b).backgroundColor);
        return { active: b.matches(":active"), ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) };
      });
    expect((await contrast()).ratio, "the Send button cannot be read at rest").toBeGreaterThanOrEqual(4.5);
    await send.focus();
    await page.keyboard.down("Space");
    const pressed = await contrast();
    // Released over the page, not the button, so nothing is submitted.
    await page.locator("h1").focus().catch(() => {});
    await page.keyboard.up("Space");
    expect(pressed.active, "the button was not actually pressed, so this measured nothing").toBe(true);
    expect(pressed.ratio, "a pressed Send button cannot be read").toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("the landing page, now that About has moved out", () => {
  test("carries neither section, and its links to them go to the page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "About", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Contact", exact: true })).toHaveCount(0);
    await expect(page.locator("#feedback-form")).toHaveCount(0);
    // Nothing on the page still points at an anchor that is not there.
    await expect(page.locator('a[href="#about"], a[href="/#about"], a[href="#contact"], a[href="/#contact"]')).toHaveCount(0);
    // Reachable at every width from the footer; the bar keeps only the brand
    // and the primary action on a phone.
    const foot = page.getByRole("contentinfo");
    await expect(foot.getByRole("link", { name: "About", exact: true })).toHaveAttribute("href", "/about/");
    await expect(foot.getByRole("link", { name: "Contact", exact: true })).toHaveAttribute("href", "/about/#contact");
  });

  test("an old link to #about arrives at About", async ({ page }) => {
    await page.goto("/#about");
    await page.waitForURL(/\/about\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("About");
  });

  test("an old link to #contact arrives at Contact", async ({ page }) => {
    await page.goto("/#contact");
    await page.waitForURL(/\/about\/#contact$/);
    await expect(page.getByRole("heading", { name: "Contact" })).toBeInViewport();
  });

  test("the way back from About is not a bounce", async ({ page }) => {
    // The old address is replaced in the history, not added to it. Otherwise
    // Back returns to `/#about`, which sends the visitor forward again, and
    // they cannot leave.
    await page.goto("/connect/");
    await page.goto("/#about");
    await page.waitForURL(/\/about\/$/);
    await page.goBack();
    await page.waitForURL(/\/connect\/$/);
  });

  test("a link to any other part of the landing page is left alone", async ({ page }) => {
    await page.goto("/#hero");
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname).toBe("/");
  });
});

test.describe("old links, with JavaScript turned off", () => {
  test.use({ javaScriptEnabled: false });

  for (const [hash, href] of [
    ["#about", "/about/"],
    ["#contact", "/about/#contact"],
  ] as const) {
    test(`/${hash} lands on a visible link to where it went`, async ({ page }) => {
      // Nothing can redirect here. What the browser CAN do is scroll to the
      // element the address names, so the element it names is the link.
      await page.goto(`/${hash}`);
      const link = page.locator(hash);
      await expect(link).toHaveAttribute("href", href);
      await expect(link).toBeInViewport();
    });
  }
});
