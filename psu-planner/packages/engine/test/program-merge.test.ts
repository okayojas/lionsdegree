/** Adding and withdrawing a Program on an EXISTING Plan, against real catalog
 * data.
 *
 * THE FAILURE THIS GUARDS. `generatePlan` ran exactly once, during onboarding.
 * A student who declared a minor in October could only start over, and starting
 * over deletes the Plan: every completed Course, every Course they added
 * themselves, every Slot they had filled, every Constraint they had set and the
 * Edition their requirements are pinned to. So the fixture here is not a bare
 * generated Plan — it is a Plan that has been LIVED IN, and every one of those
 * things is asserted to survive the merge individually. A test that merged into
 * a fresh Plan would pass while the feature destroyed everything it exists to
 * protect.
 *
 * Tested at the engine on purpose. This is an engine property; observing it
 * through the store and the connector would be observing it through two layers
 * of transport, and neither layer is where it can break.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  addProgram, buildCatalog, generatePlan, originPrograms, previewRemoveProgram, removeProgram,
  type Catalog, type Course, type PlanDoc, type ProgramTemplate, type SlotSpec,
} from "../src/index.js";

import { CATALOG_DIR } from "./edition.js";
const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, rel), "utf-8"));
const subjects = load("subjects_index.json") as Record<string, string>;

const ESC = "engineering-engineering-science-bs";
const AIE = "engineering-artificial-intelligence-engineering-bs";
const IST_MINOR = "eberly-science-information-sciences-technology-mathematics-minor";

function majorTemplate(slug: string): ProgramTemplate {
  const p = load(`programs/majors/${slug}.json`);
  const up = p.suggestedPlans.find((sp: { campusLabel: string }) => /University Park/i.test(sp.campusLabel)) ?? p.suggestedPlans[0];
  return { slug: p.slug, name: p.name, campusLabel: "", semesters: up.semesters, requirements: p.requirementSections };
}
function minorTemplate(slug: string): ProgramTemplate {
  const p = load(`programs/minors/${slug}.json`);
  return { slug: p.slug, name: p.name, campusLabel: "", semesters: [], requirements: p.requirementSections };
}

function catalogFor(plan: PlanDoc): Catalog {
  const prefixes = new Set<string>();
  for (const t of plan.terms) for (const i of t.items) if ("code" in i) prefixes.add(i.code.split(" ")[0]);
  for (const c of Object.keys(plan.completed)) prefixes.add(c.split(" ")[0]);
  let courses: Course[] = [];
  for (const pf of prefixes) if (subjects[pf]) courses = courses.concat(load(subjects[pf]));
  return buildCatalog(courses);
}

const codesIn = (plan: PlanDoc): string[] =>
  plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));
const slotsIn = (plan: PlanDoc): SlotSpec[] =>
  plan.terms.flatMap((t) => t.items.filter((i): i is SlotSpec => "slot" in i));
const originOf = (plan: PlanDoc, code: string) =>
  plan.terms.flatMap((t) => t.items).find((i) => "code" in i && i.code === code)?.origin;

/** A Plan a student has actually been living in for two years.
 *
 * Every field set here is one the old "start over" path destroyed, and each is
 * asserted below. `rev` is deliberately not 1: `generatePlan` returns 1, so a
 * merge that quietly rebuilt the Plan would reset it and the test would catch
 * the reset rather than merely the data loss. */
function livedInPlan(): { plan: PlanDoc; catalog: Catalog; filledSlotId: string } {
  const esc = majorTemplate(ESC);
  const done = ["MATH 140", "CHEM 110", "ENGL 15"];
  const plan = generatePlan([esc], {
    startTerm: { term: "Fall", year: 2026 },
    completedCourses: done,
  }, "lived-in");
  plan.rev = 7;
  plan.edition = "2025-2026"; // NOT the newest — the whole point of ADR 0001
  // A Course the student added themselves, which no Template placed.
  plan.added.push({ code: "CMPSC 131", sem: 1 });
  // A Slot the student has already chosen a Course for.
  const slot = slotsIn(plan)[0];
  plan.slotFills[slot.id] = "STAT 200";
  // Rules the student imposed on their own Plan.
  plan.constraints = [
    { code: "PHYS 212", type: "not-in", termIndex: 2 },
    { code: "MATH 141", type: "not-before", termIndex: 1 },
  ];
  plan.summerYears = [2028];
  plan.moves["PHYS 211"] = 2;
  return { plan, catalog: catalogFor(plan), filledSlotId: slot.id };
}

