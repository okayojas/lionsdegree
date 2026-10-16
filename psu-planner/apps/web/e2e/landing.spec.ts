/** The front door (#14).
 *
 * This page's job is to survive being shared. A student sends the link to a
 * group chat, and what arrives is a preview card rendered by something that
 * does not run JavaScript, followed — if they tap it — by a page that has to
 * load fast on a phone on campus wifi. Everything here is about that path.
 */
import { test, expect, expectNoA11yViolations } from "./fixtures.js";

/** Scroll the whole page and let it settle before an accessibility scan.
 *
 * Scroll reveals start at `opacity: 0`, and axe computes contrast against
 * whatever is actually painted -- so an element mid-reveal measures as a
 * washed-out blend and the scan reports a contrast failure that no reader
 * ever sees. Worse, whether it fires depends on timing, so the result was
 * nondeterministic. Scanning the settled page is also simply more honest:
 * it is the page a student ends up looking at. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 50));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
}

test.describe("with JavaScript turned off", () => {
  // The one script on this page sheds a stale service worker and nothing
  // else; the page must read completely without it. A previewer, a crawler
  // and a student on a locked-down machine all land here.
  test.use({ javaScriptEnabled: false });

  test("the page still explains what this is", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/route/i);
    await expect(page.getByText(/prerequisite/i).first()).toBeVisible();
    await expect(page.getByText("LionsDegree").first()).toBeVisible();
  });

  test("every stop on the route is there", async ({ page }) => {
    await page.goto("/");
    for (const heading of [
      /Straight from the Bulletin/i,
      /Fewest terms, nothing out of sequence/i,
      /Bring your own AI/i,
      /will not pretend to know/i,
    ]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
    // The visual stops alternate with the written ones and carry claims of
    // their own, so they have to render without script too.
    await expect(page.locator('img[src="/shots/audit.png"]')).toBeVisible();
  });

  test("the way into the planner works", async ({ page }) => {
    await page.goto("/");
    const cta = page.getByRole("link", { name: /Open the planner/i }).first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/plan/");
  });

  test("connecting an assistant is a link, not a code block", async ({ page }) => {
    // The page is for students, not developers. There was an npx command and a
    // JSON config block here; a student who has never opened a terminal has no
    // way to act on either, and seeing them says "this is not for you".
    await page.goto("/");
    await expect(page.locator("pre, code"), "the landing page is showing code").toHaveCount(0);
    const cta = page.getByRole("link", { name: /how to connect it/i });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/connect/");
  });

  test("the disclaimer is there and is not hidden in small print", async ({ page }) => {
    await page.goto("/");
    const disclaim = page.getByText(/not affiliated with/i).first();
    await expect(disclaim).toBeVisible();
    // "Prominent" is not a feeling: it has to be at least the body size the
    // rest of the page uses, not shrunk into a footnote.
    const size = await disclaim.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size, `the disclaimer renders at ${size}px`).toBeGreaterThanOrEqual(13);
  });

  test("the disclaimer is readable on a phone without scrolling", async ({ page }) => {
    // Adopting Penn State's own colours strengthens the association, so a
    // student has to meet the statement that this is not Penn State before
    // they meet anything else. In the footer it is true but unread.
    await page.setViewportSize({ width: 375, height: 760 });
    await page.goto("/");
    const box = await page.getByText(/Not affiliated with or endorsed by/i).first().boundingBox();
    expect(box, "no above-the-fold disclaimer found").not.toBeNull();
    expect(box!.y + box!.height, `the disclaimer starts ${Math.round(box!.y)}px down a 760px screen`)
      .toBeLessThanOrEqual(760);
  });
});

test.describe("the hero route", () => {
  test("is drawn, not left half-finished", async ({ page }) => {
    await page.goto("/");
    // Every station eventually appears. The draw is staggered, so this is the
    // end state rather than the first frame.
    const stops = page.locator(".lp-route .route-stop");
    await expect(stops).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(stops.nth(i)).toHaveCSS("opacity", "1", { timeout: 5000 });
    }
  });

  test("names each station with a course code", async ({ page }) => {
    await page.goto("/");
    const names = await page.locator(".lp-route .lp-stn").allTextContents();
    expect(names.length).toBeGreaterThan(2);
    for (const n of names) expect(n.trim()).toMatch(/^[A-Z]{2,8} \d/);
  });
});

test.describe("under reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the hero route is complete and still, not animating", async ({ page }) => {
    await page.goto("/");
    // Complete: a student who asked for less motion still gets the whole
    // diagram, rather than a line frozen at the first frame of its draw.
    const state = await page.evaluate(() => {
      const line = document.querySelector<SVGPathElement>(".lp-route .route-line")!;
      const stop = document.querySelector<SVGCircleElement>(".lp-route .route-stop")!;
      return {
        offset: getComputedStyle(line).strokeDashoffset,
        stopOpacity: getComputedStyle(stop).opacity,
        lineAnim: getComputedStyle(line).animationName,
      };
    });
    expect(state.stopOpacity, "a station is invisible under reduced motion").toBe("1");
    expect(parseFloat(state.offset), "the route is still part-drawn under reduced motion").toBe(0);
    expect(state.lineAnim, "the draw animation still runs under reduced motion").toBe("none");
  });

  test("nothing on the page transitions", async ({ page }) => {
    await page.goto("/");
    const moving = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        const s = getComputedStyle(el);
        // `<source>` inside the hero video generates no box, so its computed
        // style resolves to empty strings rather than "0s". Named rather than
        // skipping everything that resolves empty, which would quietly exempt
        // any element the browser decided not to render.
        if (el.tagName === "SOURCE") continue;
        if (s.transitionDuration !== "0s" && s.transitionProperty !== "none") {
          bad.push(`${el.tagName.toLowerCase()}.${el.className}: ${s.transitionDuration}`);
        }
      }
      return bad.slice(0, 5);
    });
    expect(moving, `still transitioning:\n  ${moving.join("\n  ")}`).toEqual([]);
  });
});

test.describe("the landing page is usable", () => {
  test("has no mechanically detectable accessibility violations", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await expectNoA11yViolations(page, "the landing page");
  });

  test("the route diagram is described for a screen reader", async ({ page }) => {
    // It carries the page's thesis. An unlabelled svg conveys none of it.
    await page.goto("/");
    const fig = page.getByRole("img", { name: /prerequisite route/i });
    await expect(fig).toBeVisible();
  });

  test("reaches the planner by keyboard, without hunting", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    // First stop is the skip link, and it has to say so.
    const skip = await page.evaluate(() => (document.activeElement as HTMLElement)?.textContent?.trim());
    expect(skip).toMatch(/skip/i);

    // Then the planner, within a couple of stops. It used to be asserted as
    // the literal second stop, which stopped being true the moment the page
    // grew a header -- a brand link before the nav is ordinary, and reordering
    // the header to satisfy a test would be the tail wagging the dog. What
    // matters is that it is right there, not that it is at index 2.
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const href = await page.evaluate(() => (document.activeElement as HTMLAnchorElement)?.getAttribute("href"));
      if (href) seen.push(href);
      if (href === "/plan/") return;
    }
    throw new Error(`the planner is not among the first stops: ${JSON.stringify(seen)}`);
  });
});

test.describe("the coverage figure", () => {
  test("is readable with JavaScript off, like everything else here", async ({ page }) => {
    await page.goto("/");
    const section = page.locator("#coverage");
    await expect(section).toBeVisible();
    await expect(section.locator(".lp-figure strong").first()).toHaveText(/^\d{1,3}%$/);
  });

  test("explains the exclusion rather than burying it", async ({ page }) => {
    await page.goto("/");
    const section = page.locator("#coverage");
    // The exclusion is what makes the rest of the number credible.
    await expect(section).toContainText(/no list/i);
    await expect(section).toContainText(/not failures/i);
    await expect(section).toContainText(/adviser/i);
  });

  test("the figure meets AA against what is behind it", async ({ page }) => {
    // --primary at display size on the page background. The only new coloured
    // element this section introduces, and the one most likely to slip.
    await page.goto("/");
    const ratio = await page.locator(".lp-figure strong").first().evaluate((el) => {
      const lum = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const L = (css: string) => {
        const [r, g, b] = css.match(/\d+/g)!.map(Number);
        return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
      };
      let bg: Element | null = el;
      let bgColor = "";
      while (bg) {
        const c = getComputedStyle(bg).backgroundColor;
        if (c && !/rgba?\([^)]*,\s*0\)/.test(c) && c !== "transparent") { bgColor = c; break; }
        bg = bg.parentElement;
      }
      const a = L(getComputedStyle(el).color);
      const b = L(bgColor || getComputedStyle(document.body).backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio, `the coverage figure measures ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("the legal documents", () => {
  // These are the pages an OAuth reviewer at Google or Microsoft opens to
  // verify the app, and neither reviewer's crawler runs React. They are also
  // the only place a visitor who never opens the planner can read a policy at
  // all, which is why they are documents and not a modal.
  test.use({ javaScriptEnabled: false });

  for (const [path, heading] of [
    ["/privacy/", /privacy policy/i],
    ["/terms/", /terms of use/i],
  ] as const) {
    test(`${path} is a real document with JavaScript off`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status(), `${path} did not serve`).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      // Substance, not just a title: the body has to actually render.
      expect((await page.locator("main").innerText()).length).toBeGreaterThan(600);
      // Reachable in both directions — a reviewer landing on one needs the other.
      await expect(page.getByRole("link", { name: /^privacy$/i })).toBeVisible();
      await expect(page.getByRole("link", { name: /^terms$/i })).toBeVisible();
      await expect(page.getByRole("link", { name: /home/i })).toBeVisible();
    });

  }

  test("the landing page links to both", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /^privacy$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^terms$/i })).toBeVisible();
  });

  test("a data request has a private route, not a public tracker", async ({ page }) => {
    // Filing a deletion request as a GitHub issue means publishing it.
    await page.goto("/privacy/");
    await expect(page.getByRole("link", { name: /ovk5113@psu\.edu/i })).toBeVisible();
  });
});

test.describe("the legal documents, with scripting on", () => {
  // axe injects and runs IN the page, so these cannot live in the block above
  // that turns JavaScript off -- there, the injection simply times out and the
  // failure reads like a violation.
  for (const path of ["/privacy/", "/terms/"] as const) {
    test(`${path} has no accessibility violations`, async ({ page }) => {
      await page.goto(path);
      await expectNoA11yViolations(page);
    });
  }
});

test.describe("connecting an assistant", () => {
  // The page exists because "paste a link into your settings" has to be
  // followable by a student who has never opened a terminal. Everything here
  // is a property of THAT, not of styling.
  test.use({ javaScriptEnabled: false });

  test("reads with JavaScript off", async ({ page }) => {
    const res = await page.goto("/connect/");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/connect your ai/i);
    // The link itself must be plain selectable text, not injected by script:
    // someone setting up a connector is often on a locked-down machine.
    await expect(page.locator("#connector-url")).toContainText(/^https:\/\//);
  });

  test("shows no code anywhere", async ({ page }) => {
    await page.goto("/connect/");
    await expect(page.locator("pre, code"), "the connect page is showing code").toHaveCount(0);
    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const jargon of ["npx", "npm install", "json", "terminal", "command line", "stdio"]) {
      expect(body, `"${jargon}" appears on a page written for non-programmers`).not.toContain(jargon);
    }
  });

  test("is an ordered procedure, because the steps depend on each other", async ({ page }) => {
    await page.goto("/connect/");
    // Sign in BEFORE copying the link: the link is only meaningful once the
    // account exists. An unordered list would lose that.
    const steps = page.locator(".steps > li");
    await expect(steps).toHaveCount(4);
    await expect(steps.first()).toContainText(/sign in/i);
    await expect(steps.nth(1)).toContainText(/copy/i);
  });

  test("says plainly that the connector is not live yet", async ({ page }) => {
    // Shipping a dead link with no warning sends students to paste something
    // that silently fails, and they blame their assistant.
    await page.goto("/connect/");
    await expect(page.getByText(/not live yet/i)).toBeVisible();
  });

  test("is reachable from the landing page and the footer", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /connect your ai/i }).first()).toBeVisible();
  });
});

test.describe("connecting an assistant, with scripting on", () => {
  test("has no accessibility violations", async ({ page }) => {
    await page.goto("/connect/");
    await expectNoA11yViolations(page);
  });

  test("the copy button copies the link", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/connect/");
    await page.getByRole("button", { name: /^copy$/i }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(await page.locator("#connector-url").innerText());
  });
});

test.describe("the page's own controls", () => {
  test("every button is readable against its own fill", async ({ page }) => {
    // A bare `.band-deep a` is two classes and beat `.btn-go`, so the hero's
    // primary button rendered in link blue on its own cream fill. axe did not
    // flag it -- it reads the computed pair and both were "light" rather than
    // identical -- and it is the one control the page most needs read.
    await page.goto("/");
    const bad = await page.evaluate(() => {
      const lum = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const L = (css: string) => {
        const [r, g, b] = css.match(/[\d.]+/g)!.map(Number);
        return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
      };
      /** Walk up for the first ancestor that actually paints a background. */
      const behind = (el: Element): string => {
        for (let n: Element | null = el; n; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (bg && !/rgba?\([^)]*,\s*0\s*\)/.test(bg) && bg !== "transparent") return bg;
        }
        return "rgb(255,255,255)";
      };
      const out: string[] = [];
      for (const el of document.querySelectorAll(".btn")) {
        const fg = L(getComputedStyle(el).color);
        const bg = L(behind(el));
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        if (ratio < 4.5) out.push(`${el.textContent?.trim()}: ${ratio.toFixed(2)}:1`);
      }
      return out;
    });
    expect(bad, "a button's label does not meet AA against its own fill").toEqual([]);
  });
});

