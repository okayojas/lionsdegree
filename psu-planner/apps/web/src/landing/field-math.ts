/** The arithmetic of the gravity scene, with no renderer in it.
 *
 * Three questions the scene asks every frame, each answerable from numbers
 * alone: how far down the page are we, what does that mean the spheres are
 * doing, and where does each Course of the sample Plan belong. They are here,
 * apart from the scene (scene.ts), so the unit suite can ask them without a
 * canvas, and so the values that ARE the design (#60, #65) sit in one place
 * and can be read against the ticket.
 *
 * No imports. Three.js stays in the scene's chunk; this is a few hundred
 * bytes and the scene's tests read it too.
 */

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
/** 0 below `a`, 1 above `b`, and eased between. */
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* ── How far down the page ──────────────────────────────────────────────── */

/** Where the page's four sections start, in pixels from the top of the
 * document, and how tall the window is. */
export interface PageAnchors {
  /** Top of the catalog section, the plan section and the last section. */
  catalog: number;
  plan: number;
  release: number;
  viewport: number;
}

/** What `progress` is at the top of each section. With the sections exactly
 * as tall as the design draws them (one screen, one screen, 1.6 screens) this
 * is simply the scroll distance in screens, which is how #65 states it. */
const AT = { catalog: 1, plan: 2, release: 3.6 } as const;

/** Scroll position as `progress`: 0 scrambled, 1 fallen, 2 assembled, 3.6 gone.
 *
 * MEASURED FROM THE SECTIONS, not from the scroll offset alone. The prototype
 * divides the offset by the window's height, which assumes each section is
 * exactly one screen tall. On a phone the catalog section, with its three
 * cards, is taller than that: the Plan would be assembled while the cards
 * were still on screen, and gone before its own heading arrived. So the
 * stages are pinned to where the sections actually are, and between them the
 * progress is a straight line. On a screen the design fits, the two agree. */
export function progressAt(scrollY: number, page: PageAnchors): number {
  const stops: [at: number, progress: number][] = [
    [0, 0],
    [page.catalog, AT.catalog],
    [page.plan, AT.plan],
    [page.release, AT.release],
  ];
  if (scrollY <= 0) return 0;
  for (let i = 1; i < stops.length; i++) {
    const [y0, p0] = stops[i - 1];
    const [y1, p1] = stops[i];
    if (scrollY <= y1) return y1 > y0 ? lerp(p0, p1, (scrollY - y0) / (y1 - y0)) : p1;
  }
  // Past the last section: a screen is a unit again.
  return AT.release + (scrollY - page.release) / Math.max(1, page.viewport);
}

/* ── What the spheres are doing ─────────────────────────────────────────── */

/** Everything the scene derives from `progress`. The numbers are the
 * prototype's and are the design; #65 lists them. */
export interface Stage {
  /** Scrambled: the cluster drifts and is held together. */
  scrambled: number;
  /** Falling: gravity on, the floor still there. */
  falling: number;
  /** The floor has gone. Everything falls off the bottom and comes back in
   * from the top. */
  floorOpen: boolean;
  /** Scrolled back above the sieve: the floor returns. */
  backToPile: boolean;
  /** How firmly a Plan Course that has come back in is caught: 0 it falls
   * like the rest, 1 it is held over its cell. */
  caught: number;
  /** How much of a rectangle there is: `caught`, until the flight lets go. */
  rectangle: number;
  /** While true, a Course that is NOT in the Plan comes back in from the
   * top after falling out. Afterwards it does not come back. */
  othersReturn: boolean;
  /** The flight: the Plan lifts off and goes past the camera. */
  flight: number;
  /** Petrol to sky, then sky to green. */
  toSky: number;
  toGreen: number;
  /** The Term names, which arrive with the rectangle and leave with it. */
  captions: number;
}

export function stageAt(progress: number): Stage {
  const caught = smoothstep(1.4, 2.05, progress);
  return {
    scrambled: 1 - smoothstep(0.3, 0.8, progress),
    falling: smoothstep(0.4, 0.95, progress) * (1 - smoothstep(1.25, 1.75, progress)),
    floorOpen: progress > 1.3,
    backToPile: progress < 1.22,
    caught,
    // The plan section is pinned for an extra 0.6 of a screen, so the
    // rectangle holds from 2.05 to 2.6 before it lets go.
    rectangle: caught * (1 - smoothstep(2.62, 3.05, progress)),
    othersReturn: progress < 1.8,
    flight: smoothstep(2.78, 3.55, progress),
    toSky: smoothstep(0.55, 1.05, progress),
    toGreen: smoothstep(1.4, 1.95, progress),
    captions: smoothstep(1.85, 2.1, progress) * (1 - smoothstep(2.62, 2.85, progress)),
  };
}

/* ── Where the Plan sits ────────────────────────────────────────────────── */

/** The free band inside the pinned plan section, in pixels from its top:
 * below the heading, above the caption. `height` is the section's own. */
export interface Band {
  top: number;
  bottom: number;
  height: number;
}

/** The rectangle, in the scene's world units (the camera looks at the origin
 * and `height` world units fill the screen from top to bottom). */
export interface PlanGrid {
  /** Terms run left to right. On a tall screen they run top to bottom. */
  wide: boolean;
  /** The distance between neighbouring cells. */
  cell: number;
  /** The radius every Course takes once it is in its cell. */
  radius: number;
  /** The centre of the cell for a Term and a lane (a Course's place within
   * its Term). */
  at(term: number, lane: number): { x: number; y: number };
  /** Where a Term's name goes: above its column. Only on a wide screen. */
  captionAt(term: number): { x: number; y: number };
  /** The height of a Term's name. */
  captionHeight: number;
}

/** Lays the sample Plan out in the space the page's own text leaves free.
 *
 * MEASURED, NOT ASSUMED: the heading above the rectangle is sized in pixels
 * and the scene in world units, so a fixed fraction of the screen is right at
 * one window size only. The band comes from the layout. */
export function planGrid(view: { width: number; height: number }, band: Band, terms: number, lanes: number): PlanGrid {
  const wide = view.width / view.height >= 1.2;
  const across = wide ? terms : lanes;
  const down = wide ? lanes : terms;
  // The Term names above the grid, in cells. On a tall screen there are none.
  const headroom = wide ? 0.95 : 0.2;

  const perPx = view.height / Math.max(1, band.height);
  const bandTop = view.height / 2 - (band.top + 10) * perPx;
  const bandBottom = view.height / 2 - (band.bottom - 16) * perPx;
  const availW = view.width * 0.9;
  const availH = Math.max(view.height * 0.3, bandTop - bandBottom);
  // The block is the grid plus its captions; a disc overhangs its cell's
  // centre by a radius at the bottom and the names by a little at the top.
  const rows = down - 1 + headroom + 0.56;
  const cell = Math.min(availW / across, availH / rows);
  const centerY = (bandTop + bandBottom) / 2;
  const top = centerY + (rows * cell) / 2 - (headroom + 0.19) * cell; // y of the first row
  const left = -((across - 1) * cell) / 2;

  return {
    wide,
    cell,
    radius: cell * 0.365,
    at: (term, lane) =>
      wide ? { x: left + term * cell, y: top - lane * cell } : { x: left + lane * cell, y: top - term * cell },
    captionAt: (term) => ({ x: left + term * cell, y: top + cell * 0.74 }),
    captionHeight: cell * 0.2,
  };
}
