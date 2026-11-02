/** Opting a student into a summer session, and the renumbering it causes.
 *
 * THE HAZARD IS THE WHOLE TICKET (#43). Inserting a Term in the middle of
 * a Plan renumbers every Term after it, and three kinds of state are
 * keyed by Term index: a Constraint's `termIndex`, a student-added
 * Course's `sem`, and every manual move in `moves`. Every other tool on
 * this surface addresses Terms by index too.
 *
 * An insertion that remaps some of that and not the rest produces a Plan
 * where a Constraint applies to the WRONG Term. Nothing errors. The
 * student who said "no CHEM 110 in spring 2028" gets CHEM 110 in spring
 * 2028 and a refusal silently transferred to the following fall, and
 * finds out at registration a year later.
 *
 * So every test below starts from a Plan that ALREADY carries
 * Constraints, manual moves, student-added Courses and a filled Slot. A
 * test on an empty Plan proves nothing about this ticket: an empty Plan
 * has nothing to remap, so it passes with the remapping deleted.
 *
 * Everything is asserted BY LABEL, never by number. The number is
 * supposed to change; the Term it names is not.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool, loadContext, listTools, type ToolContext } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const SOURCE = path.join(here, "fixtures", "plan.json");

/** The fixture's Terms, for reference while reading the cases below:
 *
 *   0 Fall 2026 | 1 Spring 2027 | 2 Fall 2027 | 3 Spring 2028
 *   4 Fall 2028 | 5 Spring 2029 | 6 Fall 2029 | 7 Spring 2030
 *
 * Summer 2027 belongs between Spring 2027 and Fall 2027, so it lands at
 * index 2 and everything from index 2 on shifts by one. */
const SUMMER_LANDS_AT = 2;

interface StoredPlan {
  terms: { label: string; items: { id?: string; code?: string }[] }[];
  constraints?: { code: string; type: string; termIndex: number }[];
  moves: Record<string, number>;
  added: { code: string; sem: number }[];
  slotFills: Record<string, string>;
  summerYears?: number[];
  edition?: string;
}

/** A Plan with work already done to it, written as a real plan file.
 *
 * Each entry below is placed deliberately relative to the insertion
 * point: one BEFORE it (must not move), one EXACTLY AT it (must move —
 * this is the `>=` boundary, and an off-by-one here is a Constraint
 * landing on the summer itself), and ones after it. */
function planFileWithWorkAlreadyDone(): string {
  const file = JSON.parse(fs.readFileSync(SOURCE, "utf-8")) as { plan: StoredPlan };
  const plan = file.plan;

  plan.constraints = [
    // Before the insertion: Fall 2026 is Fall 2026 whatever happens later.
    { code: "CHEM 110", type: "pin", termIndex: 0 },
    // EXACTLY at it. Fall 2027 is the Term the summer is inserted in
    // front of, so this is the one an off-by-one moves onto the summer.
    { code: "PHYS 212", type: "not-in", termIndex: 2 },
    // After it, and the case the ticket's story is about.
    { code: "MATH 230", type: "not-in", termIndex: 3 },
    { code: "ESC 411", type: "not-before", termIndex: 7 },
  ];
  plan.moves = {
    "EDSGN 100": 1, // a manual move before the insertion
    "ECON 102": 2, // exactly at it
    "MATH 251": 5, // after it
    "add-CMPSC 465": 7, // a manual move OF a student-added Course
  };
  plan.added = [
    { code: "ART 1", sem: 1 }, // added before the insertion
    { code: "CMPSC 465", sem: 6 }, // added after it, and manually moved above
  ];
  // Keyed by Slot id, not by index — so this is the control: it must come
  // through the insertion untouched, and a remap that reached it would be
  // remapping too much.
  plan.slotFills = { "EL-5-4": "STAT 200" };

  return JSON.stringify(file, null, 2);
}

let planPath: string;
let ctx: ToolContext;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-summer-"));
  planPath = path.join(dir, "plan.json");
  fs.writeFileSync(planPath, planFileWithWorkAlreadyDone());
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
});

const call = (name: string, args: Record<string, unknown> = {}) =>
  executeTool(name, { based_on_revision: ctx.rev, ...args }, ctx);
const onDisk = (): StoredPlan => JSON.parse(fs.readFileSync(planPath, "utf-8")).plan;
const labels = (plan: StoredPlan) => plan.terms.map((t) => t.label);

/** WHAT EVERY PIECE OF INDEX-KEYED STATE POINTS AT, BY LABEL.
 *
 * The indexes are all expected to change; the Terms they name are not.
 * Comparing labels is the only comparison that can tell those two apart,
 * which is why nothing here asserts a number. */
