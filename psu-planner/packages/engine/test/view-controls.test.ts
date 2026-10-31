/** The arithmetic behind the chart's pan and zoom controls.
 *
 * WHY THIS IS IN THE ENGINE. Pan and zoom already existed as drag and wheel
 * gestures, with the limits written inline in the canvas component: `0.25`
 * and `2.2` appeared as literals inside the wheel handler and nowhere else.
 * Adding sliders means a second caller has to agree with those limits
 * exactly, and a slider whose maximum is not the wheel's maximum is a
 * control that visibly stops short of where the gesture can already go.
 *
 * So the limits and the mapping move here, where they can be stated once and
 * tested without a browser. The component keeps the gestures; it no longer
 * keeps the numbers.
 */
import { describe, it, expect } from "vitest";
import {
  ZOOM, LAYOUT, cardSlot, clampView, layoutColumns, panBounds, sliderFraction, fromFraction,
  viewportFraction, offsetForFraction,
} from "../src/layout.js";

// A world wider and taller than the viewport looking at it — the ordinary
// case, where there is genuinely somewhere to pan to.
const WORLD = { w: 3000, h: 1600 };
const VP = { w: 1200, h: 700 };

describe("panBounds", () => {
  it("lets the far edge of an oversized world reach the frame", () => {
    // At k=1 the world is 3000 wide inside a 1200 viewport, so x must be able
    // to reach -1800 for the right-hand edge to become visible at all. A
    // slider that cannot reach it leaves part of the plan unreachable.
    const b = panBounds(WORLD.w, WORLD.h, VP.w, VP.h, 1, 0);
    expect(b.minX).toBe(1200 - 3000);
    expect(b.maxX).toBe(0);
  });

  it("widens as you zoom out and narrows as you zoom in", () => {
    const out = panBounds(WORLD.w, WORLD.h, VP.w, VP.h, 0.5, 0);
    const inn = panBounds(WORLD.w, WORLD.h, VP.w, VP.h, 2, 0);
    expect(out.maxX - out.minX).toBeLessThan(inn.maxX - inn.minX);
  });

  it("still offers a range when the whole world fits", () => {
    // 3000 * 0.25 = 750, inside a 1200 viewport. There is no content
    // off-screen, but the student can still slide it from flush-left to
    // flush-right, and the range stays ordered so the slider does not
    // invert. Collapsing to a point here would make the control look
    // broken at the zoom level where the chart is most readable.
    const b = panBounds(WORLD.w, WORLD.h, VP.w, VP.h, 0.25, 0);
    expect(b.minX).toBe(0);
    expect(b.maxX).toBe(1200 - 750);
    expect(b.maxX).toBeGreaterThan(b.minX);
  });

  it("adds slack on both sides so an edge card is not jammed against the frame", () => {
    const tight = panBounds(WORLD.w, WORLD.h, VP.w, VP.h, 1, 0);
    const slack = panBounds(WORLD.w, WORLD.h, VP.w, VP.h, 1, 80);
    expect(slack.minX).toBe(tight.minX - 80);
    expect(slack.maxX).toBe(tight.maxX + 80);
  });
});

describe("clampView", () => {
  it("holds zoom inside the range the wheel already uses", () => {
    expect(clampView({ x: 0, y: 0, k: 99 }, WORLD.w, WORLD.h, VP.w, VP.h).k).toBe(ZOOM.MAX);
    expect(clampView({ x: 0, y: 0, k: 0.001 }, WORLD.w, WORLD.h, VP.w, VP.h).k).toBe(ZOOM.MIN);
  });

  it("pulls a view that has been dragged off into space back to the content", () => {
    // Dragging far enough used to leave the chart as an empty grey field with
    // no way back except reloading.
    const v = clampView({ x: 99999, y: -99999, k: 1 }, WORLD.w, WORLD.h, VP.w, VP.h);
    const b = panBounds(WORLD.w, WORLD.h, VP.w, VP.h, 1);
    expect(v.x).toBe(b.maxX);
    expect(v.y).toBe(b.minY);
  });

  it("leaves a view that is already in range alone", () => {
    const v = { x: -400, y: -120, k: 1 };
    expect(clampView(v, WORLD.w, WORLD.h, VP.w, VP.h)).toEqual(v);
  });

  it("clamps position against the CLAMPED zoom, not the one it was handed", () => {
    // Order matters. Bounds depend on k, so clamping x against an
    // out-of-range k computes the limits for a zoom level the view is never
    // going to be at, and the result lands outside the real bounds.
    const v = clampView({ x: -99999, y: 0, k: 99 }, WORLD.w, WORLD.h, VP.w, VP.h);
    expect(v.x).toBe(panBounds(WORLD.w, WORLD.h, VP.w, VP.h, ZOOM.MAX).minX);
  });

  it("survives a viewport with no size", () => {
    // Happens on the first render, before layout: getBoundingClientRect
    // reports 0x0. The result has to stay finite or it is written straight
    // into the saved plan as NaN and the chart never renders again.
    const v = clampView({ x: 10, y: 10, k: 1 }, WORLD.w, WORLD.h, 0, 0);
    expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.k)).toBe(true);
  });
});

