/** Integrated Undergraduate-Graduate (IUG) attach: fold a scraped master's
 * program onto an undergraduate PlanDoc as graduate-phase terms, applying
 * GCAC-210 double-counting.
 *
 * Rules (docs/iug-programs.md, verified against the graduate bulletin):
 *   - Double-count up to `doubleCount.maxCredits` (program cap, ≤ the
 *     university 15cr / 40% ceiling), ≥50% of double-counted courses at the
 *     500/800 level; a course already in the undergrad plan that is on the
 *     program's `eligible` list counts toward BOTH degrees and is NOT
 *     re-scheduled — that is the whole point of an IUG.
 *   - The remaining required graduate courses + electives + culminating
 *     experience become new phase:"grad" terms AFTER the undergraduate plan.
 *
 * The optimizer preserves phase:"grad" terms (it re-flows only the undergrad
 * half), so attaching is a pure append + double-count computation; the source
 * IugSpec is deterministic scraped data (iron rule 1). */
import type { Catalog, CourseSpec, PlanDoc, PlanItemSpec, PlanTerm, SlotSpec } from "./types.js";

/** Shape of data/out/<edition>/iug/{slug}.json (see scripts/scrapeIug.ts). */
export interface IugSpec {
  slug: string;
  name: string;
  gradDegree: string;
  college: string;
  campus: string;
  pairsWith: string[];
  sourceUrl: string;
  totalGradCredits: number | null;
  doubleCount: { maxCredits: number; minHalfAt500Level: boolean; eligible: string[] };
  applyText: string | null;
  gradTracks: { sections: IugReqSection[]; totalCredits: number | null }[];
}
export interface IugReqSection {
  heading: string;
  kind: string;
  creditsRequired: number | null;
  rules: IugRule[];
}
export type IugRule =
  | { type: "course"; code: string; credits: number | null }
  | { type: "oneOf"; options: string[]; credits: number | null }
  | { type: "chooseN"; n: number; options: string[]; credits: number | null }
  | { type: "selectCredits"; credits: number | null; from: { kind: "courses"; courses: string[] } | { kind: string } | null; commentRaw?: string }
  | { type: "unstructured"; commentRaw: string };

const is500or800 = (code: string): boolean => {
  const n = parseInt(code.split(" ")[1] ?? "0", 10);
  return (n >= 500 && n < 600) || (n >= 800 && n < 900);
};
const gradCredits = (catalog: Catalog, code: string, fallback: number): number =>
  catalog[code]?.creditsParsed?.min ?? fallback;

/** Choose the master's track: the smallest positive totalCredits (the leanest
 * standard M.S./M.B.A. option, not an 81-credit doctoral block that shares the
 * page), unless the caller pins one. */
export function pickTrack(spec: IugSpec, pinned?: number): number {
  if (pinned != null && spec.gradTracks[pinned]) return pinned;
  let best = 0;
  let bestCr = Infinity;
  spec.gradTracks.forEach((t, i) => {
    const cr = t.totalCredits ?? Infinity;
    if (cr < bestCr) { bestCr = cr; best = i; }
  });
  return best;
}

export interface AttachResult {
  doubleCounted: string[];
  gradTermsAdded: number;
  note: string;
}

/** Attach the IUG to `plan` (mutates): compute double-counting from courses
 * already in the plan, then append the remaining graduate requirements as
 * phase:"grad" terms. Idempotent — a re-attach first strips prior grad terms. */