function pointsAt(plan: StoredPlan): Record<string, Record<string, string>> {
  const label = (i: number) => plan.terms[i]?.label ?? `NO TERM AT INDEX ${i}`;
  return {
    constraints: Object.fromEntries(
      (plan.constraints ?? []).map((c) => [`${c.code} ${c.type}`, label(c.termIndex)]),
    ),
    moves: Object.fromEntries(Object.entries(plan.moves).map(([id, i]) => [id, label(i)])),
    added: Object.fromEntries(plan.added.map((a) => [a.code, label(a.sem)])),
  };
}

/** Where every Course sits, as the student would see it: term LABEL per
 * course code, read through `get_plan` so moves, additions and slot fills
 * are all resolved the way the chart resolves them. */
async function chart(): Promise<Record<string, string>> {
  const view = (await call("get_plan")) as { terms: { label: string; courses: { code: string }[] }[] };
  const at: Record<string, string> = {};
  for (const t of view.terms) for (const c of t.courses) at[c.code] = t.label;
  return at;
}

describe("the summer tool itself", () => {
  it("is offered, and states the revision it was computed from", () => {
    const def = listTools().find((t) => t.name === "add_summer_session");
    expect(def, "add_summer_session is not offered at all").toBeTruthy();
    const schema = def!.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required, "a write that does not name the revision it came from").toContain("based_on_revision");
    expect(schema.required, "the year is optional, so a model can ask for no summer in particular").toContain("year");
  });

  it("warns in its own description that indexes move", () => {
    // The model reads this BEFORE it calls anything. A tool that renumbers
    // the plan and says so only afterwards has already let the model plan
    // a sequence of calls against indexes that will not survive the first.
    const def = listTools().find((t) => t.name === "add_summer_session")!;
    expect(def.description, "nothing warns the model that term indexes shift").toMatch(/renumber|index/i);
  });
});

describe("adding a summer the student asked for", () => {
  it("puts it between that year's spring and fall, named as a summer", async () => {
    const r = (await call("add_summer_session", { year: 2027 })) as { ok?: boolean; term_index?: number };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(labels(onDisk()), "the summer did not land between Spring 2027 and Fall 2027").toEqual([
      "Fall 2026",
      "Spring 2027",
      "Summer 2027",
      "Fall 2027",
      "Spring 2028",
      "Fall 2028",
      "Spring 2029",
      "Fall 2029",
      "Spring 2030",
    ]);
    expect(r.term_index, "the tool reported the wrong index for the term it inserted").toBe(SUMMER_LANDS_AT);
  });

  it("records the year, so the choice survives the next re-optimize", async () => {
    // Year-keyed, not index-keyed: `optimizeSchedule` rebuilds the term
    // list from `summerYears`, and a summer recorded only as a Term in the
    // array would vanish the first time the plan was re-packed.
    await call("add_summer_session", { year: 2027 });
    expect(onDisk().summerYears, "the summer was inserted but never opted into").toEqual([2027]);
  });

  it("arrives empty, so nothing was quietly moved into it", async () => {
    const view = (await call("add_summer_session", { year: 2027 })) as {
      plan: { terms: { label: string; courses: unknown[]; open_slots: unknown[] }[] };
    };
    const summer = view.plan.terms.find((t) => t.label === "Summer 2027")!;
    expect(summer.courses, "coursework was moved into the summer nobody asked to fill").toEqual([]);
    expect(summer.open_slots, "requirements were moved into the summer nobody asked to fill").toEqual([]);
  });
});