describe("declaring a minor on a Plan two years in", () => {
  const { plan, filledSlotId } = livedInPlan();
  const before = structuredClone(plan);
  const termCountBefore = plan.terms.length;
  const result = addProgram(plan, minorTemplate(IST_MINOR));

  it("adds the Program to the Plan rather than building a new one", () => {
    expect(plan.programs, "the minor is not on the plan").toContain(IST_MINOR);
    expect(plan.programs, "the major it was added to was dropped").toContain(ESC);
    expect(plan.id, "the Plan was replaced rather than merged into").toBe(before.id);
  });

  it("leaves completed Courses completed — adding a minor is not two years lost", () => {
    expect(plan.completed, "completed courses changed during the merge").toEqual(before.completed);
    for (const code of ["MATH 140", "CHEM 110", "ENGL 15"]) {
      expect(plan.completed[code], `${code} stopped being completed`).toBe(true);
    }
  });

  it("keeps the Course the student added themselves", () => {
    expect(plan.added, "the student's own added course was dropped or moved").toEqual(before.added);
    expect(plan.added.some((a) => a.code === "CMPSC 131"), "CMPSC 131 is no longer on the plan").toBe(true);
  });

  it("keeps the Slot the student had already filled", () => {
    expect(plan.slotFills, "a slot fill was lost or rewritten").toEqual(before.slotFills);
    expect(plan.slotFills[filledSlotId], "the filled slot no longer holds the student's choice").toBe("STAT 200");
    expect(
      slotsIn(plan).some((s) => s.id === filledSlotId),
      "the filled slot's card vanished, so the fill points at nothing",
    ).toBe(true);
  });

  it("keeps the Constraints the student set", () => {
    expect(plan.constraints, "a declared scheduling constraint was lost").toEqual(before.constraints);
  });

  it("keeps the Revision — a merge is an edit, not a new Plan", () => {
    // generatePlan returns rev 1. A merge that rebuilt the Plan would show it.
    expect(plan.rev, "the revision was reset, which means the Plan was rebuilt").toBe(7);
  });

  it("stays pinned to its own Edition (ADR 0001)", () => {
    expect(plan.edition, "the Plan was re-based onto another bulletin edition").toBe("2025-2026");
  });

  it("keeps everything else the student had set", () => {
    expect(plan.summerYears, "the student's opted-in summer was lost").toEqual([2028]);
    expect(plan.moves, "a manual card position was lost").toEqual(before.moves);
  });

  it("folds the minor's requirements into the Terms that already exist", () => {
    expect(plan.terms.length, "terms were appended — the minor was bolted onto the end").toBe(termCountBefore);
    // The minor prescribes IST 110/210/220, none of which the major places.
    for (const code of ["IST 110", "IST 210", "IST 220"]) {
      expect(codesIn(plan), `${code} is prescribed by the minor and is not on the plan`).toContain(code);
    }
    // ...and the choose-three-of-five group becomes three Slots, not three
    // guessed Courses. The engine does not pick for the student.
    const minorSlots = slotsIn(plan).filter((s) => s.program === IST_MINOR);
    expect(minorSlots.length, "the minor's choose-three group produced the wrong number of slots").toBe(3);
  });

  it("gives every merged item an Origin inside the Plan's own index space", () => {
    // The optimizer anchors to origin.templateSem. An Origin anchored at 0 on a
    // Plan whose remaining courses start at template semester 4 would drag the
    // minor in front of everything the student is actually taking next.
    const base = Math.min(
      ...before.terms.flatMap((t) => t.items.flatMap((i) => (!("slot" in i) && i.origin ? [i.origin.templateSem] : []))),
    );
    const merged = plan.terms.flatMap((t) => t.items).filter((i) => originPrograms(i.origin).includes(IST_MINOR));
    expect(merged.length, "nothing was attributed to the minor at all").toBeGreaterThan(0);
    for (const it of merged) {
      const sem = it.origin!.templateSem;
      expect(sem, `${it.origin!.program} anchored before the plan's own flow`).toBeGreaterThanOrEqual(base);
      expect(
        sem,
        `${it.origin!.program} anchored past the end of the plan, so the optimizer would flow it after everything`,
      ).toBeLessThan(base + plan.terms.length);
    }
  });

  it("reports what it did", () => {
    expect(result.coursesAdded, "the prescribed courses were not reported as added").toContain("IST 110");
    expect(result.note, "the student is told nothing about what changed").toMatch(/IST|Information/i);
  });

  it("is idempotent — asking twice changes nothing", () => {
    const snapshot = structuredClone(plan);
    const again = addProgram(plan, minorTemplate(IST_MINOR));
    expect(again.alreadyPresent, "a second add was not recognised as a no-op").toBe(true);
    expect(plan, "a repeated add changed the plan").toEqual(snapshot);
  });
});