export function attachIug(plan: PlanDoc, spec: IugSpec, gradCatalog: Catalog, opts: { track?: number } = {}): AttachResult {
  detachIug(plan); // clear any prior grad terms so re-attach is clean
  const track = pickTrack(spec, opts.track);
  const sections = spec.gradTracks[track]?.sections ?? [];

  // Courses the student already has (undergrad plan + completed) that are
  // double-count-eligible, prioritizing 500/800-level to honor the ≥50% rule.
  const inPlan = new Set<string>();
  for (const t of plan.terms) for (const it of t.items) if (!("slot" in it)) inPlan.add(it.code);
  for (const c of Object.keys(plan.completed)) if (plan.completed[c]) inPlan.add(c);
  const eligiblePresent = spec.doubleCount.eligible.filter((c) => inPlan.has(c));
  eligiblePresent.sort((a, b) => Number(is500or800(b)) - Number(is500or800(a)));
  const doubleCounted: string[] = [];
  let dcCredits = 0;
  for (const code of eligiblePresent) {
    const cr = gradCredits(gradCatalog, code, 3);
    if (dcCredits + cr > spec.doubleCount.maxCredits) continue;
    doubleCounted.push(code);
    dcCredits += cr;
  }
  const dcSet = new Set(doubleCounted);

  // Flatten the track's requirements into concrete grad courses + elective
  // slots. Double-counted courses are skipped (already satisfied by undergrad).
  const gradCourses: CourseSpec[] = [];
  const gradSlots: SlotSpec[] = [];
  const culminating: CourseSpec[] = [];
  let slotSeq = 0;
  const addCourse = (code: string, into: CourseSpec[]) => {
    if (dcSet.has(code) || inPlan.has(code)) return;
    into.push({ code, origin: { program: spec.slug, templateSem: 100 } });
  };

  for (const sec of sections) {
    const culmi = /culminating|thesis|capstone/i.test(sec.heading);
    for (const rule of sec.rules) {
      if (rule.type === "course") addCourse(rule.code, culmi ? culminating : gradCourses);
      else if (rule.type === "oneOf") { if (rule.options[0]) addCourse(rule.options[0], culmi ? culminating : gradCourses); }
      else if (rule.type === "chooseN") {
        for (let i = 0; i < rule.n && i < rule.options.length; i++) addCourse(rule.options[i], culmi ? culminating : gradCourses);
      } else if (rule.type === "selectCredits" && rule.credits) {
        const n = Math.max(1, Math.ceil(rule.credits / 3));
        for (let i = 0; i < n; i++) {
          gradSlots.push({ slot: "GR", id: `GR-${spec.slug}-${slotSeq++}`, credits: 3, label: `${sec.heading} (${spec.gradDegree})`, program: spec.slug, origin: { program: spec.slug, templateSem: 100 } });
        }
      }
    }
  }

  // Pack the grad requirements into ~15-credit graduate terms (grad full-time
  // is ~9-12, but IUG students carry heavier loads; cap at 15). Culminating
  // experience goes last, in its own term.
  const gradItems: PlanItemSpec[] = [...gradCourses, ...gradSlots];
  const gradTerms: PlanTerm[] = [];
  let cur: PlanItemSpec[] = [];
  let curCr = 0;
  const cap = 15;
  for (const it of gradItems) {
    const cr = "slot" in it ? (Number(it.credits) || 3) : gradCredits(gradCatalog, it.code, 3);
    if (curCr + cr > cap && cur.length) { gradTerms.push({ label: "", items: cur, phase: "grad" }); cur = []; curCr = 0; }
    cur.push(it);
    curCr += cr;
  }
  if (cur.length) gradTerms.push({ label: "", items: cur, phase: "grad" });
  if (culminating.length) gradTerms.push({ label: "", items: culminating, phase: "grad" });
  if (!gradTerms.length) gradTerms.push({ label: "", items: [], phase: "grad" });

  plan.terms.push(...gradTerms);
  plan.iug = { slug: spec.slug, track, doubleCounted };
  relabelTerms(plan);

  const note = `Attached ${spec.gradDegree}: ${gradTerms.length} graduate term(s) after your bachelor's` +
    (doubleCounted.length ? `, double-counting ${dcCredits} credits (${doubleCounted.join(", ")}) toward both degrees` : "") +
    `. Verify the plan of study with the ${spec.college} graduate adviser.`;
  return { doubleCounted, gradTermsAdded: gradTerms.length, note };
}

/** Remove the graduate half, returning the plan to a plain bachelor's. */
export function detachIug(plan: PlanDoc): void {
  plan.terms = plan.terms.filter((t) => t.phase !== "grad");
  delete plan.iug;
  relabelTerms(plan);
}

/** Relabel every term through the Fall/Spring/Summer sequence (grad terms just
 * continue it). Mirrors the optimizer's relabel so labels stay consistent. */
function relabelTerms(plan: PlanDoc): void {
  const m = /(Fall|Spring|Summer)\s+(20\d{2})/.exec(plan.terms[0]?.label ?? "");
  let term: "Fall" | "Spring" | "Summer" = (m?.[1] as "Fall" | "Spring" | "Summer") ?? "Fall";
  let year = m ? parseInt(m[2], 10) : new Date().getFullYear();
  const summers = new Set(plan.summerYears ?? []);
  for (const t of plan.terms) {
    t.label = `${term} ${year}`;
    if (term === "Fall") { term = "Spring"; year += 1; }
    else if (term === "Spring") term = summers.has(year) ? "Summer" : "Fall";
    else term = "Fall";
  }
}

export interface IugAudit {
  attached: boolean;
  gradDegree: string;
  track: number;
  totalGradCredits: number | null;
  doubleCounted: string[];
  doubleCountCredits: number;
  maxDoubleCount: number;
  gradCoursesPlanned: string[];
  notes: string[];
}

export function auditIug(plan: PlanDoc, spec: IugSpec | null, gradCatalog: Catalog): IugAudit | null {
  if (!plan.iug || !spec) return null;
  const gradCoursesPlanned: string[] = [];
  for (const t of plan.terms) if (t.phase === "grad") for (const it of t.items) if (!("slot" in it)) gradCoursesPlanned.push(it.code);
  const dcCredits = plan.iug.doubleCounted.reduce((s, c) => s + gradCredits(gradCatalog, c, 3), 0);
  const notes: string[] = [];
  const half = Math.ceil(plan.iug.doubleCounted.length / 2);
  const at500 = plan.iug.doubleCounted.filter(is500or800).length;
  if (plan.iug.doubleCounted.length && at500 < half) {
    notes.push("At least half of double-counted courses must be 500/800-level (GCAC-210) — verify with your adviser.");
  }
  notes.push("IUG admission: apply after entrance to major + 60 credits, no later than the second week of the semester before your bachelor's is conferred (GCAC-210).");
  return {
    attached: true,
    gradDegree: spec.gradDegree,
    track: plan.iug.track,
    totalGradCredits: spec.gradTracks[plan.iug.track]?.totalCredits ?? spec.totalGradCredits,
    doubleCounted: plan.iug.doubleCounted,
    doubleCountCredits: dcCredits,
    maxDoubleCount: spec.doubleCount.maxCredits,
    gradCoursesPlanned,
    notes,
  };
}
