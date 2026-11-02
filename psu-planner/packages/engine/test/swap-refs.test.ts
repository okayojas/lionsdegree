/** What follows a Course when it is swapped for its alternative (#54).
 *
 * THE BUG, in both surfaces. A student swaps ECON 102 for the ECON 104
 * their Program lists, and the `not-in spring` Constraint they had set
 * still names ECON 102 — a Course no longer in their Plan. It applies
 * to nothing, silently, and the optimiser is free to put ECON 104 in
 * exactly the term they said they could not do.
 *
 * The planner carried `moves` across and nothing else. The connector
 * mirrored the planner deliberately rather than inventing a fix in one
 * place, which was the right call for that ticket and left this open in
 * both. One function now, called by both.
 */
import { describe, it, expect } from "vitest";
import { carryCourseRefs, describeCarry, type PlanDoc } from "../src/index.js";

const planWith = (over: Partial<PlanDoc> = {}): PlanDoc =>
  ({
    id: "p",
    rev: 1,
    updatedAt: "",
    edition: "2026-2027",
    programs: ["x"],
    terms: [{ label: "Fall 2026", items: [] }, { label: "Spring 2027", items: [] }],
    completed: {},
    moves: {},
    slotFills: {},
    added: [],
    constraints: [],
    ...over,
  }) as unknown as PlanDoc;

describe("a Constraint the student set", () => {
  it("FOLLOWS THE SWAP rather than being left pointing at nothing", () => {
    // The headline. Before this, the Constraint kept naming a Course
    // that was no longer in the Plan, so it constrained nothing and the
    // student was never told their preference had stopped applying.
    const plan = planWith({ constraints: [{ code: "ECON 102", type: "not-in", termIndex: 1 }] } as never);
    carryCourseRefs(plan, "ECON 102", "ECON 104");

    expect(plan.constraints!.map((c) => c.code), "the constraint still names the course that left").toEqual([
      "ECON 104",
    ]);
    expect(plan.constraints![0].type, "the kind of constraint changed").toBe("not-in");
    expect(plan.constraints![0].termIndex, "the term it was about changed").toBe(1);
  });

  it("leaves constraints about other Courses alone", () => {
    // A carry that rewrote every constraint would be a different bug
    // with the same symptom.
    const plan = planWith({
      constraints: [
        { code: "ECON 102", type: "not-in", termIndex: 1 },
        { code: "MATH 140", type: "pin", termIndex: 0 },
      ],
    } as never);
    carryCourseRefs(plan, "ECON 102", "ECON 104");
    expect(plan.constraints!.find((c) => c.type === "pin")!.code).toBe("MATH 140");
  });
});

describe("a completion flag", () => {
  it("follows the swap, and the old code stops being marked", () => {
    const plan = planWith({ completed: { "ECON 102": true } });
    carryCourseRefs(plan, "ECON 102", "ECON 104");
    expect(plan.completed["ECON 104"], "the student lost credit for a course they passed").toBe(true);
    expect(plan.completed["ECON 102"], "a course not in the plan is still marked complete").toBeUndefined();
  });

  it("is not invented when the Course was never passed", () => {
    const plan = planWith({ completed: {} });
    carryCourseRefs(plan, "ECON 102", "ECON 104");
    expect(plan.completed["ECON 104"], "a swap granted credit nobody earned").toBeUndefined();
  });
});

describe("a manual move", () => {
  it("follows the swap, as it already did", () => {
    // The one thing both surfaces already carried. Asserted so the
    // refactor cannot lose it.
    const plan = planWith({ moves: { "ECON 102": 1 } });
    carryCourseRefs(plan, "ECON 102", "ECON 104");
    expect(plan.moves["ECON 104"]).toBe(1);
    expect(plan.moves["ECON 102"]).toBeUndefined();
  });

  it("leaves a move keyed by something else alone", () => {
    // An added Course or a filled Slot keys its move by its own id, and
    // that move was never about this card.
    const plan = planWith({ moves: { "add-STAT 200": 2 } });
    carryCourseRefs(plan, "ECON 102", "ECON 104");
    expect(plan.moves["add-STAT 200"], "an unrelated move was rewritten").toBe(2);
  });
});

describe("what the student is told", () => {
  it("names the constraint that moved", () => {
    // A decision made on a student's behalf is one they have to be
    // able to disagree with, which means hearing about it.
    const plan = planWith({ constraints: [{ code: "ECON 102", type: "not-in", termIndex: 1 }] } as never);
    const said = describeCarry(carryCourseRefs(plan, "ECON 102", "ECON 104"), "ECON 102", "ECON 104");
    expect(said, "the student was not told their preference moved").toBeTruthy();
    expect(said!).toMatch(/ECON 104/);
    expect(said!).toMatch(/constraint/i);
  });

  it("says nothing when nothing followed", () => {
    // A note that always appears is a note nobody reads.
    const plan = planWith();
    expect(describeCarry(carryCourseRefs(plan, "ECON 102", "ECON 104"), "ECON 102", "ECON 104")).toBeNull();
  });
});