describe("the renumbering an insertion causes", () => {
  it("LEAVES EVERY CONSTRAINT POINTING AT THE TERM IT POINTED AT BEFORE", async () => {
    // THE TEST THIS TICKET EXISTS FOR. Remove the constraint remap in
    // `add_summer_session` and this fails with "MATH 230 not-in" reading
    // Fall 2027 instead of Spring 2028 — the student's refusal silently
    // transferred to a Term they never named.
    const before = pointsAt(onDisk()).constraints;
    await call("add_summer_session", { year: 2027 });
    const after = pointsAt(onDisk()).constraints;

    expect(after, "a constraint changed which term it applies to when a summer was inserted").toEqual(before);
    // Spelled out for the two that bracket the insertion point, so a
    // failure says which direction the off-by-one went.
    expect(after["PHYS 212 not-in"], "the constraint on Fall 2027 slid onto the new summer").toBe("Fall 2027");
    expect(after["CHEM 110 pin"], "a constraint BEFORE the insertion was moved anyway").toBe("Fall 2026");
  });

  it("leaves every manual move pointing at the term it pointed at before", async () => {
    const before = pointsAt(onDisk()).moves;
    await call("add_summer_session", { year: 2027 });
    const after = pointsAt(onDisk()).moves;
    expect(after, "a course the student moved by hand ended up in a different term").toEqual(before);
    expect(after["ECON 102"], "a move landing exactly on the insertion point slid onto the summer").toBe("Fall 2027");
  });

  it("leaves every student-added course in the term it was added to", async () => {
    const before = pointsAt(onDisk()).added;
    await call("add_summer_session", { year: 2027 });
    const after = pointsAt(onDisk()).added;
    expect(after, "a course the student added moved to a different term").toEqual(before);
  });

  it("leaves the chart the student sees saying exactly what it said before", async () => {
    // The end-to-end version of the three above, resolved the way the
    // planner resolves it: template placements, manual moves, additions
    // and slot fills together. Nothing is supposed to move, because
    // inserting an empty term is not a rescheduling.
    const before = await chart();
    expect(Object.keys(before).length, "the fixture charted nothing, so this proves nothing").toBeGreaterThan(10);
    await call("add_summer_session", { year: 2027 });
    expect(await chart(), "a course changed terms when an empty summer was inserted").toEqual(before);
  });

  it("does not touch a slot fill, which is keyed by slot id rather than by index", async () => {
    // The control. A remap that reached this would be remapping state
    // that was never index-keyed, which breaks the fill just as surely.
    await call("add_summer_session", { year: 2027 });
    expect(onDisk().slotFills, "a slot fill was rewritten by a term insertion").toEqual({ "EL-5-4": "STAT 200" });
  });

  it("moves nothing at all when the summer lands at the end", async () => {
    // Summer 2035 is past the end of this plan, so it is appended and
    // NOTHING is at or after the insertion point. A remap that used `>`
    // where it should use `>=`, or vice versa, shows up here as state
    // moving when there was nothing to move.
    const before = pointsAt(onDisk());
    const r = (await call("add_summer_session", { year: 2035 })) as { ok?: boolean; note?: string };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = onDisk();
    expect(after.terms[after.terms.length - 1].label).toBe("Summer 2035");
    expect(pointsAt(after), "appending a term at the end moved index-keyed state").toEqual(before);
    expect(r.note, "the plan does not reach that summer and the answer did not say so").toMatch(/Spring 2035/);
  });
});

describe("asking for the same summer twice", () => {
  it("does not add a second one and does not remap again", async () => {
    // A MODEL RETRYING IS THE ORDINARY CASE: a timeout, a student
    // repeating themselves, a second tool call in the same turn. A second
    // remap would walk every constraint TWO terms forward — the same
    // wrong-term failure, reached by doing the right thing twice.
    await call("add_summer_session", { year: 2027 });
    const afterFirst = pointsAt(onDisk());

    const second = (await call("add_summer_session", { year: 2027 })) as {
      ok?: boolean; unchanged?: boolean; term_index?: number; revision?: number;
    };

    // The harm first, the reporting second.
    expect(labels(onDisk()).filter((l) => l === "Summer 2027"), "the summer was added twice").toHaveLength(1);
    expect(pointsAt(onDisk()), "a second call remapped a second time, two terms instead of one").toEqual(afterFirst);
    expect(onDisk().summerYears, "the year was recorded twice").toEqual([2027]);

    expect(second.ok, "a repeat call reported failure for a plan that already has what was asked for").toBe(true);
    expect(second.unchanged, "a repeat call did not say that nothing changed").toBe(true);
    expect(second.term_index, "the repeat call pointed at a different term").toBe(SUMMER_LANDS_AT);
  });

  it("does not advance the revision, because nothing was written", async () => {
    // The model chains calls on the revision it was last handed. Reporting
    // a revision the store is not at would make its NEXT change refused
    // for no reason.
    const first = (await call("add_summer_session", { year: 2027 })) as { revision?: number };
    const onDiskAfterFirst = fs.readFileSync(planPath, "utf-8");
    const second = (await call("add_summer_session", { year: 2027 })) as { revision?: number };
    expect(second.revision, "a no-op claimed a revision the store is not at").toBe(first.revision);
    expect(fs.readFileSync(planPath, "utf-8"), "a no-op rewrote the plan file").toBe(onDiskAfterFirst);
  });
});