describe("a Course both Programs require counts once", () => {
  // ESC and AIE share MATH 140, MATH 141, PHYS 211, PHYS 212, ENGL 15,
  // CAS 100A and ENGL 202C in their published plans.
  const plan = generatePlan([majorTemplate(ESC)], {
    startTerm: { term: "Fall", year: 2026 }, completedCourses: [],
  }, "double");
  const termsBefore = plan.terms.length;
  const result = addProgram(plan, majorTemplate(AIE));

  it("places the shared Course once, not twice", () => {
    const codes = codesIn(plan);
    expect(new Set(codes).size, `duplicate course cards: ${codes.filter((c, i) => codes.indexOf(c) !== i).join(", ")}`)
      .toBe(codes.length);
    for (const shared of ["MATH 140", "PHYS 211", "ENGL 202C"]) {
      expect(codes.filter((c) => c === shared).length, `${shared} is on the chart more than once`).toBe(1);
    }
  });

  it("records BOTH Programs on the shared Course's Origin", () => {
    for (const shared of ["MATH 140", "PHYS 211", "ENGL 202C"]) {
      const progs = originPrograms(originOf(plan, shared));
      expect(progs, `${shared}'s Origin does not name the major that placed it`).toContain(ESC);
      expect(progs, `${shared}'s Origin does not name the major just added`).toContain(AIE);
    }
    expect(result.coursesShared, "the shared courses were not reported as shared").toContain("MATH 140");
  });

  it("does not record the second Program on a Course it does not require", () => {
    // The guard against "record everything on everything", which would make
    // withdrawal keep every card forever.
    const escOnly = codesIn(plan).find((c) => {
      const progs = originPrograms(originOf(plan, c));
      return progs.length === 1 && progs[0] === ESC;
    });
    expect(escOnly, "every course claims both majors — Origin is no longer telling them apart").toBeTruthy();
  });

  it("folds the second major into the existing Terms rather than after them", () => {
    const aieTermIdx = plan.terms
      .map((t, i) => (t.items.some((x) => originPrograms(x.origin).includes(AIE)) ? i : -1))
      .filter((i) => i >= 0);
    expect(plan.terms.length, "terms were appended — the second major was bolted onto the end").toBe(termsBefore);
    expect(aieTermIdx.length, "the second major landed in no term at all").toBeGreaterThan(1);
    expect(
      Math.min(...aieTermIdx),
      "every one of the second major's requirements landed in the back half — it was appended, not folded",
    ).toBeLessThan(plan.terms.length / 2);
  });

  it("does not stack the two Programs' gen-ed Slots", () => {
    const solo = generatePlan([majorTemplate(ESC)], { startTerm: { term: "Fall", year: 2026 }, completedCourses: [] }, "s");
    const soloAie = generatePlan([majorTemplate(AIE)], { startTerm: { term: "Fall", year: 2026 }, completedCourses: [] }, "a");
    const ge = (p: PlanDoc) => slotsIn(p).filter((s) => s.slot !== "EL").length;
    expect(
      ge(plan),
      "gen-ed slots were summed across the two majors instead of taking the larger",
    ).toBeLessThan(ge(solo) + ge(soloAie));
  });
});