test.describe("about and contact", () => {
  test("both sections exist and are linked from somewhere visible", async ({ page }) => {
    // Reachable, not "in the nav": below 34rem the bar keeps only the brand
    // and the primary action, which is ordinary on a phone. The footer links
    // both at every width, so that is where the guarantee lives.
    await page.goto("/");
    for (const id of ["about", "contact"]) {
      await expect(page.locator(`#${id}`), `no #${id} section`).toBeVisible();
      const links = page.locator(`a[href="#${id}"], a[href="/#${id}"]`);
      const visible = await links.evaluateAll((els) =>
        els.filter((e) => (e as HTMLElement).offsetParent !== null).length,
      );
      expect(visible, `nothing visible links to #${id} at this width`).toBeGreaterThan(0);
    }
  });

  test("about says who made it without inventing a company", async ({ page }) => {
    await page.goto("/");
    const about = page.locator("#about");
    await expect(about.getByRole("heading")).toBeVisible();
    // It is one person's side project. Copy implying a team or a company
    // would be the kind of small lie that makes the honest parts read as
    // marketing too.
    const text = (await about.innerText()).toLowerCase();
    expect(text).toMatch(/one person|side project/);
    expect(text, "about claims a team that does not exist").not.toMatch(/\bour team\b|\bwe are a company\b/);
    // The claim a reader can check for themselves.
    await expect(about.getByRole("link", { name: /github|open source/i })).toBeVisible();
  });

  test("contact reaches a human with JavaScript off", async ({ page, context }) => {
    // The form is script-driven. If it were the ONLY route, a student on a
    // locked-down machine would have a bug to report and nowhere to put it.
    await context.route("**/*.js", (r) => r.abort());
    await page.goto("/");
    const contact = page.locator("#contact");
    await expect(contact.locator("a[href^='mailto:']")).toBeVisible();
    await expect(contact.locator("#feedback-form"), "the form shows before it can work").toBeHidden();
  });

  test("the form appears once the script can drive it", async ({ page }) => {
    await page.goto("/");
    const form = page.locator("#feedback-form");
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute("data-enhanced", "true");
    await expect(form.locator("#fb-body")).toBeVisible();
    // Email is optional: feedback that requires identifying yourself is
    // feedback you do not get.
    await expect(form.locator("#fb-email")).not.toHaveAttribute("required", /.*/);
  });

  test("refuses an empty message instead of sending nothing", async ({ page }) => {
    await page.goto("/");
    await page.locator("#feedback-form button[type=submit]").click();
    await expect(page.locator("#feedback-form [data-status]")).toBeVisible();
    await expect(page.locator("#feedback-form")).toHaveAttribute("data-state", "error");
  });

  test("the honeypot is reachable by no one who can see", async ({ page }) => {
    await page.goto("/");
    const trap = page.locator("#fb-website");
    await expect(trap).toHaveCount(1);
    // Off-screen, not display:none — and out of the tab order, so a keyboard
    // user never lands in a field they cannot see.
    await expect(trap).toHaveAttribute("tabindex", "-1");
    await expect(page.locator(".fb-trap")).toHaveAttribute("aria-hidden", "true");
  });

  test("has no accessibility violations", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await expectNoA11yViolations(page, "the landing page with about and contact");
  });
});
