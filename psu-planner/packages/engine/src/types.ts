import type { AstNode } from "./prereq.js";

/** Course record as shipped in the pipeline's courses/{subj}.json bundles. */
export interface Course {
  code: string;
  subject: string;
  number: string;
  display: string;
  title: string;
  credits: string;
  creditsParsed: { min: number; max: number; repeatableMax: number | null } | null;
  description: string;
  enforced: string | null;
  concurrent: string | null;
  prereqAdvisory: string | null;
  prereqAst: AstNode | null;
  concurrentAst: AstNode | null;
  astComplete: boolean;
  genEd: string[];
  attributes: string[];
  crossListings: string[];
  aliases: string[];
  level: "undergraduate" | "graduate";
  url: string;
}

/** Runtime catalog: normalized code -> course (aliases registered as extra keys). */
export type Catalog = Record<string, Course>;

export function buildCatalog(courses: Course[]): Catalog {
  const cat: Catalog = {};
  for (const c of courses) {
    cat[c.code] = c;
    for (const a of c.aliases) if (!cat[a]) cat[a] = c;
  }
  return cat;
}

/** Where a plan item sits in its source suggested-plan template. Recorded at
 * generation and persisted so the optimizer can ANCHOR to the bulletin's own
 * progression instead of re-deriving an order from scratch (the old re-packer
 * produced flowchart-out-of-order plans). `templateSem` is the 0-based
 * semester index in the program's template; for a dual major the two programs
 * share the term-index space (generatePlan merges by term index). */
export interface ItemOrigin {
  program: string;
  templateSem: number;
}

/** A slot is an unfilled requirement card (gen-ed, elective...). */
export interface SlotSpec {
  slot: string; // short label, e.g. "GE", "TE", "GN"
  id: string;
  credits: number | null;
  label?: string;
  /** Program slug whose requirement this slot represents — used to look up
   * the matching rule for suggestions. */
  program?: string;
  origin?: ItemOrigin;
}
export interface CourseSpec {
  code: string;
  /** Other codes that satisfy the same template entry ("CMPSC 121 or 131",
   * CAS 100 family expansion). Swappable in the UI. */
  alternatives?: string[];
  /** Bulletin referenced a code the catalog can't verify — render cautiously. */
  unverified?: boolean;
  origin?: ItemOrigin;
}
export type PlanItemSpec = CourseSpec | SlotSpec;

export interface PlanTerm {
  label: string; // e.g. "Fall 2026"
  items: PlanItemSpec[];
  /** "grad" marks the graduate half of an IUG plan — the optimizer preserves
   * these terms (it re-flows only the undergraduate half) and relabels them to
   * continue the term sequence. Absent = undergraduate. */
  phase?: "grad";
  /** An intentional empty term — a gap semester (e.g. a gap year, co-op, or
   * leave). The optimizer keeps it EMPTY and re-flows coursework around it
   * (everything from this calendar position shifts one term later), and the
   * auto-prune of 0-credit terms leaves it alone. Cleared to un-skip the term. */
  gap?: boolean;
}

/** The user's plan document — the unit of persistence and sync.
 * Mirrors the demo's DATA.plan + state so the ported engine logic maps 1:1. */
export interface PlanDoc {
  id: string;
  rev: number;
  updatedAt: string;
  programs: string[]; // program slugs
  terms: PlanTerm[];
  completed: Record<string, boolean>;
  moves: Record<string, number>; // item id -> term index override
  slotFills: Record<string, string>; // slot id -> course code
  added: { code: string; sem: number }[];
  /** Item ids removed from the plan — hidden from the chart and excluded from
   * credit totals until restored. */
  removed?: Record<string, boolean>;
  /** Full course specs for removed COURSES, keyed by code. Kept so a course can
   * be restored with its `origin` (template position) and alternatives intact
   * even after a re-optimize rebuilds the term list without it — otherwise the
   * spec would be gone and Restore would clear a flag pointing at nothing. */
  removedSpecs?: Record<string, CourseSpec>;
  /** Course codes the student has confirmed a prerequisite OVERRIDE for (they
   * talked to their adviser and were cleared to take it despite the flag).
   * Purely a display attestation — the prereq evaluator stays truthful — but a
   * flagged (warn/bad) card renders as satisfied once its code is listed here. */
  prereqOverrides?: Record<string, boolean>;
  /** Schreyer Honors College membership: which year the student was admitted
   * (1 = entered as a first-year Scholar, 2 = Gateway second-year, 3 = Gateway
   * third-year). Absent/undefined = not a Scholar. Drives the honors-credit
   * audit and honors-section upgrades. */
  honors?: { admit: 1 | 2 | 3 };
  /** Scheduling constraints the student declared ("I can't take AI 100 in
   * Fall 2026"). Unlike manual `moves` (wiped on re-optimize), constraints are
   * DURABLE: every optimizer run honors them, moving the course to its
   * earliest legal feasible term and letting prerequisite dependents shift.
   * A conflict degrades honestly (red edge + note) — never a silent removal. */
  constraints?: ScheduleConstraint[];
  /** Calendar years whose SUMMER SESSION the student wants to use (Summer 2027
   * sits between Spring 2027 and Fall 2027). Year-keyed so the choice survives
   * re-optimization and term-index shifts. Summer terms get a lower credit
   * ceiling and are exempt from the full-time floor. */
  summerYears?: number[];
  /** Attached Integrated Undergraduate-Graduate program (IUG): the student is
   * pursuing the master's alongside this bachelor's. `doubleCounted` are the
   * undergraduate courses applied to both degrees (GCAC-210: ≤15cr / ≤40% of
   * the master's, ≥50% at 500/800). Grad coursework lives in phase:"grad" terms. */
  iug?: { slug: string; track: number; doubleCounted: string[] };
  view: { x: number; y: number; k: number } | null;
}

/** One per-course placement constraint. termIndex is the 0-based plan term
 * (Fall 2026 = 0 for a Fall-2026 start — labels derive from position, so the
 * index is stable across re-optimization). */
export interface ScheduleConstraint {
  code: string;
  /** not-in: never place in termIndex; not-before: termIndex or later only;
   * pin: exactly termIndex. */
  type: "not-in" | "not-before" | "pin";
  termIndex: number;
}

/** Resolved plan item (after applying moves/slotFills/added). */
export interface PlanItem {
  id: string;
  kind: "course" | "slot";
  code?: string;
  slot?: string;
  slotLabel?: string;
  slotProgram?: string;
  credits?: number | null;
  sem: number;
  added?: boolean;
  fromSlot?: string;
  sourcePrograms?: string[];
  alternatives?: string[];
  unverified?: boolean;
}

export interface SchedEntry {
  sem: number;
  completed: boolean;
  item: PlanItem;
}
export type Schedule = Record<string, SchedEntry>;

export const SAT = 2;
export const UNK = 1;
export const UNSAT = 0;
export type EvalValue = typeof SAT | typeof UNK | typeof UNSAT;

export type Leaf =
  | { kind: "phrase"; text: string; v: EvalValue }
  | { kind: "external"; code: string; v: EvalValue }
  | { kind: "inplan"; code: string; sem: number; v: EvalValue; concurrent: boolean };

export interface CheckResult {
  value: EvalValue;
  leaves: Leaf[];
}
