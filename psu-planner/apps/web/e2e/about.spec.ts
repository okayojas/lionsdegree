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
    // The ticket moved the sections; it did not rewrite them. These are the
    // four paragraphs as the landing page had them, whole, so an edit to any
    // word of any of them shows up here.
    await page.goto("/about/");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    for (const paragraph of [
      "I'm Ojas Khadakban, a Penn State student studying Engineering Science and AI Engineering. I build things with AI for a living and for fun — AI engineering is the work I want to do, and this is the project where I learned most of it.",
      "LionsDegree started because planning a degree here means holding four documents open at once, and every student I know ends up building the same slightly-wrong spreadsheet. I got tired of it and built the thing I wanted instead: it reads the Bulletin itself, so it knows what actually depends on what.",
      "It's free and it always will be. The whole thing is open source, Apache 2.0 — read it, fork it, tell me where it's wrong.",
      "Found a requirement read wrong? Email ovk5113@psu.edu or open a GitHub issue.",
    ]) {
      expect(text, `not on the page as it was written: "${paragraph}"`).toContain(paragraph);
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
});

test.describe("the feedback form", () => {
  /** What the form tried to store, in this test. */
  let inserts: Record<string, unknown>[];

  /** NOTHING IN THIS BLOCK MAY REACH THE REAL DATABASE. The build under test
   * can be a configured one, and a test run is not feedback. So every request
   * that leaves this origin is answered here, whatever host it was for: a
   * build pointed at a self-hosted backend is caught the same as one pointed
   * at the usual one. */
  test.beforeEach(async ({ page, baseURL }) => {
    inserts = [];
    const here = new URL(baseURL!).origin;
    await page.route(
      (url) => url.origin !== here,
      async (route) => {
        const req = route.request();
        if (req.method() === "POST" && /\/rest\/v1\/feedback/.test(req.url())) {
          inserts.push(req.postDataJSON() as Record<string, unknown>);
          return route.fulfill({ status: 201, contentType: "application/json", body: "" });
        }
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      },
    );
  });

  /** Whether this build has an account service to send to. Decided when it
   * was built; the script marks the form when there is none. */
  async function canSend(page: Page): Promise<boolean> {
    const form = page.locator("#feedback-form");
    await expect(form).toBeVisible();
    return (await form.getAttribute("data-state")) !== "unavailable";
  }

  const MESSAGE = "CMPSC 465 shows as needing MATH 230, but the Bulletin says MATH 220.";

  test("appears once the script can drive it, with the fields it had", async ({ page }) => {
    await page.goto("/about/");
    const form = page.locator("#feedback-form");
    await expect(form).toBeVisible();
    await expect(form.getByLabel("What is on your mind?")).toHaveAttribute(
      "placeholder",
      "CMPSC 465 shows as needing MATH 230, but the Bulletin says MATH 220…",
    );
    // Email is optional, and says so: feedback that requires identifying
    // yourself is feedback you do not get.
    const email = form.getByLabel("Your email optional");
    await expect(email).toBeVisible();
    await expect(email).not.toHaveAttribute("required", /.*/);
    await expect(form.getByRole("button", { name: "Send feedback" })).toBeVisible();
  });

  test("refuses an empty message instead of sending nothing", async ({ page }) => {
    await page.goto("/about/");
    await page.getByRole("button", { name: "Send feedback" }).click();
    await expect(page.getByRole("status")).toContainText(/a little more than that/i);
    expect(inserts).toEqual([]);
  });

  test("sends what was typed, and says so", async ({ page }) => {
    await page.goto("/about/");
    test.skip(!(await canSend(page)), "this build has no account service to send to");
    const body = page.getByLabel("What is on your mind?");
    await body.fill(MESSAGE);
    await page.getByRole("button", { name: "Send feedback" }).click();
    await expect(page.getByRole("status")).toContainText(/that's been sent/i);
    expect(inserts).toHaveLength(1);
    // The same row the landing page wrote, from the page the form is on now.
    expect(inserts[0]).toMatchObject({ body: MESSAGE, email: null, page: "/about/" });
    await expect(body).toHaveValue("");
  });

  test("with nowhere to send it, says so and keeps the message", async ({ page }) => {
    await page.goto("/about/");
    test.skip(await canSend(page), "this build can send; the test above covers it");
    // What the form owes the student then is the truth and the address.
    const body = page.getByLabel("What is on your mind?");
    await body.fill(MESSAGE);
    await page.getByRole("button", { name: "Send feedback" }).click();
    await expect(page.getByRole("status")).toContainText(/isn't available on this build/i);
    await expect(body, "a failed send threw the message away").toHaveValue(MESSAGE);
    expect(inserts).toEqual([]);
  });

  test("a bot that fills the hidden field is thanked and sent nowhere", async ({ page }) => {
    await page.goto("/about/");
    const trap = page.locator("#fb-website");
    await expect(trap).toHaveCount(1);
    // Off-screen, not display:none, and out of the tab order, so a keyboard
    // user never lands in a field they cannot see.
    await expect(trap).toHaveAttribute("tabindex", "-1");
    // Nor is it announced: a screen reader is not told about a field whose
    // only instruction is to leave it alone.
    await expect(page.getByRole("textbox", { name: "Leave this empty" })).toHaveCount(0);
    const box = (await trap.boundingBox())!;
    expect(box.x + box.width, "the trap is on screen").toBeLessThan(0);

    await page.getByLabel("What is on your mind?").fill("Buy cheap course codes at example dot com");
    await trap.evaluate((el: HTMLInputElement) => { el.value = "https://example.com"; });
    await page.getByRole("button", { name: "Send feedback" }).click();
    // Told it worked. Telling a bot it was caught teaches whoever wrote it
    // to stop filling the field.
    await expect(page.getByRole("status")).toContainText(/that's been sent/i);
    expect(inserts, "the honeypot let a bot's message through").toEqual([]);
  });

  test("the Send button can be read, at rest and while it is pressed", async ({ page }) => {
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
    // Letting go submits the form, empty; it is refused, and the block's
    // intercept would answer anything it sent.
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
    // In the footer, at every width. (About is in the header as well.)
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
    await page.goto("/#plan");
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
