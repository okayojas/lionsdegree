/** The launch gate for phone width (#15).
 *
 * Promoting this around campus means most first visits are mobile, so a
 * planner that only works on a laptop is a planner most people bounce off.
 *
 * These run under every project, not just the phone one: the desktop runs are
 * what catch a mobile fix that quietly damages the desktop layout, which is
 * the usual way this work goes wrong. Assertions that only make sense at one
 * width check the viewport first rather than being pinned to a project name.
 */
import { test, expect, expectNoA11yViolations } from "./fixtures.js";
import type { Page } from "@playwright/test";

/** Phones in the wild go narrower than the 412px Pixel 7 profile. 320px is
 * the floor the industry settled on (iPhone SE, and the narrowest Android
 * still in use); if it survives that it survives the rest. */
// 560 covers the band between a phone and the 760px breakpoint -- small
// tablets and half-screen windows, where the phone rules still apply but the
// layout is much wider than anything else here was checked at.
const WIDTHS = [320, 375, 412, 560];

/** The width single-viewport assertions use. Named so the assertions and the
 * setViewportSize call cannot drift: `375` was typed nine times. */
const PHONE = WIDTHS[1];

/** How far the document can be scrolled sideways. Anything above a rounding
 * wobble means something is forcing the page wider than the screen. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(d.scrollWidth - d.clientWidth, document.body.scrollWidth - d.clientWidth);
  });
}

/** The widest element sticking out past the viewport, named well enough to
 * fix without re-running anything locally. A bare "the page scrolls
 * sideways" tells you nothing about which of four hundred nodes did it. */