describe("what the answer tells the model about the new shape", () => {
  it("says that every index from the insertion on has moved", async () => {
    // The model is holding term indexes from earlier calls in this same
    // conversation. An index silently reinterpreted puts a course in the
    // wrong term by the other route.
    const r = (await call("add_summer_session", { year: 2027 })) as {
      term_indexes_shifted?: { at?: number; by?: number; terms_before?: number; terms_after?: number };
      renumbering_note?: string;
    };
    expect(r.term_indexes_shifted?.at, "the answer does not say where the renumbering starts").toBe(SUMMER_LANDS_AT);
    expect(r.term_indexes_shifted?.by).toBe(1);
    expect(r.term_indexes_shifted?.terms_after).toBe((r.term_indexes_shifted?.terms_before ?? 0) + 1);
    expect(r.renumbering_note, "nothing in prose warns that held indexes are now stale").toMatch(/out of date|stale/i);
  });

  it("hands back the resulting plan, with the new indexes in it", async () => {
    const r = (await call("add_summer_session", { year: 2027 })) as {
      plan?: { terms: { index: number; label: string }[] };
    };
    const terms = r.plan?.terms;
    expect(terms, "the change did not return the plan it produced").toBeTruthy();
    expect(terms!.map((t) => t.label)[SUMMER_LANDS_AT], "the returned plan does not show the summer").toBe("Summer 2027");
    expect(terms![SUMMER_LANDS_AT].index, "the returned plan's indexes are not the new ones").toBe(SUMMER_LANDS_AT);
    expect(terms![terms!.length - 1].label).toBe("Spring 2030");
  });

  it("keeps the plan pinned to its own bulletin edition", async () => {
    // ADR 0001. A change must not re-base a student onto a different
    // bulletin, which would change which requirements apply to them.
    const was = onDisk().edition;
    const r = (await call("add_summer_session", { year: 2027 })) as { plan?: { edition?: string } };
    expect(onDisk().edition, "a summer insertion re-based the student onto a different bulletin").toBe(was);
    expect(r.plan?.edition).toBe(was);
  });
});

describe("a summer that cannot be added", () => {
  it("is refused when the change does not say what it was computed from", async () => {
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await executeTool("add_summer_session", { year: 2027 }, ctx)) as { error?: string; ok?: boolean };
    expect(r.ok, "a term was inserted without naming the revision it came from").not.toBe(true);
    expect(r.error).toMatch(/based_on_revision/);
    expect(fs.readFileSync(planPath, "utf-8"), "a refused change still wrote").toBe(before);
  });

  it("IS REFUSED on a revision the plan has moved past, and writes nothing", async () => {
    // ADR 0003. The student edited in the planner while the assistant was
    // thinking, and this change was computed against terms that have since
    // been renumbered by somebody else — the one case where applying it
    // would corrupt exactly the state this tool is careful about.
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await executeTool(
      "add_summer_session",
      { year: 2027, based_on_revision: (ctx.rev ?? 0) - 1 },
      ctx,
    )) as { ok?: boolean; stale_read?: boolean; remedy?: string };
    expect(r.ok, "a stale summer insertion landed").not.toBe(true);
    expect(r.stale_read, "the refusal was not reported as a stale read").toBe(true);
    expect(r.remedy, "the refusal named no remedy").toMatch(/get_plan/);
    expect(fs.readFileSync(planPath, "utf-8"), "a refused change still wrote").toBe(before);
  });

  it("is refused for something that is not a calendar year, and writes nothing", async () => {
    // A model reading "the summer after my junior year" and passing 3 must
    // not create "Summer 3" — a label no term sequence can place, which
    // would quietly break every later re-optimize.
    const before = fs.readFileSync(planPath, "utf-8");
    for (const nonsense of [3, 0, "next year", null, 2099]) {
      const r = (await call("add_summer_session", { year: nonsense })) as { ok?: boolean; error?: string };
      expect(r.ok, `year: ${JSON.stringify(nonsense)} was accepted`).not.toBe(true);
      expect(r.error).toMatch(/calendar year/);
    }
    expect(fs.readFileSync(planPath, "utf-8"), "a refused change still wrote").toBe(before);
  });
});

describe("showing the student the summer before they commit to it", () => {
  it("previews the insertion and writes nothing", async () => {
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await call("simulate_change", {
      change: "add_summer_session",
      arguments: { year: 2027 },
    })) as { applied?: boolean; candidate_plan?: { terms: { label: string }[] } };
    expect(r.applied, "a preview reported itself as applied").toBe(false);
    expect(
      r.candidate_plan?.terms.map((t) => t.label),
      "the preview does not show the summer it was asked about",
    ).toContain("Summer 2027");
    expect(fs.readFileSync(planPath, "utf-8"), "a preview changed the student's plan").toBe(before);
  });
});
