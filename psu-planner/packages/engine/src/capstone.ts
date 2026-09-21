/** Data-driven capstone detection and dual-major resolution.
 *
 * Capstones (senior design / thesis / culminating project) must land in the
 * FINAL semesters, and a multi-semester sequence (ESC 409 -> 410H -> 411) must
 * stay contiguous at the end. Semester-standing prerequisites ("senior
 * standing") are UNK free-text phrases the evaluator can't enforce, so
 * position anchoring is the only lever we have — hence detection here feeds the
 * optimizer's end-anchor.
 *
 * Detection uses three independent signals (any sufficient, combined stronger):
 *   1. title regex (senior design/project/thesis/capstone/culminating);
 *   2. final-template-year position (from the mined capstone.meanStartFrac);
 *   3. prereq-chained same-subject sequences that terminate in the final year.
 *
 * For a dual major with two capstone sequences we keep the LONGEST (tie: most
 * credits) and mark the other program's capstone removed-but-restorable — the
 * user's rule (ESC's 3-semester capstone kept over AIE 489W). */
import { astCourses, parsePrereqText, type AstNode } from "./prereq.js";
import type { Catalog, PlanDoc, PlanItemSpec } from "./types.js";
import type { FlowchartPatterns } from "./flowchartPatterns.js";

const CAPSTONE_TITLE = /\b(capstone|culminating|thesis|senior\s+(design|research|project|thesis)|(design|research)\s+project|project\s+design)\b/i;

export interface CapstoneSequence {
  program: string;
  /** Course codes in prereq order, earliest-first. */
  codes: string[];
  totalCredits: number;
  /** At least one course matched the capstone title regex. */
  titled: boolean;
}

interface CourseNode {
  code: string;
  program: string;
  templateSem: number;
  credits: number;
  title: string;
}

function astOf(catalog: Catalog, code: string, field: "prereqAst" | "concurrentAst"): AstNode | null {
  const c = catalog[code];
  if (!c) return null;
  if (c[field]) return c[field];
  const raw = field === "prereqAst" ? c.enforced : c.concurrent;
  return raw ? parsePrereqText(raw) : null;
}

/** Same-subject in-plan prerequisites of `code` (direct predecessors). */
function subjectPrereqs(code: string, nodes: Map<string, CourseNode>, catalog: Catalog): string[] {
  const subject = code.split(" ")[0];
  const out: string[] = [];
  for (const field of ["prereqAst", "concurrentAst"] as const) {
    const ast = astOf(catalog, code, field);
    if (!ast) continue;
    for (const dep of astCourses(ast)) {
      const canonical = catalog[dep]?.code ?? dep;
      if (canonical === code) continue;
      if (canonical.split(" ")[0] !== subject) continue;
      if (nodes.has(canonical) && !out.includes(canonical)) out.push(canonical);
    }
  }
  return out;
}

/** Detect one best capstone sequence per program present in the plan. */
export function detectCapstones(plan: PlanDoc, catalog: Catalog, patterns: FlowchartPatterns): CapstoneSequence[] {
  const removed = plan.removed ?? {};
  const nodes = new Map<string, CourseNode>();
  let maxSem = 0;
  for (const t of plan.terms) {
    for (const it of t.items) {
      if ("slot" in it || removed[it.code] || plan.completed[it.code]) continue;
      const c = catalog[it.code];
      const sem = it.origin?.templateSem ?? 0;
      maxSem = Math.max(maxSem, sem);
      nodes.set(catalog[it.code]?.code ?? it.code, {
        code: catalog[it.code]?.code ?? it.code,
        program: it.origin?.program ?? "",
        templateSem: sem,
        credits: c?.creditsParsed?.min ?? 3,
        title: c?.title ?? "",
      });
    }
  }
  if (!nodes.size) return [];

  // Final window: the last `maxSeqLen` template semesters (at least the final
  // year), scaled by the mined capstone.meanStartFrac. A capstone must live
  // here — a mid-plan senior course does not qualify no matter its title.
  const byFrac = Math.floor(patterns.capstone.meanStartFrac * maxSem);
  const windowStart = Math.max(0, Math.min(maxSem - 1, Math.min(byFrac, maxSem - (patterns.capstone.maxSeqLen - 1))));
  const inWindow = (code: string) => (nodes.get(code)?.templateSem ?? -1) >= windowStart;

  // A sequence is SEEDED by a titled course in the window (title is required —
  // "senior standing" position alone gives too many false positives, e.g. a
  // regular 400-level course chained to another). From each seed we grow the
  // connected same-subject component (prereq edges, either direction) whose
  // members are all in the window — this captures ESC 409 -> 410H -> 411 whether
  // the titled member is the first or the last of the chain.
  const undirectedAdj = new Map<string, Set<string>>();
  for (const n of nodes.values()) {
    if (!inWindow(n.code)) continue;
    for (const pred of subjectPrereqs(n.code, nodes, catalog)) {
      if (!inWindow(pred)) continue;
      (undirectedAdj.get(n.code) ?? undirectedAdj.set(n.code, new Set()).get(n.code)!).add(pred);
      (undirectedAdj.get(pred) ?? undirectedAdj.set(pred, new Set()).get(pred)!).add(n.code);
    }
  }

  const best = new Map<string, CapstoneSequence>();
  const claimed = new Set<string>();
  for (const seed of nodes.values()) {
    if (!inWindow(seed.code) || !CAPSTONE_TITLE.test(seed.title) || claimed.has(seed.code)) continue;
    // BFS the same-subject component.
    const comp = new Set<string>([seed.code]);
    const queue = [seed.code];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of undirectedAdj.get(cur) ?? []) {
        if (!comp.has(nb)) { comp.add(nb); queue.push(nb); }
      }
    }
    for (const c of comp) claimed.add(c);
    const seq = [...comp].sort((a, b) => (nodes.get(a)!.templateSem - nodes.get(b)!.templateSem) || a.localeCompare(b));
    const totalCredits = seq.reduce((s, c) => s + (nodes.get(c)?.credits ?? 0), 0);
    const candidate: CapstoneSequence = { program: seed.program, codes: seq, totalCredits, titled: true };
    const prev = best.get(seed.program);
    if (!prev || candidate.codes.length > prev.codes.length ||
        (candidate.codes.length === prev.codes.length && candidate.totalCredits > prev.totalCredits)) {
      best.set(seed.program, candidate);
    }
  }
  return [...best.values()];
}

export interface CapstoneResolution {
  /** The single capstone sequence to keep and anchor to the final semesters. */
  keep: CapstoneSequence | null;
  /** Course codes to move to `removed` (restorable) — losing programs' capstones. */
  drop: string[];
  /** Human-readable note for the adviser-verification toast, or null. */
  note: string | null;
}

/** Dual-major rule: keep the longest sequence (tie: most credits); the other
 * program's capstone becomes removed-but-restorable. */
export function resolveDualCapstones(sequences: CapstoneSequence[]): CapstoneResolution {
  if (!sequences.length) return { keep: null, drop: [], note: null };
  const sorted = [...sequences].sort(
    (a, b) => b.codes.length - a.codes.length || b.totalCredits - a.totalCredits,
  );
  const keep = sorted[0];
  const losers = sorted.slice(1);
  const drop = losers.flatMap((s) => s.codes);
  const note = drop.length
    ? `Your programs each define a capstone. We kept ${keep.program}'s ${keep.codes.length}-course sequence (${keep.codes.join(" → ")}) and set aside ${drop.join(", ")} — restore it if your adviser wants both.`
    : null;
  return { keep, drop, note };
}