async function widestOffender(page: Page): Promise<string> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    let worst = "";
    let by = 0;
    /** getBoundingClientRect reports an element's LAYOUT box and ignores
     * clipping, so a pan/zoom canvas that is correctly clipped by an
     * `overflow: hidden` ancestor still reports a huge width. Reporting it
     * as the offender sent me looking at the wrong element entirely. */
    const isClipped = (el: HTMLElement): boolean => {
      let n = el.parentElement;
      while (n && n !== document.body) {
        const o = getComputedStyle(n).overflowX;
        if (o === "hidden" || o === "clip" || o === "auto" || o === "scroll") return true;
        n = n.parentElement;
      }
      return false;
    };
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (isClipped(el)) continue;
      const over = Math.round(r.right - vw);
      if (over > by) {
        by = over;
        const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).join(".")}` : "";
        worst = `${el.tagName.toLowerCase()}${cls} overflows by ${over}px (right edge ${Math.round(r.right)}, viewport ${vw})`;
      }
    }
    return worst || "no single element overflows; check a container's min-width";
  });
}

test.describe("the page never scrolls sideways", () => {
  for (const width of WIDTHS) {
    test(`at ${width}px, with the plan loaded`, async ({ planner }) => {
      await planner.setViewportSize({ width, height: 760 });
      const over = await horizontalOverflow(planner);
      expect(over, await widestOffender(planner)).toBeLessThanOrEqual(1);
    });

    test(`at ${width}px, in the list view`, async ({ planner }) => {
      await planner.setViewportSize({ width, height: 760 });
      await planner.getByRole("button", { name: /List view/i }).click();
      await expect(planner.getByRole("region", { name: /list view/i })).toBeVisible();
      const over = await horizontalOverflow(planner);
      expect(over, await widestOffender(planner)).toBeLessThanOrEqual(1);
    });

    test(`at ${width}px, during onboarding`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await page.goto("/plan/");
      await expect(page.getByText(/Chart your degree/i)).toBeVisible({ timeout: 30_000 });
      const over = await horizontalOverflow(page);
      expect(over, await widestOffender(page)).toBeLessThanOrEqual(1);
    });

    test(`at ${width}px, on the landing page`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await page.goto("/");
      const over = await horizontalOverflow(page);
      expect(over, await widestOffender(page)).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("wide content scrolls inside its own container", () => {
  test("the flowchart canvas contains its own width", async ({ planner }) => {
    // The canvas is intrinsically wide -- it lays terms out in columns -- and
    // it is the one thing here that genuinely cannot fit. It is a PAN/ZOOM
    // surface rather than a scroll container: `.world` is moved by a
    // transform inside `.viewport`, so the right assertion is that the
    // viewport CLIPS rather than that it scrolls. Either way the document
    // must not inherit the width.
    await planner.setViewportSize({ width: PHONE, height: 760 });
    const state = await planner.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".viewport");
      if (!el) return null;
      const s = getComputedStyle(el);
      return { overflow: s.overflow, overflowX: s.overflowX, width: el.getBoundingClientRect().width };
    });
    expect(state, "no .viewport found to check").not.toBeNull();
    expect(["hidden", "clip", "auto", "scroll"]).toContain(state!.overflowX);
    expect(state!.width, "the canvas viewport is wider than the screen").toBeLessThanOrEqual(PHONE + 1);
    expect(await horizontalOverflow(planner)).toBeLessThanOrEqual(1);
  });
});

test.describe("controls are comfortably tappable", () => {
  /** Read from `--tap-min` rather than re-typed. keyboard.spec.ts set the
   * precedent by importing FOCUSABLE from the hook it tests: a constant
   * copied into the spec means the test agrees with a COPY of the
   * implementation, so moving the real one does not fail anything. */
  const tapMin = (page: Page) =>
    page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tap-min")) || 44,
    );

  /** Skip where there is no thumb. 44px is about what a finger can hit; a
   * mouse is precise and a 39px control is perfectly usable with one. The
   * rule that enforces this is keyed off `pointer: coarse`, so the test has
   * to be too -- pinning it to a viewport WIDTH would demand touch sizing of
   * a narrow window on a laptop, which is a different (and wrong) claim. */
  async function isTouch(page: Page): Promise<boolean> {
    return page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
  }

  /** EXACTLY the selector the stylesheet sizes, so the test asserts the rule
   * that exists rather than one it wishes existed. Inline links in prose and
   * checkboxes/radios are deliberately outside it: giving a link inside a
   * sentence a 44px height would wreck the paragraph around it. */
  const TAPPABLE =
    'button, select, textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), .skip-link';

  async function tooSmall(page: Page, min: number): Promise<string[]> {
    return page.evaluate(({ min, sel }) => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        // Inside the pan/zoom canvas, rendered size is a function of the zoom
        // level rather than of CSS -- a control measures 7px at low zoom and
        // no stylesheet rule can change that. The canvas is a map; the list
        // view is where the same operations are offered at full size.
        if (el.closest(".world")) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // An element can be smaller than its tappable area if padding is on a
        // parent; measure what a thumb actually lands on.
        if (r.height < min - 0.5) {
          const name = (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 40);
          bad.push(`"${name}" is ${Math.round(r.height)}px tall`);
        }
      }
      return bad;
    }, { min, sel: TAPPABLE });
  }

  test("in the toolbar and the plan", async ({ planner }) => {
    await planner.setViewportSize({ width: PHONE, height: 760 });
    test.skip(!(await isTouch(planner)), "no touch pointer in this project");
    const min = await tapMin(planner);
    const bad = await tooSmall(planner, min);
    expect(bad, `controls under ${min}px tall:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  test("in the list view, where every row carries three", async ({ planner }) => {
    await planner.setViewportSize({ width: PHONE, height: 760 });
    test.skip(!(await isTouch(planner)), "no touch pointer in this project");
    await planner.getByRole("button", { name: /List view/i }).click();
    await expect(planner.getByRole("region", { name: /list view/i })).toBeVisible();
    const min = await tapMin(planner);
    const bad = await tooSmall(planner, min);
    expect(bad, `controls under ${min}px tall:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  test("in a modal, where the chat composer lives", async ({ planner }) => {
    // The composer is a <textarea>, which neither the stylesheet rule nor an
    // earlier version of this test covered -- it measured 34px. Nothing had
    // ever run a tap check with a dialog open either.
    await planner.setViewportSize({ width: PHONE, height: 760 });
    test.skip(!(await isTouch(planner)), "no touch pointer in this project");
    await planner.getByRole("button", { name: /List view/i }).click();
    await planner.getByRole("button", { name: /^Details for/i }).first().click();
    await expect(planner.getByRole("dialog")).toBeVisible();
    // Wait for the entrance transition to settle. The modal scales in from
    // 0.95, and measuring mid-animation reported every 44px control as 42px
    // (44 x 0.95) -- a failure that looks exactly like a real sizing bug.
    await planner.waitForFunction(() => {
      const m = getComputedStyle(document.querySelector('[role="dialog"]')!).transform;
      return m === "none" || /^matrix\(1,\s*0,\s*0,\s*1,/.test(m);
    });
    const min = await tapMin(planner);
    const bad = await tooSmall(planner, min);
    expect(bad, `controls under ${min}px tall with a dialog open:\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});

test.describe("modals are usable on a phone", () => {
  test("a modal fits the screen and scrolls its own content", async ({ planner }) => {
    await planner.setViewportSize({ width: PHONE, height: 760 });
    await planner.getByRole("button", { name: /List view/i }).click();
    await planner.getByRole("button", { name: /^Details for/i }).first().click();
    const dlg = planner.getByRole("dialog");
    await expect(dlg).toBeVisible();

    const box = (await dlg.boundingBox())!;
    expect(box.width, "the modal is wider than the screen").toBeLessThanOrEqual(PHONE + 1);
    expect(box.x, "the modal starts off the left edge").toBeGreaterThanOrEqual(-1);
    // A modal taller than the viewport must scroll inside itself; a student
    // cannot reach a Close button that sits below the fold of a fixed overlay.
    const fits = await planner.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[role="dialog"]')!;
      const s = getComputedStyle(el);
      return el.getBoundingClientRect().height <= window.innerHeight || ["auto", "scroll"].includes(s.overflowY);
    });
    expect(fits, "a modal taller than the screen cannot be scrolled").toBe(true);
    expect(await horizontalOverflow(planner)).toBeLessThanOrEqual(1);
  });

  test("its close control is reachable without scrolling the page", async ({ planner }) => {
    await planner.setViewportSize({ width: PHONE, height: 760 });
    await planner.getByRole("button", { name: /List view/i }).click();
    await planner.getByRole("button", { name: /^Details for/i }).first().click();
    await expect(planner.getByRole("dialog")).toBeVisible();
    // Escape is the keyboard route and is covered elsewhere; this is about a
    // thumb. The control has to be ON SCREEN.
    // The modal is capped at 88vh on a phone (82vh elsewhere) and scrolls its
    // own content, so Close
    // legitimately starts below the fold. What must be true is that reaching
    // it scrolls the MODAL and not the page -- a fixed overlay whose content
    // is only reachable by scrolling the document behind it is the broken
    // case this guards.
    const close = planner.getByRole("dialog").getByRole("button", { name: /^(Close|Cancel)$/i }).first();
    const pageYBefore = await planner.evaluate(() => window.scrollY);
    await close.scrollIntoViewIfNeeded();
    await expect(close).toBeInViewport();
    expect(await planner.evaluate(() => window.scrollY), "reaching Close scrolled the page, not the modal")
      .toBe(pageYBefore);
  });
});

