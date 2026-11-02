/** Rearranging a Plan, and taking it back (#42).
 *
 * Six changes whose common thread is that they can be undone. Before
 * them the assistant could set a Constraint and never lift it, remove a
 * Course and never restore it, skip a Term and never un-skip it — an
 * assistant whose every action is one-way is one a student cannot
 * safely let near their degree.
 *
 * Two things here are easy to get wrong and silent when you do.
 *
 * THE FIRST IS THE ID MAPPING. The planner's own reversibility works on
 * ITEM IDS; every tool here takes a Course CODE. They are the same
 * string only for a Course the Template placed — a Course the student
 * added is `add-<code>` and a Course filling a Slot is keyed by the
 * SLOT's id. A tool that writes `moves[code]` is right one time in
 * three and does nothing at all the other two, while reporting success.
 *
 * THE SECOND IS THAT MOVING IS NOT REMOVE-THEN-ADD. A re-added Course
 * is a bare code in a term: no Origin, so a double major's shared
 * requirement counts twice, and no alternatives, so the choice the
 * Program offered is gone.
 *
 * The hosted half of this ticket lives in `worker-plan.test.ts`, which
 * runs all six through `fetch(Request, Env)` — the local one working
 * has never been evidence about the hosted one.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanDoc } from "@psu-planner/engine";
import { executeTool, loadContext, type ToolContext } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "plan.json"), "utf-8"));

let planPath: string;
let ctx: ToolContext;

/** A throwaway copy of the fixture, optionally edited first.
 *
 * Several cases here need a state the tools cannot reach in two calls —
 * an empty term in the MIDDLE of a plan, a constraint pointing at it.
 * Building those by chaining mutations would make the test depend on
 * the optimizer's output, which is not what any of them are about. */
async function open(edit: (plan: PlanDoc) => void = () => {}): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-reversible-"));
  planPath = path.join(dir, "plan.json");
  const file = JSON.parse(JSON.stringify(FIXTURE)) as { plan: PlanDoc };
  edit(file.plan);
  fs.writeFileSync(planPath, JSON.stringify(file));
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
}

beforeEach(() => open());

/** Every mutation states the revision it was computed from. These tests
 * are about what the changes DO; the missing and stale cases are
 * covered once for all of them in `worker-plan.test.ts`. */
const call = (name: string, args: Record<string, unknown> = {}) =>
  executeTool(name, { based_on_revision: ctx.rev, ...args }, ctx);

const file = () => fs.readFileSync(planPath, "utf-8");
const onDisk = (): PlanDoc => JSON.parse(file()).plan;

/** The stored CourseSpec, which is where `origin` and `alternatives`
 * live — a move that loses them loses them here. */
const specOf = (code: string) =>
  onDisk()
    .terms.flatMap((t) => t.items)
    .find((i) => "code" in i && i.code === code) as
    | { code: string; origin?: unknown; alternatives?: string[] }
    | undefined;

/** Which term a Course actually sits in, read the way a model reads it.
 * Not the stored term index: a manual move overrides that, and the
 * whole point of `move_course` is the override. */
async function whereIs(code: string): Promise<number> {
  const view = (await call("get_plan")) as {
    terms: { index: number; courses: { code: string }[] }[];
  };
  return view.terms.find((t) => t.courses.some((c) => c.code === code))?.index ?? -1;
}

const codesInPlan = (): string[] =>
  onDisk()
    .terms.flatMap((t) => t.items)
    .flatMap((i) => ("code" in i ? [i.code] : []));

/** A sentence a student could plausibly have said, for the consent gate
 * on removing a required Course. Deliberately not model narration. */
const SAID = "I have changed my mind, please take that one out of my degree";

