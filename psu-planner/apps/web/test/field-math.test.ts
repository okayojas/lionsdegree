/** The gravity scene's arithmetic (#65): how far down the page, what the
 * spheres are doing there, and where the sample Plan sits.
 *
 * The stage values are the design. They are written out again here, from the
 * ticket, on purpose: a table that is only in the code is a table nobody can
 * tell has moved.
 */
import { describe, it, expect } from "vitest";
import { planGrid, progressAt, scrollYAt, stageAt, type Band, type PageAnchors } from "../src/landing/field-math.js";

describe("how far down the page", () => {
  // The page as the design draws it: each of the first two sections one
  // screen tall, the plan section 1.6 of one.
  const VH = 900;
  const design: PageAnchors = { catalog: VH, plan: 2 * VH, release: 3.6 * VH, viewport: VH };

  it("is the scroll distance in screens when the sections are a screen each", () => {
    for (const p of [0, 0.3, 1, 1.3, 2, 2.6, 3.05, 3.6, 4.2]) {
      expect(progressAt(p * VH, design), `at ${p} screens`).toBeCloseTo(p, 6);
    }
  });

  it("follows the sections when they are taller than a screen", () => {
    // A phone, where the catalog section and its three cards run to a
    // screen and a half. Dividing by the window's height would assemble the
    // Plan (progress 2) while those cards were still on screen.
    const phone: PageAnchors = { catalog: 800, plan: 800 + 1200, release: 800 + 1200 + 1280, viewport: 800 };
    expect(progressAt(800, phone)).toBeCloseTo(1, 6);
    expect(progressAt(2000, phone), "the Plan is assembled as its own section arrives").toBeCloseTo(2, 6);
    expect(progressAt(1600, phone), "two screens down, and still in the catalog").toBeLessThan(1.7);
    expect(progressAt(3280, phone)).toBeCloseTo(3.6, 6);
  });

  it("can be turned round: where to scroll to for a given stage", () => {
    const phone: PageAnchors = { catalog: 800, plan: 2000, release: 3280, viewport: 800 };
    for (const page of [design, phone]) {
      for (const p of [0, 0.5, 1, 1.6, 2, 2.3, 3.6, 4.4]) {
        expect(progressAt(scrollYAt(p, page), page), `there and back from ${p}`).toBeCloseTo(p, 6);
      }
    }
  });

  it("never runs backwards, and starts at nothing", () => {
    const page: PageAnchors = { catalog: 700, plan: 1900, release: 3100, viewport: 700 };
    expect(progressAt(-40, page)).toBe(0);
    let last = -1;
    for (let y = 0; y <= 5000; y += 25) {
      const p = progressAt(y, page);
      expect(p, `at ${y}px`).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });
});

describe("what the spheres are doing", () => {
  it("scrambled at the top, and not by the time the page has moved on", () => {
    expect(stageAt(0).scrambled).toBe(1);
    expect(stageAt(0.3).scrambled).toBe(1);
    expect(stageAt(0.8).scrambled).toBe(0);
    expect(stageAt(0.55).scrambled).toBeCloseTo(0.5, 6);
  });

  it("falls onto a floor between 0.40 and 0.95, and stops being held by it by 1.75", () => {
    expect(stageAt(0.4).falling).toBe(0);
    expect(stageAt(0.95).falling).toBe(1);
    expect(stageAt(1.2).falling).toBe(1);
    expect(stageAt(1.75).falling).toBe(0);
  });

  it("opens the floor past 1.30 and brings it back below 1.22, with a gap between", () => {
    expect(stageAt(1.3).floorOpen).toBe(false);
    expect(stageAt(1.31).floorOpen).toBe(true);
    expect(stageAt(1.22).backToPile).toBe(false);
    expect(stageAt(1.21).backToPile).toBe(true);
    // Between the two, neither: a hand resting on the wheel at the edge does
    // not open and shut the floor.
    expect(stageAt(1.26)).toMatchObject({ floorOpen: false, backToPile: false });
  });

  it("catches the Plan's Courses between 1.40 and 2.05, and lets the others back only until 1.80", () => {
    expect(stageAt(1.4).caught).toBe(0);
    expect(stageAt(2.05).caught).toBe(1);
    expect(stageAt(1.79).othersReturn).toBe(true);
    expect(stageAt(1.8).othersReturn).toBe(false);
  });

  it("holds the rectangle from 2.05 until 2.62, and has let go by 3.05", () => {
    for (const p of [2.05, 2.3, 2.6, 2.62]) expect(stageAt(p).rectangle, `at ${p}`).toBe(1);
    expect(stageAt(2.8).rectangle).toBeGreaterThan(0);
    expect(stageAt(3.05).rectangle).toBe(0);
  });

  it("flies between 2.78 and 3.55", () => {
    expect(stageAt(2.78).flight).toBe(0);
    expect(stageAt(3.55).flight).toBe(1);
    expect(stageAt(3.9).flight).toBe(1);
  });

  it("goes from petrol to sky by 1.05, and from sky to green by 1.95", () => {
    expect(stageAt(0.55)).toMatchObject({ toSky: 0, toGreen: 0 });
    expect(stageAt(1.05)).toMatchObject({ toSky: 1, toGreen: 0 });
    expect(stageAt(1.4).toGreen).toBe(0);
    expect(stageAt(1.95).toGreen).toBe(1);
  });

  it("shows the Term names only while there is a rectangle to name", () => {
    expect(stageAt(1.85).captions).toBe(0);
    expect(stageAt(2.3).captions).toBe(1);
    expect(stageAt(2.85).captions).toBe(0);
  });
});

describe("where the Plan sits", () => {
  // A 1440 by 900 window. The camera sees 7.57 world units top to bottom
  // (the scene's own figure for a 38 degree lens 11 units back).
  const HEIGHT = 7.575;
  const wideView = { width: HEIGHT * 1.6, height: HEIGHT };
  const band: Band = { top: 200, bottom: 820, height: 900 };
  const TERMS = 8, LANES = 6;

  it("is a rectangle on a wide screen: Terms across in order, six down, evenly", () => {
    const grid = planGrid(wideView, band, TERMS, LANES);
    expect(grid.wide).toBe(true);
    for (let term = 0; term < TERMS; term++) {
      for (let lane = 0; lane < LANES; lane++) {
        const here = grid.at(term, lane);
        if (term > 0) {
          const left = grid.at(term - 1, lane);
          expect(here.x - left.x, "Terms are not one cell apart, left to right").toBeCloseTo(grid.cell, 9);
          expect(here.y, "a lane is not one row").toBeCloseTo(left.y, 9);
        }
        if (lane > 0) {
          const above = grid.at(term, lane - 1);
          expect(above.y - here.y, "lanes are not one cell apart, top to bottom").toBeCloseTo(grid.cell, 9);
          expect(here.x, "a Term is not one column").toBeCloseTo(above.x, 9);
        }
      }
    }
    // Centred, and discs that do not touch.
    expect(grid.at(0, 0).x).toBeCloseTo(-grid.at(TERMS - 1, 0).x, 9);
    expect(grid.radius * 2).toBeLessThan(grid.cell);
  });

  it("stays inside the band the page's text leaves free", () => {
    const grid = planGrid(wideView, band, TERMS, LANES);
    const worldY = (px: number) => HEIGHT / 2 - px * (HEIGHT / band.height);
    const top = grid.captionAt(0).y + grid.captionHeight / 2;
    const bottom = grid.at(0, LANES - 1).y - grid.radius;
    expect(top, "the Term names run up into the heading").toBeLessThanOrEqual(worldY(band.top));
    expect(bottom, "the bottom row runs down into the caption").toBeGreaterThanOrEqual(worldY(band.bottom));
    expect(Math.abs(grid.at(TERMS - 1, 0).x) + grid.radius, "the rectangle is wider than the screen").toBeLessThan(wideView.width / 2);
  });

  it("names each Term above its own column", () => {
    const grid = planGrid(wideView, band, TERMS, LANES);
    for (let term = 0; term < TERMS; term++) {
      expect(grid.captionAt(term).x).toBeCloseTo(grid.at(term, 0).x, 9);
      expect(grid.captionAt(term).y).toBeGreaterThan(grid.at(term, 0).y + grid.radius);
    }
  });

  it("runs the Terms down on a tall screen, six across", () => {
    const tall = { width: HEIGHT * 0.46, height: HEIGHT };
    const grid = planGrid(tall, { top: 180, bottom: 780, height: 844 }, TERMS, LANES);
    expect(grid.wide).toBe(false);
    expect(grid.at(1, 0).y, "the second Term is not below the first").toBeLessThan(grid.at(0, 0).y);
    expect(grid.at(1, 0).x).toBeCloseTo(grid.at(0, 0).x, 9);
    expect(grid.at(0, 1).x, "a Term's Courses do not run across").toBeGreaterThan(grid.at(0, 0).x);
    expect(Math.abs(grid.at(0, LANES - 1).x) + grid.radius).toBeLessThan(tall.width / 2);
  });
});