test.describe("the advisor panel on a phone", () => {
  test("does not take the screen from the plan", async ({ planner }) => {
    // On desktop the panel is a resizable column beside the plan. At phone
    // width there is no room for two columns, so a fixed 360px panel leaves
    // the plan a sliver -- or pushes it off-screen entirely.
    await planner.setViewportSize({ width: PHONE, height: 760 });
    const panel = planner.locator(".sidepanel, .chat-panel").first();
    if (!(await panel.count())) return; // panel is config-gated (#7)
    if (!(await panel.isVisible())) return;
    const box = await panel.boundingBox();
    if (!box) return;
    expect(box.width, "the advisor panel is wider than the screen").toBeLessThanOrEqual(PHONE + 1);
    expect(await horizontalOverflow(planner)).toBeLessThanOrEqual(1);
  });

  test("gets no more of the screen than the plan does", async ({ planner }) => {
    // Width alone was not the whole story. The panel stacked correctly and
    // still took 357px of a 760px screen while the plan got 163px -- it
    // passed every width assertion while being, in practice, a chat app with
    // a plan attached.
    await planner.setViewportSize({ width: PHONE, height: 760 });
    const share = await planner.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".sidepanel");
      const plan = document.querySelector<HTMLElement>(".main-row > .viewport, .main-row > .listview");
      if (!panel || !plan) return null;
      return {
        panel: Math.round(panel.getBoundingClientRect().height),
        plan: Math.round(plan.getBoundingClientRect().height),
      };
    });
    if (!share) return; // panel is config-gated (#7)
    expect(share.plan, `plan ${share.plan}px vs advisor panel ${share.panel}px`)
      .toBeGreaterThanOrEqual(share.panel);
  });
});