describe("viewport fraction", () => {
  // The sliders are expressed as "how far through the plan am I looking",
  // not "what is the world's offset". Those run in OPPOSITE directions: the
  // offset is largest when the viewport is at the start, because a positive
  // offset pushes the world right. Getting this backwards gives a control
  // that scrolls away from the handle, which is the single most confusing
  // thing a scrollbar can do — and it is invisible in a screenshot, so it
  // belongs in a test rather than in a review.
  const B = panBounds(WORLD.w, WORLD.h, VP.w, VP.h, 1);

  it("reads 0 when the viewport is at the start of the plan", () => {
    expect(viewportFraction(B.maxX, B.minX, B.maxX)).toBe(0);
  });

  it("reads 1 when the viewport is at the end of the plan", () => {
    expect(viewportFraction(B.minX, B.minX, B.maxX)).toBe(1);
  });

  it("moves the viewport forward as the fraction grows", () => {
    const near = offsetForFraction(0.1, B.minX, B.maxX);
    const far = offsetForFraction(0.9, B.minX, B.maxX);
    expect(far).toBeLessThan(near);
  });

  it("round-trips", () => {
    const off = offsetForFraction(0.37, B.minX, B.maxX);
    expect(viewportFraction(off, B.minX, B.maxX)).toBeCloseTo(0.37);
  });

  it("centres when there is nowhere to go", () => {
    expect(viewportFraction(5, 5, 5)).toBe(0.5);
  });
});

describe("slider mapping", () => {
  it("round-trips a value through its fraction", () => {
    expect(fromFraction(sliderFraction(-900, -1800, 0), -1800, 0)).toBeCloseTo(-900);
  });

  it("puts the two ends at 0 and 1", () => {
    expect(sliderFraction(-1800, -1800, 0)).toBe(0);
    expect(sliderFraction(0, -1800, 0)).toBe(1);
  });

  it("centres the handle when there is nowhere to pan", () => {
    // min === max is a real state: a world exactly as wide as its viewport.
    // The lerp divides by the range, so this is the NaN that would otherwise
    // reach a slider's `value` and make React drop it back to uncontrolled.
    expect(sliderFraction(5, 5, 5)).toBe(0.5);
    expect(fromFraction(0.3, 5, 5)).toBe(5);
  });

  it("does not run off the end of the track", () => {
    expect(sliderFraction(500, -1800, 0)).toBe(1);
    expect(sliderFraction(-5000, -1800, 0)).toBe(0);
  });
});

describe("cardSlot", () => {
  it("agrees with the real layout for every card", () => {
    // The guarantee the loading skeleton rests on. The skeleton places grey
    // stand-ins from the saved plan's counts alone, before any catalog has
    // loaded; if its grid differs from the real one by even a row, every
    // card visibly jumps the moment the plan resolves — which is worse than
    // showing nothing, because the page looks like it mis-rendered.
    const items = [
      { id: "a", sem: 0, kind: "course" as const, code: "MATH 140" },
      { id: "b", sem: 0, kind: "course" as const, code: "CMPSC 131" },
      { id: "c", sem: 2, kind: "course" as const, code: "PHYS 211" },
    ];
    const { positions, byCol } = layoutColumns(items as never, 3, () => 500);
    byCol.forEach((col, ci) =>
      col.forEach((it, ri) => {
        expect(positions[(it as { id: string }).id]).toEqual(cardSlot(ci, ri));
      }),
    );
  });

  it("steps by a full column across and a full row down", () => {
    const a = cardSlot(0, 0);
    expect(cardSlot(1, 0).x - a.x).toBe(LAYOUT.COLW + LAYOUT.GAP);
    expect(cardSlot(0, 1).y - a.y).toBe(LAYOUT.CARDH + LAYOUT.VGAP);
  });
});
