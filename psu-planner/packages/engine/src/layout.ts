/** Column layout + edge geometry.
 * Port of the demo's layout()/drawEdges() math (L313-428) with rendering
 * removed — returns plain data for a React/SVG view layer. */
import { checkCourse, evalNode } from "./evaluate.js";
import { UNSAT, type Catalog, type CheckResult, type PlanDoc, type PlanItem, type Schedule } from "./types.js";
import { parsePrereqText } from "./prereq.js";

export const LAYOUT = { COLW: 228, GAP: 84, CARDH: 86, VGAP: 15, TOP: 96, LEFT: 50, HDRH: 52 };

export interface Position { x: number; y: number }

/** Where the card in row `row` of column `col` sits in world space.
 *
 * Extracted so the loading skeleton can place its grey stand-ins on the
 * identical grid. The skeleton is drawn before the catalog arrives, from
 * the saved plan's term and item COUNTS alone, and the whole point of it is
 * that nothing moves when the real cards replace it — which only holds if
 * both ask the same function where a card goes. */
export function cardSlot(col: number, row: number): Position {
  const { COLW, GAP, CARDH, VGAP, TOP, LEFT, HDRH } = LAYOUT;
  return { x: LEFT + col * (COLW + GAP), y: TOP + HDRH + row * (CARDH + VGAP) };
}

export function layoutColumns(
  items: PlanItem[],
  numTerms: number,
  orderKey: (it: PlanItem) => number,
): { positions: Record<string, Position>; byCol: PlanItem[][] } {
  const positions: Record<string, Position> = {};
  const byCol: PlanItem[][] = Array.from({ length: numTerms }, () => []);
  items.forEach((it) => byCol[Math.max(0, Math.min(numTerms - 1, it.sem))].push(it));
  byCol.forEach((col, ci) => {
    col.sort((a, b) => orderKey(a) - orderKey(b));
    col.forEach((it, ri) => {
      positions[it.id] = cardSlot(ci, ri);
    });
  });
  return { positions, byCol };
}

/** Default ordering: slots sink to the bottom of their column. */
export function defaultOrderKey(it: PlanItem): number {
  if (it.kind === "slot") return 1000;
  return 500;
}

export interface Edge {
  from: string; // item id
  to: string; // item id
  bad: boolean;
  concurrent: boolean;
  d: string; // SVG path
}

export function computeEdges(
  items: PlanItem[],
  sched: Schedule,
  catalog: Catalog,
  positions: Record<string, Position>,
): Edge[] {
  const { COLW, CARDH } = LAYOUT;
  const seen = new Set<string>();
  const edges: Edge[] = [];
  items.forEach((it) => {
    if (it.kind !== "course" || !it.code) return;
    const c = catalog[it.code];
    if (!c) return;
    (
      [
        [c.prereqAst ?? (c.enforced ? parsePrereqText(c.enforced) : null), false],
        [c.concurrentAst ?? (c.concurrent ? parsePrereqText(c.concurrent) : null), true],
      ] as const
    ).forEach(([ast, conc]) => {
      if (!ast) return;
      const leaves: CheckResult["leaves"] = [];
      evalNode(ast, sched, it.sem, conc, leaves);
      leaves.forEach((l) => {
        if (l.kind !== "inplan") return;
        const src = sched[l.code].item;
        const key = src.id + ">" + it.id + conc;
        if (seen.has(key) || src.id === it.id) return;
        seen.add(key);
        const p1 = positions[src.id];
        const p2 = positions[it.id];
        if (!p1 || !p2) return;
        const bad = l.v === UNSAT;
        let d: string;
        if (p1.x === p2.x) {
          const x = p1.x, y1 = p1.y + CARDH / 2, y2 = p2.y + CARDH / 2;
          d = `M ${x} ${y1} C ${x - 46} ${y1}, ${x - 46} ${y2}, ${x} ${y2}`;
        } else {
          const sx = p1.x + COLW, sy = p1.y + CARDH / 2, tx = p2.x, ty = p2.y + CARDH / 2;
          const mx = (sx + tx) / 2;
          d = `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`;
        }
        edges.push({ from: src.id, to: it.id, bad, concurrent: conc, d });
      });
    });
  });
  return edges;
}

/** Card status for coloring, same thresholds as the demo. */
export function cardStatus(catalog: Catalog, it: PlanItem, sched: Schedule): "ok" | "warn" | "bad" | "none" {
  if (it.kind !== "course" || !it.code) return "none";
  const chk = checkCourse(catalog, it.code, it.sem, sched);
  return chk.value === 2 ? "ok" : chk.value === 1 ? "warn" : "bad";
}

/** Drop-to-column snap (demo L490-492). */
export function columnFromX(x: number, numTerms: number): number {
  const { COLW, GAP, LEFT } = LAYOUT;
  const ci = Math.round((x + COLW / 2 - LEFT - COLW / 2) / (COLW + GAP));
  return Math.max(0, Math.min(numTerms - 1, ci));
}