test.describe("the plan is readable at phone width", () => {
  test("no text is rendered below the minimum legible size", async ({ planner }) => {
    await planner.setViewportSize({ width: PHONE, height: 760 });
    await planner.getByRole("button", { name: /List view/i }).click();
    await expect(planner.getByRole("region", { name: /list view/i })).toBeVisible();
    const tiny = await planner.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(".listview *")) {
        if (!el.textContent?.trim() || el.children.length) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        // 11px is the floor; the palette's --fs-xs is 11.5px by design.
        if (size < 11) bad.push(`${el.className || el.tagName}: ${size}px`);
      }
      return bad;
    });
    expect(tiny, `text below 11px:\n  ${tiny.join("\n  ")}`).toEqual([]);
  });

  test("has no accessibility violations at phone width", async ({ planner }) => {
    await planner.setViewportSize({ width: PHONE, height: 760 });
    await planner.getByRole("button", { name: /List view/i }).click();
    await expect(planner.getByRole("region", { name: /list view/i })).toBeVisible();
    await expectNoA11yViolations(planner, `the list view at ${PHONE}px`);
  });
});

test.describe("the desktop layout is unchanged", () => {
  test("the toolbar does not grow taller at desktop width", async ({ planner }) => {
    // The guard on this ticket: a mobile fix that stacks the toolbar
    // everywhere would be a regression dressed as a fix.
    //
    // TWO rows, not one. Measured before any of this ticket's changes: at
    // 1280px the toolbar is already 107px tall, because the search box,
    // legend, progress bar and four controls do not fit on one line. That is
    // pre-existing and out of scope here; what must not happen is it getting
    // WORSE.
    await planner.setViewportSize({ width: 1280, height: 900 });
    const rows = await planner.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".toolbar")!;
      // Cluster by vertical CENTRE, not by top. The toolbar centres items of
      // different heights, so their tops legitimately differ by a dozen
      // pixels on a single row -- counting distinct tops reported six rows
      // for a toolbar that had not wrapped at all.
      const centres: number[] = [];
      for (const el of bar.children) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (!r.height) continue;
        const c = r.top + r.height / 2;
        if (!centres.some((x) => Math.abs(x - c) < 12)) centres.push(c);
      }
      return centres.length;
    });
    expect(rows, "the toolbar gained a row at 1280px").toBeLessThanOrEqual(2);
  });

  test("the canvas and the advisor panel sit side by side at desktop width", async ({ planner }) => {
    await planner.setViewportSize({ width: 1280, height: 900 });
    const sideBySide = await planner.evaluate(() => {
      // `.viewport`, not `#main`: #main is the flex CONTAINER that holds
      // both, so comparing its edges against its own child said nothing.
      const panel = document.querySelector<HTMLElement>(".sidepanel");
      const view = document.querySelector<HTMLElement>(".viewport, .listview");
      if (!panel || !view) return null;
      const p = panel.getBoundingClientRect();
      const m = view.getBoundingClientRect();
      return p.left >= m.right - 2 || m.left >= p.right - 2;
    });
    if (sideBySide === null) return; // panel config-gated
    expect(sideBySide, "the advisor panel stacked below the plan on desktop").toBe(true);
  });
});