describe("withdrawing a Program", () => {
  function doubleMajorPlan(): PlanDoc {
    const plan = generatePlan([majorTemplate(ESC)], {
      startTerm: { term: "Fall", year: 2026 }, completedCourses: ["CHEM 110"],
    }, "drop");
    plan.rev = 12;
    plan.edition = "2025-2026";
    plan.added.push({ code: "CMPSC 131", sem: 1 });
    plan.constraints = [{ code: "PHYS 212", type: "not-in", termIndex: 2 }];
    addProgram(plan, majorTemplate(AIE));
    return plan;
  }

  it("reports what it would do BEFORE it does it", () => {
    const plan = doubleMajorPlan();
    const snapshot = structuredClone(plan);
    const preview = previewRemoveProgram(plan, AIE, { remaining: [majorTemplate(ESC)] });
    expect(plan, "the preview changed the plan it was asked to describe").toEqual(snapshot);
    expect(preview.refusal, "a legitimate withdrawal was refused").toBeNull();
    expect(preview.remainingChecked, "the preview did not say which programs it checked").toEqual([ESC]);
  });

  it("names the Courses it would remove, rather than stranding them", () => {
    const plan = doubleMajorPlan();
    const preview = previewRemoveProgram(plan, AIE, { remaining: [majorTemplate(ESC)] });
    expect(preview.coursesRemoved.length, "dropping a whole major removes no courses").toBeGreaterThan(0);
    for (const code of preview.coursesRemoved) {
      expect(code, `"${code}" is not a course code — the report is not nameable`).toMatch(/^[A-Z][A-Z \-]* \d+[A-Z]*$/);
    }
    expect(preview.note, "the summary does not name what leaves").toContain(preview.coursesRemoved[0]);
  });

  it("keeps a Course the Program it is leaving behind still requires", () => {
    const plan = doubleMajorPlan();
    const preview = previewRemoveProgram(plan, AIE, { remaining: [majorTemplate(ESC)] });
    expect(preview.coursesKept, "a shared course was not recognised as still needed").toContain("MATH 140");
    expect(preview.coursesRemoved, "a course the remaining major requires was about to be removed").not.toContain("MATH 140");

    removeProgram(plan, AIE, { remaining: [majorTemplate(ESC)] });
    expect(codesIn(plan), "MATH 140 was removed even though the remaining major requires it").toContain("MATH 140");
    expect(
      originPrograms(originOf(plan, "MATH 140")),
      "MATH 140 still claims a program the plan no longer has",
    ).toEqual([ESC]);
  });

  it("removes the Courses nothing else requires, and strands nothing claiming the dropped Program", () => {
    const plan = doubleMajorPlan();
    const preview = removeProgram(plan, AIE, { remaining: [majorTemplate(ESC)] });
    expect(
      preview.coursesRemoved.length,
      "nothing was removed, so the rest of this test checks nothing",
    ).toBeGreaterThan(0);
    for (const code of preview.coursesRemoved) {
      expect(codesIn(plan), `${code} was reported as removed but is still on the chart`).not.toContain(code);
    }
    const orphans = plan.terms
      .flatMap((t) => t.items)
      .filter((i) => originPrograms(i.origin).includes(AIE));
    expect(orphans, "items are still attributed to the program that was dropped").toEqual([]);
    expect(plan.programs, "the dropped program is still listed on the plan").toEqual([ESC]);
  });

  it("leaves completed Courses, student additions, Constraints, Revision and Edition alone", () => {
    const plan = doubleMajorPlan();
    const before = structuredClone(plan);
    removeProgram(plan, AIE, { remaining: [majorTemplate(ESC)] });
    expect(plan.completed, "a completed course was un-completed by dropping a program").toEqual(before.completed);
    expect(plan.added, "the student's own added course was dropped with the program").toEqual(before.added);
    expect(plan.constraints, "a constraint was lost").toEqual(before.constraints);
    expect(plan.rev, "the revision was reset, so the Plan was rebuilt rather than edited").toBe(12);
    expect(plan.edition, "the Plan was re-based onto another bulletin edition").toBe("2025-2026");
  });

  it("says what the withdrawal leaves unfilled", () => {
    // Dropping the major that contributed the gen-ed and elective Slots leaves
    // the surviving major short of the cards standing for its own requirements.
    // Slots are budgeted as the MAX across programs, so this is exactly the
    // case where "it was the other program's slot" is the wrong conclusion.
    const plan = doubleMajorPlan();
    const preview = previewRemoveProgram(plan, ESC, { remaining: [majorTemplate(AIE)] });
    expect(preview.unfilled.length, "dropping the program that owns the slots reports nothing unfilled").toBeGreaterThan(0);
    for (const u of preview.unfilled) {
      expect(u.program, "an unfilled requirement names no program").toBeTruthy();
      expect(u.because, "an unfilled requirement does not say why").toBeTruthy();
    }
  });

  it("refuses to leave a Plan with no Program at all", () => {
    const plan = generatePlan([majorTemplate(ESC)], {
      startTerm: { term: "Fall", year: 2026 }, completedCourses: [],
    }, "only");
    const snapshot = structuredClone(plan);
    const res = removeProgram(plan, ESC);
    expect(res.refusal, "dropping the only program was allowed").toBeTruthy();
    expect(plan, "a refused withdrawal still changed the plan").toEqual(snapshot);
  });

  it("refuses a Program that is not on the Plan", () => {
    const plan = generatePlan([majorTemplate(ESC), majorTemplate(AIE)], {
      startTerm: { term: "Fall", year: 2026 }, completedCourses: [],
    }, "two");
    const snapshot = structuredClone(plan);
    const res = removeProgram(plan, IST_MINOR);
    expect(res.refusal, "a program the plan never had was 'removed'").toBeTruthy();
    expect(plan, "a refused withdrawal still changed the plan").toEqual(snapshot);
  });

  it("clears a filled Slot it takes away, and says which Course the student loses", () => {
    // The minor, not the second major: its choose-three group is guaranteed to
    // contribute Slots of its own, so this case cannot go vacuous the way a
    // `if (!slot) return` would hide.
    const plan = generatePlan([majorTemplate(ESC)], {
      startTerm: { term: "Fall", year: 2026 }, completedCourses: [],
    }, "filled");
    addProgram(plan, minorTemplate(IST_MINOR));
    const minorSlot = slotsIn(plan).find((s) => originPrograms(s.origin)[0] === IST_MINOR);
    expect(minorSlot, "the minor contributed no slot, so this case tests nothing").toBeTruthy();
    plan.slotFills[minorSlot!.id] = "MATH 451";
    const preview = previewRemoveProgram(plan, IST_MINOR, { remaining: [majorTemplate(ESC)] });
    expect(
      preview.filledSlotsCleared.map((s) => s.id),
      "a slot the student had chosen a course for was taken away silently",
    ).toContain(minorSlot!.id);
    expect(
      preview.filledSlotsCleared.map((s) => s.code),
      "the preview does not name the course the student would lose",
    ).toContain("MATH 451");
    removeProgram(plan, IST_MINOR, { remaining: [majorTemplate(ESC)] });
    expect(plan.slotFills[minorSlot!.id], "the fill still points at a slot that no longer exists").toBeUndefined();
    expect(
      slotsIn(plan).some((s) => s.id === minorSlot!.id),
      "the minor's slot card survived the withdrawal",
    ).toBe(false);
  });
});
