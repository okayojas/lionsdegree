/** Column layout + edge geometry.
 * Port of the demo's layout()/drawEdges() math (L313-428) with rendering
 * removed — returns plain data for a React/SVG view layer. */
import { checkCourse, evalNode } from "./evaluate.js";
import { UNSAT, type Catalog, type CheckResult, type PlanDoc, type PlanItem, type Schedule } from "./types.js";
import { parsePrereqText } from "./prereq.js";

export const LAYOUT = { COLW: 228, GAP: 84, CARDH: 86, VGAP: 15, TOP: 96, LEFT: 50, HDRH: 52 };

export interface Position { x: number; y: number }

export function layoutColumns(
  items: PlanItem[],
  numTerms: number,
  orderKey: (it: PlanItem) => number,
): { positions: Record<string, Position>; byCol: PlanItem[][] } {
  const { COLW, GAP, CARDH, VGAP, TOP, LEFT, HDRH } = LAYOUT;
  const positions: Record<string, Position> = {};
  const byCol: PlanItem[][] = Array.from({ length: numTerms }, () => []);
  items.forEach((it) => byCol[Math.max(0, Math.min(numTerms - 1, it.sem))].push(it));
  byCol.forEach((col, ci) => {
    col.sort((a, b) => orderKey(a) - orderKey(b));
    col.forEach((it, ri) => {
      positions[it.id] = { x: LEFT + ci * (COLW + GAP), y: TOP + HDRH + ri * (CARDH + VGAP) };
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
