/** Where can this course legally go?
 *
 * The question a student asks by dragging. `repairPrereqOrdering` answers the
 * generation-time version — "my prerequisite is scheduled too late, pull it
 * earlier" — which is the wrong move here: the student just placed THIS
 * course, so it is the one that should move, and its prerequisites may have
 * prerequisites of their own that make pulling them back illegal.
 *
 * Tested against the real catalog, because every significant defect in this
 * project came from real bulletin data rather than invented fixtures.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildCatalog,
  buildItems,
  buildSchedule,
  checkCourse,
  earliestLegalTerm,
  SAT,
  type Catalog,
  type Course,
  type PlanDoc,
} from "../src/index.js";
import { CATALOG_DIR } from "./edition.js";

const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, rel), "utf-8"));
const subjects = load("subjects_index.json") as Record<string, string>;
/** Only the subjects these tests name, plus their prerequisite subjects. */
const catalog: Catalog = buildCatalog(
  ["MATH", "PHYS", "CMPSC"].flatMap((pf) => (subjects[pf] ? (load(subjects[pf]) as Course[]) : [])),
);

/** A plan with one course per term, in the order given. */
function planOf(codes: (string | null)[]): PlanDoc {
  return {
    rev: 1,
    programs: [],
    terms: codes.map((code, i) => ({
      label: `Term ${i + 1}`,
      items: code ? [{ type: "course" as const, code }] : [],
    })),
    moves: {},
    completed: {},
    constraints: [],
    slotFills: {},
    removed: {},
    added: [],
  } as unknown as PlanDoc;
}

const resolve = (plan: PlanDoc) => {
  const items = buildItems(plan, catalog);
  return { items, sched: buildSchedule(plan, items, catalog) };
};

describe("earliestLegalTerm", () => {
  it("moves a course forward past the prerequisite that blocks it", () => {
    // MATH 141 needs MATH 140. Put 141 first and 140 second: the only legal
    // home for 141 is after 140.
    const plan = planOf(["MATH 141", "MATH 140", null, null]);
    const { items, sched } = resolve(plan);
    const target = items.find((i) => i.code === "MATH 141")!;
    const got = earliestLegalTerm(catalog, "MATH 141", target.sem, sched, plan.terms.length);
    expect(got, "no legal term found for MATH 141").not.toBeNull();
    expect(got!.term).toBeGreaterThan(1);
    // And the answer must actually hold when checked there.
    expect(checkCourse(catalog, "MATH 141", got!.term, sched).value).toBe(SAT);
  });

  it("leaves a course alone when it is already legal", () => {
    const plan = planOf(["MATH 140", "MATH 141", null, null]);
    const { items, sched } = resolve(plan);
    const at = items.find((i) => i.code === "MATH 141")!.sem;
    expect(earliestLegalTerm(catalog, "MATH 141", at, sched, plan.terms.length)).toBeNull();
  });

  it("returns the EARLIEST legal term, not merely a legal one", () => {
    // Four empty terms after the prerequisite: the answer has to be the first
    // of them. A scan that stopped at the end of the plan would also "work"
    // and would be useless.
    const plan = planOf(["MATH 141", "MATH 140", null, null, null, null]);
    const { items, sched } = resolve(plan);
    const at = items.find((i) => i.code === "MATH 141")!.sem;
    const got = earliestLegalTerm(catalog, "MATH 141", at, sched, plan.terms.length)!;
    // One term after MATH 140 sits, and no later.
    const mathSem = items.find((i) => i.code === "MATH 140")!.sem;
    expect(got.term).toBe(mathSem + 1);
  });

  it("says so when no term in the plan works", () => {
    // MATH 141 with its prerequisite in the LAST term: there is nowhere after
    // it to go. Returning a term anyway would move the course somewhere it
    // still does not hold.
    const plan = planOf(["MATH 141", null, null, "MATH 140"]);
    const { items, sched } = resolve(plan);
    const at = items.find((i) => i.code === "MATH 141")!.sem;
    expect(earliestLegalTerm(catalog, "MATH 141", at, sched, plan.terms.length)).toBeNull();
  });

  it("reports which prerequisites were blocking it", () => {
    // The student is about to be told their course moves three terms. They
    // are owed the reason, and the reason is a course code they recognise.
    const plan = planOf(["MATH 141", "MATH 140", null, null]);
    const { items, sched } = resolve(plan);
    const at = items.find((i) => i.code === "MATH 141")!.sem;
    const got = earliestLegalTerm(catalog, "MATH 141", at, sched, plan.terms.length)!;
    expect(got.blockedBy).toContain("MATH 140");
  });

  it("never suggests a gap term", () => {
    // A Gap Term is intentionally empty — a co-op, a leave. Dropping a course
    // into one silently cancels a decision the student made on purpose.
    const plan = planOf(["MATH 141", "MATH 140", null, null]);
    (plan.terms[2] as { gap?: boolean }).gap = true;
    const { items, sched } = resolve(plan);
    const at = items.find((i) => i.code === "MATH 141")!.sem;
    const got = earliestLegalTerm(catalog, "MATH 141", at, sched, plan.terms.length, plan)!;
    expect(got, "no legal term found").not.toBeNull();
    expect(got.term, "suggested a term the student deliberately emptied").not.toBe(2);
  });

  it("is a no-op for a course with no enforced prerequisites", () => {
    const plan = planOf(["MATH 140", null, null]);
    const { sched } = resolve(plan);
    expect(earliestLegalTerm(catalog, "MATH 140", 0, sched, plan.terms.length)).toBeNull();
  });

  it("says nothing about a course that is not in the catalog", () => {
    const plan = planOf(["MATH 140", null]);
    const { sched } = resolve(plan);
    expect(earliestLegalTerm(catalog, "FAKE 999", 0, sched, plan.terms.length)).toBeNull();
  });
});

describe("moving a course can break the courses that depend on it", () => {
  it("names the dependents the move would put out of order", () => {
    // MATH 140 -> MATH 141 -> MATH 230. Drag MATH 141 before MATH 140 and the
    // fix pushes it after MATH 140 -- which lands it at or after MATH 230,
    // the course that depends on IT. Telling the student "nothing else moves"
    // would be true and still misleading: nothing moves, something breaks.
    const plan = planOf(["MATH 141", "MATH 140", "MATH 230", null]);
    const { items, sched } = resolve(plan);
    const at = items.find((i) => i.code === "MATH 141")!.sem;
    const got = earliestLegalTerm(catalog, "MATH 141", at, sched, plan.terms.length, plan);
    expect(got, "no legal term found").not.toBeNull();
    expect(got!.breaks, "the move silently breaks MATH 230").toContain("MATH 230");
  });

  it("reports no breakage when there is none", () => {
    // Same chain, but MATH 230 is not in the plan at all, so nothing downstream
    // can be disturbed.
    const plan = planOf(["MATH 141", "MATH 140", null, null]);
    const { items, sched } = resolve(plan);
    const at = items.find((i) => i.code === "MATH 141")!.sem;
    expect(earliestLegalTerm(catalog, "MATH 141", at, sched, plan.terms.length, plan)!.breaks).toEqual([]);
  });
});
