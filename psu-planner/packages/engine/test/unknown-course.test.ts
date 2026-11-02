/** A Course the catalog has no entry for (#49).
 *
 * THE BUG, and it was live in production. `checkCourse` opens with "no
 * entry, no requirements to fail" and returns SAT. Inside the engine
 * that is right: the optimiser must be able to place a Course it
 * cannot describe, or a Plan carrying a renumbered or withdrawn Course
 * could not be laid out at all.
 *
 * Outside the engine it was being rendered to a student as
 * "prerequisites: satisfied" — on every `get_plan` call, directly
 * beside a title reading "(not in this edition's catalog —
 * unverified)". One answer contradicting its other half, and the
 * contradiction resolved in the confident direction.
 *
 * Nothing caught it. It surfaced while #45 was giving a diagram three
 * colours and noticed an unknown Course would be painted green.
 *
 * The fix keeps the verdict and adds the reason: `known: false`. These
 * tests pin BOTH halves — that placement still works, and that the
 * absence is reportable.
 */
import { describe, it, expect } from "vitest";
import { checkCourse, SAT, type Catalog, type Schedule } from "../src/index.js";

/** One real Course with a real prerequisite, and nothing else. */
const catalog: Catalog = {
  "MATH 141": {
    code: "MATH 141",
    title: "Calculus II",
    credits: "4",
    creditsParsed: { min: 4, max: 4, repeatableMax: null },
    astComplete: true,
    concurrentAst: null,
    prereqAst: { op: "course", code: "MATH 140" },
  },
  "MATH 140": {
    code: "MATH 140",
    title: "Calculus I",
    credits: "4",
    creditsParsed: { min: 4, max: 4, repeatableMax: null },
    astComplete: true,
    prereqAst: null,
    concurrentAst: null,
  },
} as unknown as Catalog;

/** A Schedule is keyed by Course code and carries the Term it sits in,
 * whether it is done, and the item itself. */
const entry = (code: string, sem: number): unknown => ({
  sem,
  completed: false,
  item: { kind: "course", code, sem, id: code },
});
const sched = { "MATH 140": entry("MATH 140", 0), "MATH 141": entry("MATH 141", 1) } as unknown as Schedule;

describe("a Course the catalog does not have", () => {
  it("is reported as NOT KNOWN", () => {
    // The whole fix. Without this flag there is no way for anything
    // downstream to tell "nothing to check" from "checked, and fine".
    const chk = checkCourse(catalog, "GONE 999", 2, sched);
    expect(chk.known, "an absent Course is indistinguishable from a checked one").toBe(false);
  });

  it("still scores SAT, because the optimiser depends on it", () => {
    // Deliberately asserted rather than left implicit. Turning this
    // into UNSAT would make an unknown Course unplaceable, and a Plan
    // carrying one — a renumbered course, an older Plan — would stop
    // laying out at all. The verdict is not the bug; reporting it
    // without the reason was.
    expect(checkCourse(catalog, "GONE 999", 2, sched).value).toBe(SAT);
  });

  it("does not claim to have evaluated anything", () => {
    expect(checkCourse(catalog, "GONE 999", 2, sched).leaves).toEqual([]);
  });
});

describe("a Course the catalog does have", () => {
  it("is reported as known, whatever the verdict", () => {
    // The other half of the flag. If `known` were false everywhere, or
    // true everywhere, every assertion above would pass and nothing
    // would be distinguished.
    expect(checkCourse(catalog, "MATH 141", 1, sched).known, "a real Course was reported unknown").toBe(true);
    expect(checkCourse(catalog, "MATH 140", 0, sched).known).toBe(true);
  });

  it("is still judged on its actual prerequisites", () => {
    // MATH 141 after MATH 140: satisfied. Before it: not.
    expect(checkCourse(catalog, "MATH 141", 1, sched).value).toBe(SAT);
    const tooEarly = {
      "MATH 140": entry("MATH 140", 3),
      "MATH 141": entry("MATH 141", 0),
    } as unknown as Schedule;
    expect(checkCourse(catalog, "MATH 141", 0, tooEarly).value).not.toBe(SAT);
  });
});
