/** The chart's pan, zoom and "Connect your AI" controls, and the two
 * loading states that cover the waits around them.
 *
 * These are all things that only exist in a browser: a slider that scrolls
 * the wrong way, an overlay that never paints because the thread is busy,
 * a skeleton whose grid does not match the real one. None of it can be
 * checked from a unit test, which is why the arithmetic underneath was
 * moved into the engine (packages/engine/test/view-controls.test.ts) and
 * only the wiring is asserted here.
 */
import { test, expect, SEEDED_PLAN } from "./fixtures.js";

/** The transform the chart is currently rendered at. */
async function worldTransform(page: import("@playwright/test").Page): Promise<string> {
  return (await page.locator(".world").first().getAttribute("style")) ?? "";
}

/** Nudge a range input by keyboard. Dragging a slider by pixels is the
 * flakiest thing in a browser suite; arrow keys exercise the same change
 * handler and are what a keyboard user does anyway. */
async function nudge(slider: import("@playwright/test").Locator, key: string, times = 12) {
  await slider.focus();
  for (let i = 0; i < times; i++) await slider.press(key);
}

test.describe("the chart's view controls", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ([k, p]) => window.localStorage.setItem(k as string, p as string),
      ["psu-planner-plan-v1", JSON.stringify(SEEDED_PLAN)] as const,
    );
    await page.goto("/plan/");
    await page.locator(".card").first().waitFor({ timeout: 60_000 });
  });

  test("pans the chart across", async ({ page }) => {
    const slider = page.locator(".vc-pan-x");
    test.skip(!(await slider.isVisible()), "the pan tracks are hidden at phone width");
    const before = await worldTransform(page);
    await nudge(slider, "ArrowRight");
    await expect
      .poll(() => worldTransform(page), { message: "the pan slider did not move the chart" })
      .not.toBe(before);
  });

  test("moves the chart the way the handle moves", async ({ page }) => {
    // The failure this catches is a control that scrolls AWAY from its own
    // handle, which is invisible in a screenshot and completely disorienting
    // in use. Right on the track must mean later terms, which means the
    // world translating LEFT -- a smaller x.
    const slider = page.locator(".vc-pan-x");
    test.skip(!(await slider.isVisible()), "the pan tracks are hidden at phone width");
    const xOf = async () => Number(/translate\((-?[\d.]+)px/.exec(await worldTransform(page))?.[1] ?? 0);
    await nudge(slider, "End", 1);
    const atEnd = await xOf();
    await nudge(slider, "Home", 1);
    const atStart = await xOf();
    expect(atEnd, "sliding right did not move the viewport towards the later terms").toBeLessThan(atStart);
  });

  test("zooms in and out, and fits back", async ({ page }) => {
    const zoom = page.locator(".vc-zoom-range");
    test.skip(!(await zoom.isVisible()), "the zoom slider is hidden at phone width");
    const kOf = async () => Number(/scale\(([\d.]+)\)/.exec(await worldTransform(page))?.[1] ?? 0);
    const start = await kOf();

    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(kOf, { message: "Zoom in did not change the scale" }).toBeGreaterThan(start);

    await page.getByRole("button", { name: "Fit the whole plan on screen" }).click();
    // Fit must land somewhere the whole plan is visible, which is a scale at
    // or below where we started -- not merely "a different number".
    await expect.poll(kOf).toBeLessThanOrEqual(start + 0.01);
  });

  test("survives being zoomed all the way in and all the way out", async ({ page }) => {
    // The view is persisted to the saved plan, so an unclamped value here is
    // not a bad frame -- it is a chart that never renders again on this
    // device. Both ends, then confirm the cards are still there.
    const zoom = page.locator(".vc-zoom-range");
    test.skip(!(await zoom.isVisible()), "the zoom slider is hidden at phone width");
    await nudge(zoom, "End", 1);
    await nudge(zoom, "Home", 1);
    await nudge(zoom, "End", 1);
    const k = Number(/scale\(([\d.]+)\)/.exec(await worldTransform(page))?.[1] ?? 0);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThanOrEqual(2.2);
    await expect(page.locator(".card").first()).toBeVisible();
  });

  test("offers a way to connect an assistant, from the chart", async ({ page }) => {
    const cta = page.locator(".vc-connect");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/connect/");
  });

  test("grabbing a control does not drag the chart", async ({ page }) => {
    // The controls sit on top of the canvas, and the canvas starts a pan on
    // any pointerdown that is not a card. Without stopPropagation, taking
    // hold of a slider also grabs the chart and it slides out from under
    // the gesture.
    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    test.skip(!(await zoomIn.isVisible()), "controls hidden at this width");
    const before = await worldTransform(page);
    await zoomIn.hover();
    await page.mouse.down();
    await page.mouse.move(400, 400);
    await page.mouse.up();
    // The scale may change from the click; the TRANSLATION must not have
    // followed the pointer across the screen.
    const x = (t: string) => Number(/translate\((-?[\d.]+)px/.exec(t)?.[1] ?? 0);
    expect(Math.abs(x(await worldTransform(page)) - x(before))).toBeLessThan(40);
  });
});

test.describe("the menu", () => {
  test("is in the same corner on the planner as on every other page", async ({ page }) => {
    // Not a style assertion -- a consistency one. The landing page, the
    // planner and the three static pages all put the menu at the TRAILING
    // edge; which edge matters far less than it never moving between them.
    await page.addInitScript(
      ([k, p]) => window.localStorage.setItem(k as string, p as string),
      ["psu-planner-plan-v1", JSON.stringify(SEEDED_PLAN)] as const,
    );
    await page.goto("/plan/");
    await page.locator(".card").first().waitFor({ timeout: 60_000 });

    const menu = page.getByRole("button", { name: /^Menu/ });
    await expect(menu).toBeVisible();
    const bar = await page.locator(".toolbar").boundingBox();
    const box = await menu.boundingBox();
    const fromRight = bar!.x + bar!.width - (box!.x + box!.width);
    expect(fromRight, "the menu is not at the trailing edge of the toolbar").toBeLessThan(80);

    await menu.click();
    const panel = page.locator(".toolbar-menu");
    await expect(panel).toBeVisible();
    // Anchored left under a trailing-edge button, the panel would hang off
    // the side of the screen and most of it would be unreachable.
    const pb = await panel.boundingBox();
    expect(pb!.x, "the menu panel is off the left of the screen").toBeGreaterThanOrEqual(-1);
    expect(pb!.x + pb!.width, "the menu panel runs off the right of the screen")
      .toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  });

  test("is reachable on a page that ships no JavaScript", async ({ page }) => {
    await page.goto("/privacy/");
    const menu = page.locator(".pagemenu summary");
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.locator(".pagemenu-panel a", { hasText: "Home" })).toBeVisible();
    await expect(page.locator(".pagemenu-panel a[href='/connect/']")).toBeVisible();
  });
});