/** Fit-to-view transform (demo L451-457). */
export function fitView(worldW: number, worldH: number, vpW: number, vpH: number): { x: number; y: number; k: number } {
  const k = Math.min(vpW / worldW, (vpH - 70) / worldH, 1.15);
  return { x: (vpW - worldW * k) / 2, y: 64, k };
}

export function worldSize(numTerms: number, positions: Record<string, Position>): { w: number; h: number } {
  const { COLW, GAP, LEFT, CARDH } = LAYOUT;
  const w = LEFT + numTerms * (COLW + GAP) + 200;
  let maxY = 0;
  Object.values(positions).forEach((p) => (maxY = Math.max(maxY, p.y + CARDH)));
  return { w, h: maxY + 220 };
}

/** How far the chart may be zoomed, shared by the wheel and the slider.
 *
 * These were literals inside the canvas component's wheel handler. A slider
 * is a second caller that has to agree exactly: one whose maximum is below
 * the wheel's maximum is a control that visibly stops short of where the
 * gesture can already go, and the student cannot tell whether that is the
 * limit or a bug. */
export const ZOOM = { MIN: 0.25, MAX: 2.2 } as const;

/** Slack in world pixels at each edge of the pannable range, so a card on
 * the outer edge of the plan is not flush against the frame. */
export const PAN_MARGIN = 80;

export interface PanBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The range the view offset may take at a given zoom.
 *
 * `d = vp - world * k` is the offset at which the far edge sits flush with
 * the far side of the viewport. When the scaled world overflows, `d` is
 * negative and the range runs from it up to 0 (flush-left). When it fits,
 * `d` is positive and the range runs from 0 up to it — the student can still
 * slide a small chart around rather than finding the control dead at exactly
 * the zoom level where the whole plan is readable. `min`/`max` of the two
 * covers both without a branch, and keeps the range ordered either way,
 * which is what stops the slider inverting as you cross the fit point. */
export function panBounds(
  worldW: number,
  worldH: number,
  vpW: number,
  vpH: number,
  k: number,
  margin: number = PAN_MARGIN,
): PanBounds {
  const dx = vpW - worldW * k;
  const dy = vpH - worldH * k;
  return {
    minX: Math.min(0, dx) - margin,
    maxX: Math.max(0, dx) + margin,
    minY: Math.min(0, dy) - margin,
    maxY: Math.max(0, dy) + margin,
  };
}

/** Bring a view back inside the limits.
 *
 * Zoom is clamped FIRST and the position is then clamped against the
 * clamped zoom: the bounds are a function of `k`, so using the incoming one
 * computes limits for a zoom level the view will never be at.
 *
 * A zero-sized viewport is a real input — `getBoundingClientRect` reports
 * 0x0 before first layout — and has to come back finite, because this
 * result is persisted into the saved plan. A NaN written there is a chart
 * that never renders again, on every future visit. */
export function clampView(
  v: { x: number; y: number; k: number },
  worldW: number,
  worldH: number,
  vpW: number,
  vpH: number,
): { x: number; y: number; k: number } {
  const k = Math.min(ZOOM.MAX, Math.max(ZOOM.MIN, Number.isFinite(v.k) ? v.k : 1));
  const b = panBounds(worldW, worldH, vpW, vpH, k);
  const fit = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
  return { x: fit(v.x, b.minX, b.maxX), y: fit(v.y, b.minY, b.maxY), k };
}

/** Where a value sits on its track, as 0..1.
 *
 * Returns the midpoint for an empty range rather than NaN. `min === max` is
 * reachable (a world exactly as wide as its viewport, at zero margin), and
 * NaN reaching a slider's `value` makes React drop the input back to
 * uncontrolled — the handle then jumps wherever the browser last left it. */
export function sliderFraction(value: number, min: number, max: number): number {
  if (!(max > min)) return 0.5;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** The inverse of `sliderFraction`. */
export function fromFraction(fraction: number, min: number, max: number): number {
  if (!(max > min)) return min;
  return min + Math.min(1, Math.max(0, fraction)) * (max - min);
}

/** How far through the plan the viewport is looking, as 0..1.
 *
 * This is what the pan sliders are actually expressed in, and it runs
 * OPPOSITE to the view offset: the offset is at its maximum when the
 * viewport is at the start of the plan, because a positive offset pushes
 * the world to the right. A slider wired straight to the offset scrolls
 * away from its own handle — the one behaviour a scrollbar must never have,
 * and one that looks completely correct in a screenshot.
 *
 * Naming it after what the student sees, rather than after the transform,
 * is what keeps the direction right at both call sites. */
export function viewportFraction(offset: number, min: number, max: number): number {
  if (!(max > min)) return 0.5;
  return 1 - sliderFraction(offset, min, max);
}

/** The inverse of `viewportFraction`. */
export function offsetForFraction(fraction: number, min: number, max: number): number {
  return fromFraction(1 - fraction, min, max);
}