describe("moving a course between terms", () => {
  it("puts it in the term it was asked for", async () => {
    expect(await whereIs("CHEM 110"), "the fixture already had CHEM 110 in term 2, so this proves nothing").not.toBe(2);
    const r = (await call("move_course", { code: "CHEM 110", term_index: 2 })) as { ok?: boolean };
    expect(r.ok, `move_course did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(await whereIs("CHEM 110"), "CHEM 110 was reported moved but is not in the term it was moved to").toBe(2);
  });

  it("keeps the Origin and the alternatives that remove-then-add would lose", async () => {
    // THE ACCEPTANCE CRITERION, and the reason this is its own tool.
    // `origin` is what makes a double major's shared requirement count
    // once; `alternatives` is the choice the Program offered. A removal
    // followed by an add produces a bare `{code, sem}` in `added` and
    // neither of them survives.
    const before = specOf("ECON 102")!;
    expect(before.origin, "the fixture's ECON 102 has no Origin, so this test cannot detect losing one").toBeTruthy();
    expect(before.alternatives, "the fixture's ECON 102 offers no alternatives to lose").toEqual(["ECON 104"]);

    const r = (await call("move_course", { code: "ECON 102", term_index: 4 })) as { ok?: boolean };
    expect(r.ok, `move_course did not report success: ${JSON.stringify(r)}`).toBe(true);

    const after = specOf("ECON 102");
    expect(after, "ECON 102 left the plan's term items, which means this was a remove-then-add").toBeTruthy();
    expect(after!.origin, "the move dropped the Origin, so a double major's shared requirement would count twice").toEqual(before.origin);
    expect(after!.alternatives, "the move dropped the alternatives the Template offered").toEqual(before.alternatives);
    expect(await whereIs("ECON 102"), "the course did not end up in the term it was moved to").toBe(4);
  });

  it("records a slot-filled course under the SLOT's id, not the course code", async () => {
    // THE ID MAPPING, in the case that breaks a naive implementation.
    // `buildItems` ids a Course that fills a Slot by the Slot's id, so
    // `moves["CMPSC 465"]` is a key `semOf` never reads: the write
    // lands, the tool answers "moved", and the card does not move.
    await call("fill_slot", { slot_id: "GE-0-0", code: "CMPSC 465" });
    const r = (await call("move_course", { code: "CMPSC 465", term_index: 3 })) as { ok?: boolean };
    expect(r.ok, `move_course did not report success: ${JSON.stringify(r)}`).toBe(true);

    const moves = onDisk().moves;
    expect(moves["GE-0-0"], "the move was not recorded against the slot's item id, so nothing will ever read it").toBe(3);
    expect(moves["CMPSC 465"], "the move was recorded under the course code, which no resolver reads").toBeUndefined();
    expect(await whereIs("CMPSC 465"), "the slot-filled course did not actually move").toBe(3);
  });

  it("records a student-added course under its add- id", async () => {
    // The other two-thirds of the same mapping: an added Course is
    // `add-<code>` in `plan.moves`, never the bare code.
    await call("add_course", { code: "CMPSC 465", term_index: 1 });
    const r = (await call("move_course", { code: "CMPSC 465", term_index: 4 })) as { ok?: boolean };
    expect(r.ok, `move_course did not report success: ${JSON.stringify(r)}`).toBe(true);

    expect(onDisk().moves["add-CMPSC 465"], "the move was not recorded against the added item's id").toBe(4);
    expect(await whereIs("CMPSC 465"), "the added course did not actually move").toBe(4);
  });

  it("refuses a term that does not exist, and writes nothing", async () => {
    const before = file();
    const r = (await call("move_course", { code: "CHEM 110", term_index: 99 })) as { ok?: boolean; error?: string };
    expect(r.ok, "a move into a term that does not exist was accepted").not.toBe(true);
    expect(r.error, "the refusal did not say what was wrong with the term").toMatch(/term_index/);
    expect(file(), "a refused move still wrote to the plan").toBe(before);
  });

  it("refuses a course that is not in the plan, and writes nothing", async () => {
    // ART 1 is a real course in the catalog but not in this plan, so
    // the refusal has to come from the plan rather than from the
    // catalog lookup an unknown code would fail first.
    expect(codesInPlan(), "ART 1 is in the fixture, so this tests the wrong refusal").not.toContain("ART 1");
    const before = file();
    const r = (await call("move_course", { code: "ART 1", term_index: 0 })) as { ok?: boolean; error?: string };
    expect(r.ok, "a course the plan does not contain was moved").not.toBe(true);
    expect(r.error, "the refusal did not say the course is not in the plan").toMatch(/not in the plan/i);
    expect(file(), "a refused move still wrote to the plan").toBe(before);
  });

  it("refuses to drop a course into a gap term, and writes nothing", async () => {
    // A Gap Term is INTENTIONALLY empty (CONTEXT.md). Putting a course
    // in one cancels a leave the student declared, and the only trace
    // would be a card in a term they are not enrolled for.
    await call("skip_term", { term_index: 3 });
    const gap = onDisk().terms.findIndex((t) => t.gap);
    expect(gap, "skip_term left no gap term, so there is nothing to refuse a move into").toBeGreaterThanOrEqual(0);

    const before = file();
    const r = (await call("move_course", { code: "CHEM 110", term_index: gap })) as { ok?: boolean; error?: string };
    expect(r.ok, "a course was moved into a term the student is not enrolled for").not.toBe(true);
    expect(r.error, "the refusal did not say the term is a gap term").toMatch(/gap term/i);
    expect(file(), "a refused move still wrote to the plan").toBe(before);
  });
});

describe("swapping a course for an alternative the program lists", () => {
  it("swaps it, keeps the Origin, and offers the old course back", async () => {
    const before = specOf("ECON 102")!;
    const r = (await call("swap_alternative", { code: "ECON 102", alternative: "ECON 104" })) as { ok?: boolean };
    expect(r.ok, `swap_alternative did not report success: ${JSON.stringify(r)}`).toBe(true);

    expect(specOf("ECON 104"), "ECON 104 is not in the plan after the swap").toBeTruthy();
    expect(specOf("ECON 102"), "ECON 102 is still in the plan after being swapped out").toBeUndefined();
    expect(specOf("ECON 104")!.origin, "the swap dropped the Origin, so the requirement it satisfies is no longer attached").toEqual(before.origin);
    // Reversibility is the whole thread of this ticket: the outgoing
    // course has to still be on offer, or the swap is one-way.
    expect(specOf("ECON 104")!.alternatives, "the swap is not reversible: ECON 102 is not offered back").toContain("ECON 102");
  });

  it("can be swapped straight back", async () => {
    await call("swap_alternative", { code: "ECON 102", alternative: "ECON 104" });
    const r = (await call("swap_alternative", { code: "ECON 104", alternative: "ECON 102" })) as { ok?: boolean };
    expect(r.ok, `swapping back did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(specOf("ECON 102"), "the course could not be swapped back to the one the student started with").toBeTruthy();
  });

  it("refuses a course the program does not list, and says what IS on offer", async () => {
    const before = file();
    const r = (await call("swap_alternative", { code: "ECON 102", alternative: "MATH 141" })) as {
      ok?: boolean; error?: string; alternatives?: string[];
    };
    expect(r.ok, "a course the program never offered was swapped in").not.toBe(true);
    expect(r.error, "the refusal did not say the course is not an alternative").toMatch(/not one of the alternatives/i);
    expect(r.alternatives, "the refusal did not name what the program does offer").toEqual(["ECON 104"]);
    expect(file(), "a refused swap still wrote to the plan").toBe(before);
  });

  it("says plainly when a requirement is fixed and has no alternative", async () => {
    const r = (await call("swap_alternative", { code: "CHEM 110", alternative: "CHEM 111" })) as {
      ok?: boolean; suggestion?: string;
    };
    expect(r.ok, "a fixed requirement was swapped for something else").not.toBe(true);
    expect(r.suggestion, "a requirement with no alternatives was not described as fixed").toMatch(/fixed requirement/i);
  });

  it("carries a manual move across to the new code", async () => {
    // A Template Course's item id IS its code, so a move recorded
    // against the outgoing code is orphaned by the swap and the course
    // snaps back to its template term — a second change nobody asked for.
    await call("move_course", { code: "ENGL 15", term_index: 4 });
    const r = (await call("swap_alternative", { code: "ENGL 15", alternative: "ESL 15" })) as { ok?: boolean };
    expect(r.ok, `swap_alternative did not report success: ${JSON.stringify(r)}`).toBe(true);

    expect(onDisk().moves["ESL 15"], "the swap orphaned the manual move, so the course snapped back to its template term").toBe(4);
    expect(onDisk().moves["ENGL 15"], "the outgoing code's move override was left behind").toBeUndefined();
    expect(await whereIs("ESL 15"), "the swapped-in course is not where the student had moved the old one").toBe(4);
  });

  it("carries the student's scheduling constraint across, so it still applies (#54)", async () => {
    // WORSE THAN THE ORPHANED MOVE ABOVE, because the optimiser acts on
    // it. A constraint left naming the outgoing code applies to nothing,
    // so the term the student said they could not do is free again and
    // the replacement can land in exactly it. Silently.
    await call("set_schedule_constraint", { code: "ECON 102", rule: "not-in", term_index: 1 });
    expect(
      (onDisk().constraints ?? []).map((c) => c.code),
      "the fixture's constraint was never set, so this test cannot detect losing it",
    ).toEqual(["ECON 102"]);

    const r = (await call("swap_alternative", { code: "ECON 102", alternative: "ECON 104" })) as {
      ok?: boolean; carried_over?: string;
    };
    expect(r.ok, `swap_alternative did not report success: ${JSON.stringify(r)}`).toBe(true);

    expect(
      (onDisk().constraints ?? []).map((c) => `${c.code} ${c.type} ${c.termIndex}`),
      "the constraint still names the course that left the plan, so it constrains nothing",
    ).toEqual(["ECON 104 not-in 1"]);
    // Said out loud: a constraint moving is a decision about what the
    // student meant, and they have to be able to disagree with it.
    expect(r.carried_over, "the student was not told their constraint now applies to the new course").toMatch(/ECON 104/);

    await call("optimize_schedule");
    expect(
      await whereIs("ECON 104"),
      "the optimizer put the swapped-in course in the very term the student ruled out",
    ).not.toBe(1);
  });

  it("carries a prior-credit completion across", async () => {
    // Same shape, different field. A Course marked passed by code and
    // then swapped leaves the flag pointing at something absent, so the
    // student loses credit for a course they actually took.
    await open((p) => {
      p.completed = { ...(p.completed ?? {}), "ECON 102": true };
    });
    const r = (await call("swap_alternative", { code: "ECON 102", alternative: "ECON 104" })) as {
      ok?: boolean; carried_over?: string;
    };
    expect(r.ok, `swap_alternative did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(onDisk().completed["ECON 104"], "the student lost the credit they had for this requirement").toBe(true);
    expect(onDisk().completed["ECON 102"], "a course no longer in the plan is still marked complete").toBeUndefined();
    expect(r.carried_over, "the answer did not mention the completion that followed").toMatch(/already taken/i);
  });

  it("says nothing about carrying when nothing followed the swap", async () => {
    // A note that always appears is a note nobody reads.
    const r = (await call("swap_alternative", { code: "ECON 102", alternative: "ECON 104" })) as {
      ok?: boolean; carried_over?: string;
    };
    expect(r.ok, `swap_alternative did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(r.carried_over, "a plain swap claimed something was carried over").toBeUndefined();
  });

  it("refuses a course that is not in the plan, and writes nothing", async () => {
    const before = file();
    const r = (await call("swap_alternative", { code: "ART 1", alternative: "ART 10" })) as { ok?: boolean; error?: string };
    expect(r.ok, "a swap was accepted for a course the plan does not contain").not.toBe(true);
    expect(r.error, "the refusal did not say the course is not in the plan").toMatch(/not in the plan/i);
    expect(file(), "a refused swap still wrote to the plan").toBe(before);
  });
});

describe("restoring a course that was removed", () => {
  it("puts it back with the placement the program gave it", async () => {
    const was = await whereIs("ECON 102");
    const origin = specOf("ECON 102")!.origin;
    await call("remove_course", { code: "ECON 102", user_explicitly_asked: true, student_words: SAID });
    expect(await whereIs("ECON 102"), "the removal did not take, so there is nothing to restore").toBe(-1);

    const r = (await call("restore_course", { code: "ECON 102" })) as { ok?: boolean };
    expect(r.ok, `restore_course did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(await whereIs("ECON 102"), "the restored course is not back in the plan").toBeGreaterThanOrEqual(0);
    expect(specOf("ECON 102")!.origin, "the course came back without its Origin, so it no longer counts toward the program that required it").toEqual(origin);
    expect(onDisk().removed?.["ECON 102"], "the course is back on the chart but still marked removed").toBeFalsy();
    expect(was, "the fixture never had ECON 102 in a term, so this test is not measuring a restore").toBeGreaterThanOrEqual(0);
  });

  it("brings one back that a re-optimize had already dropped from the terms", async () => {
    // The case `removedSpecs` exists for. The optimizer rebuilds the
    // term list from what is NOT removed, so by the time the student
    // asks for it back the spec is gone from every term — clearing the
    // flag alone would point at nothing and restore nothing.
    await call("remove_course", { code: "ECON 102", user_explicitly_asked: true, student_words: SAID });
    await call("optimize_schedule");
    expect(codesInPlan(), "the optimizer kept the removed course, so this is not testing a restore after a rebuild").not.toContain("ECON 102");

    const r = (await call("restore_course", { code: "ECON 102" })) as { ok?: boolean };
    expect(r.ok, `restore_course did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(await whereIs("ECON 102"), "a course removed and then optimized away could not be restored").toBeGreaterThanOrEqual(0);
    expect(specOf("ECON 102")!.origin, "the restored course lost the Origin that was preserved for exactly this").toBeTruthy();
  });

  it("is refused for a course that was never removed, and writes nothing", async () => {
    const before = file();
    const r = (await call("restore_course", { code: "CHEM 110" })) as { ok?: boolean; error?: string };
    expect(r.ok, "restoring a course that was never removed reported success").not.toBe(true);
    expect(r.error, "the refusal did not say there was nothing to restore").toMatch(/nothing to restore|not removed/i);
    expect(file(), "a refused restore still wrote to the plan").toBe(before);
  });
});

describe("un-skipping a term", () => {
  it("clears the gap and lets coursework flow back into it", async () => {
    await call("skip_term", { term_index: 3 });
    expect(onDisk().terms[3]?.gap, "skip_term did not mark the term a gap, so there is nothing to un-skip").toBe(true);

    const r = (await call("restore_term", { term_index: 3 })) as { ok?: boolean };
    expect(r.ok, `restore_term did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(onDisk().terms[3]?.gap, "the term is still marked a gap term").toBeFalsy();

    const view = (await call("get_plan")) as {
      terms: { courses: unknown[]; open_slots: unknown[] }[];
    };
    const filled = view.terms[3].courses.length + view.terms[3].open_slots.length;
    expect(filled, "the un-skipped term was left empty, so nothing re-flowed into it and graduation is still a term late").toBeGreaterThan(0);
  });

  it("loses no coursework on the way out and back", async () => {
    const before = new Set(codesInPlan());
    await call("skip_term", { term_index: 3 });
    await call("restore_term", { term_index: 3 });
    for (const code of before) {
      expect(codesInPlan(), `${code} vanished when a term was skipped and un-skipped`).toContain(code);
    }
  });

  it("is refused for a term that is not a gap term, and writes nothing", async () => {
    const before = file();
    const r = (await call("restore_term", { term_index: 2 })) as { ok?: boolean; error?: string };
    expect(r.ok, "un-skipping a term that was never skipped reported success").not.toBe(true);
    expect(r.error, "the refusal did not say the term is not a gap term").toMatch(/not a gap term/i);
    expect(file(), "a refused restore still wrote to the plan").toBe(before);
  });

  it("is refused for a term that does not exist, and writes nothing", async () => {
    const before = file();
    const r = (await call("restore_term", { term_index: 99 })) as { ok?: boolean; error?: string };
    expect(r.ok, "a term index outside the plan was accepted").not.toBe(true);
    expect(r.error, "the refusal did not say what was wrong with the term").toMatch(/term_index/);
    expect(file(), "a refused restore still wrote to the plan").toBe(before);
  });
});

/** A plan with an empty Summer 2028 spliced in at index 4 — between
 * Spring 2028 and Fall 2028, which is where the term sequence puts it.
 * Deleting it should leave exactly the fixture's own eight terms. */
const withEmptySummer = (constraintTerm?: number) => (p: PlanDoc) => {
  p.summerYears = [2028];
  p.terms.splice(4, 0, { label: "Summer 2028", items: [] });
  if (constraintTerm !== undefined) {
    p.constraints = [{ code: "ESC 409", type: "not-in", termIndex: constraintTerm }];
  }
};

/** Nine Fall/Spring terms, the third of them empty.
 *
 * DELIBERATELY NOT THE SUMMER ONE ABOVE. Deleting a summer leaves every
 * other label still correct, so it cannot tell a relabel apart from
 * doing nothing. Removing a term from the middle of a Fall/Spring run
 * means every label after it has to shift by one, which is the case
 * where leaving them alone invents a year the student never has. */
const LABELS = [
  "Fall 2026", "Spring 2027", "Fall 2027", "Spring 2028",
  "Fall 2028", "Spring 2029", "Fall 2029", "Spring 2030", "Fall 2030",
];
const withEmptyMidTerm = (p: PlanDoc) => {
  p.terms.splice(2, 0, { label: "", items: [] });
  p.terms.forEach((t, i) => { t.label = LABELS[i]; });
};

describe("deleting an empty term", () => {
  it("deletes it", async () => {
    await call("add_term");
    const n = onDisk().terms.length;
    const r = (await call("delete_term", { term_index: n - 1 })) as { ok?: boolean };
    expect(r.ok, `delete_term did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(onDisk().terms.length, "the empty term was reported deleted but is still in the plan").toBe(n - 1);
  });

  it("refuses a term with coursework in it, and names what is in the way", async () => {
    // THE CRITERION: a term with coursework in it cannot be SILENTLY
    // emptied. Deleting it would take five required courses with it and
    // report that a term was tidied up.
    const before = file();
    const r = (await call("delete_term", { term_index: 3 })) as {
      ok?: boolean; error?: string; holds?: string[]; suggestion?: string;
    };
    expect(r.ok, "a term full of required coursework was deleted").not.toBe(true);
    expect(r.error, "the refusal did not say the term still holds something").toMatch(/still holds/i);
    expect(r.holds, "the refusal did not name what the term holds").toContain("MATH 230");
    expect(r.suggestion, "the refusal did not point at skip_term, which is what was almost certainly meant").toMatch(/skip_term/);
    expect(file(), "a refused deletion still wrote to the plan").toBe(before);
  });

  it("refuses a term holding only an unfilled requirement", async () => {
    // A Slot with no Course in it is still a requirement the student
    // has to meet. A deletion that counted only courses would drop a
    // graduation requirement and call the term empty.
    await open((p) => { p.terms[2].items = p.terms[2].items.filter((i) => "slot" in i); });
    expect(onDisk().terms[2].items.length, "the crafted term holds no slot, so this proves nothing").toBeGreaterThan(0);

    const before = file();
    const r = (await call("delete_term", { term_index: 2 })) as { ok?: boolean; error?: string };
    expect(r.ok, "a term holding an unfilled requirement was deleted as though it were empty").not.toBe(true);
    expect(r.error, "the refusal did not say the term still holds something").toMatch(/still holds/i);
    expect(file(), "a refused deletion still wrote to the plan").toBe(before);
  });

  it("moves every index-keyed reference after the hole down one", async () => {
    // A constraint is stored as a term INDEX. Leaving one alone after a
    // term is removed silently re-points the student's rule at a
    // different term.
    await open(withEmptySummer(6));
    const r = (await call("delete_term", { term_index: 4 })) as { ok?: boolean };
    expect(r.ok, `delete_term did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(onDisk().constraints?.[0]?.termIndex, "a constraint after the deleted term still names its old index, so it now means a different term").toBe(5);
  });

  it("drops a constraint that named the deleted term, and says so", async () => {
    // Re-pointing it would attach "not in Summer 2028" to whatever term
    // slid into that slot. Dropping it quietly would leave the plan
    // scheduling around a rule nobody can see. So it is dropped and
    // reported.
    await open(withEmptySummer(4));
    const r = (await call("delete_term", { term_index: 4 })) as {
      ok?: boolean; constraints_dropped?: { code: string; rule: string; term: string }[];
    };
    expect(r.ok, `delete_term did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(onDisk().constraints, "a constraint was left pointing at a term that no longer exists").toEqual([]);
    expect(r.constraints_dropped, "a constraint the student set was dropped without a word").toEqual([
      { code: "ESC 409", rule: "not-in", term: "Summer 2028" },
    ]);
  });

  it("leaves a calendar that exists", async () => {
    // Labels are positional. Splicing a term out and leaving the rest
    // alone gives Fall 2026, Spring 2027, Spring 2028 — a year the
    // student reads as lost rather than as a renumbering.
    await open(withEmptyMidTerm);
    const r = (await call("delete_term", { term_index: 2 })) as { ok?: boolean };
    expect(r.ok, `delete_term did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(onDisk().terms.map((t) => t.label), "deleting a term from the middle left a calendar with a missing year in it")
      .toEqual(LABELS.slice(0, 8));
  });

  it("gives up the opted-in summer year with the summer term", async () => {
    // `summerYears` is what puts a summer into the term sequence. Left
    // set, the deleted term reappears under its own name at the next
    // relabel and the student is told twice that it is gone.
    await open(withEmptySummer());
    await call("delete_term", { term_index: 4 });
    expect(onDisk().summerYears, "the summer year survived the deletion, so the term comes back at the next relabel").toEqual([]);
    expect(onDisk().terms.map((t) => t.label), "the deleted summer term is still in the plan").not.toContain("Summer 2028");
  });

  it("refuses the last term a plan has", async () => {
    await open((p) => { p.terms = [{ label: "Fall 2026", items: [] }]; });
    const before = file();
    const r = (await call("delete_term", { term_index: 0 })) as { ok?: boolean; error?: string };
    expect(r.ok, "a plan was emptied of terms entirely").not.toBe(true);
    expect(r.error, "the refusal did not say a plan needs at least one term").toMatch(/at least one term/i);
    expect(file(), "a refused deletion still wrote to the plan").toBe(before);
  });

  it("refuses a term that does not exist, and writes nothing", async () => {
    const before = file();
    const r = (await call("delete_term", { term_index: -1 })) as { ok?: boolean; error?: string };
    expect(r.ok, "a term index outside the plan was accepted").not.toBe(true);
    expect(r.error, "the refusal did not say what was wrong with the term").toMatch(/term_index/);
    expect(file(), "a refused deletion still wrote to the plan").toBe(before);
  });
});

describe("clearing a scheduling constraint", () => {
  it("lifts it AND re-flows the schedule, the way setting one does", async () => {
    // Clearing without re-flowing leaves the course sitting where the
    // lifted rule pushed it: the student is told the rule is gone and
    // shown a plan still shaped by it.
    await call("optimize_schedule");
    const home = await whereIs("CHEM 110");
    expect(home, "CHEM 110 is not in the optimized plan, so there is nothing to constrain").toBeGreaterThanOrEqual(0);

    await call("set_schedule_constraint", { code: "CHEM 110", rule: "not-in", term_index: home });
    expect(await whereIs("CHEM 110"), "the constraint did not move the course out of the term it ruled out").not.toBe(home);

    const r = (await call("clear_schedule_constraint", { code: "CHEM 110" })) as { ok?: boolean };
    expect(r.ok, `clear_schedule_constraint did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(onDisk().constraints, "the constraint is still on the plan after being cleared").toEqual([]);
    expect(await whereIs("CHEM 110"), "the constraint was lifted but the schedule was never re-flowed, so the course is still where the rule pushed it").toBe(home);
  });

  it("clears only the rule it was given", async () => {
    await open((p) => {
      p.constraints = [
        { code: "ESC 409", type: "not-in", termIndex: 1 },
        { code: "ESC 409", type: "not-before", termIndex: 3 },
        { code: "CHEM 110", type: "not-in", termIndex: 0 },
      ];
    });
    const r = (await call("clear_schedule_constraint", { code: "ESC 409", rule: "not-in" })) as {
      ok?: boolean; cleared?: { code: string; rule: string; term: string }[];
    };
    expect(r.ok, `clear_schedule_constraint did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(
      (onDisk().constraints ?? []).map((c) => `${c.code} ${c.type}`).sort(),
      "clearing one rule took the student's other constraints with it",
    ).toEqual(["CHEM 110 not-in", "ESC 409 not-before"]);
    expect(r.cleared, "the answer did not say which constraint was lifted").toEqual([
      { code: "ESC 409", rule: "not-in", term: "Spring 2027" },
    ]);
  });

  it("clears every rule on the course when no rule is named", async () => {
    await open((p) => {
      p.constraints = [
        { code: "ESC 409", type: "not-in", termIndex: 1 },
        { code: "ESC 409", type: "not-before", termIndex: 3 },
        { code: "CHEM 110", type: "not-in", termIndex: 0 },
      ];
    });
    const r = (await call("clear_schedule_constraint", { code: "ESC 409" })) as { ok?: boolean };
    expect(r.ok, `clear_schedule_constraint did not report success: ${JSON.stringify(r)}`).toBe(true);
    expect(
      (onDisk().constraints ?? []).map((c) => c.code),
      "clearing every rule on one course touched another course's constraint",
    ).toEqual(["CHEM 110"]);
  });

  it("is refused when there is no such constraint, and writes nothing", async () => {
    await open((p) => { p.constraints = [{ code: "CHEM 110", type: "not-in", termIndex: 0 }]; });
    const before = file();
    const r = (await call("clear_schedule_constraint", { code: "ESC 409" })) as {
      ok?: boolean; error?: string; constraints?: { code: string }[];
    };
    expect(r.ok, "clearing a constraint that does not exist reported success").not.toBe(true);
    expect(r.error, "the refusal did not say there was nothing to clear").toMatch(/no scheduling constraints/i);
    expect(r.constraints?.map((c) => c.code), "the refusal did not say which constraints the plan does have").toEqual(["CHEM 110"]);
    expect(file(), "a refused clear still wrote to the plan").toBe(before);
  });

  it("refuses a rule name that is not a rule, and writes nothing", async () => {
    const before = file();
    const r = (await call("clear_schedule_constraint", { code: "CHEM 110", rule: "whenever" })) as {
      ok?: boolean; error?: string;
    };
    expect(r.ok, "an invented rule name was accepted").not.toBe(true);
    expect(r.error, "the refusal did not name the rules that exist").toMatch(/not-in, not-before, pin/);
    expect(file(), "a refused clear still wrote to the plan").toBe(before);
  });
});
