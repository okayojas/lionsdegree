/** The front door (#14).
 *
 * This page's job is to survive being shared. A student sends the link to a
 * group chat, and what arrives is a preview card rendered by something that
 * does not run JavaScript, followed — if they tap it — by a page that has to
 * load fast on a phone on campus wifi. Everything here is about that path.
 */
import { test, expect, expectNoA11yViolations } from "./fixtures.js";

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

  test("every section of the page is there", async ({ page }) => {
    await page.goto("/");
    for (const heading of [/Pick your programs/i, /see what breaks/i, /Bring your own AI/i, /What it can.t do/i]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
  });

  test("the way into the planner works", async ({ page }) => {
    await page.goto("/");
    const cta = page.getByRole("link", { name: /Open the planner/i }).first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/plan/");
  });

  test("the install snippet is readable, not a placeholder", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".lp-snippet")).toContainText("lionsdegree-mcp");
    await expect(page.locator(".lp-snippet")).toContainText("--plan");
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
    await expectNoA11yViolations(page, "the landing page");
  });

  test("the route diagram is described for a screen reader", async ({ page }) => {
    // It carries the page's thesis. An unlabelled svg conveys none of it.
    await page.goto("/");
    const fig = page.getByRole("img", { name: /prerequisite route/i });
    await expect(fig).toBeVisible();
  });

  test("reaches the planner by keyboard", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    // First stop is the skip link, and it has to say so.
    const skip = await page.evaluate(() => (document.activeElement as HTMLElement)?.textContent?.trim());
    expect(skip).toMatch(/skip/i);

    await page.keyboard.press("Tab");
    // Second stop is the primary action. An earlier version accepted any of
    // three hrefs including the skip link's own target, so it could not fail.
    const href = await page.evaluate(() => (document.activeElement as HTMLAnchorElement)?.getAttribute("href"));
    expect(href, "the planner is not the first action a keyboard user reaches").toBe("/plan/");
  });
});
