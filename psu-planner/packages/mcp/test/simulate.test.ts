/** Seeing a decision before making it.
 *
 * "What would my plan look like if I studied abroad in fall 2027?" is
 * the question a spreadsheet cannot answer for a student, and it is the
 * reason the connector is worth signing into. The answer is a complete
 * candidate plan — what moved, what it breaks — with the stored plan
 * untouched.
 *
 * TWO THINGS MAKE THIS SAFE AND THEY PULL AGAINST EACH OTHER. The
 * candidate has to be computed by the real optimiser, or it is a
 * forecast of a system that does not exist; and nothing it produces may
 * reach the student's actual plan, or "let me show you" has become "I
 * changed it". So the simulation runs the REAL mutation against a
 * sandbox copy, and the assertions below are mostly about the copy
 * staying a copy.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool, listTools, loadContext, READABLE_PLAN_TOOLS, type ToolContext } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const SOURCE = path.join(here, "fixtures", "plan.json");

let planPath: string;
let ctx: ToolContext;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-sim-"));
  planPath = path.join(dir, "plan.json");
  fs.copyFileSync(SOURCE, planPath);
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
});

const simulate = (change: string, args: Record<string, unknown> = {}) =>
  executeTool("simulate_change", { change, arguments: args }, ctx) as Promise<Record<string, unknown>>;

/** The list tool. `changes` is passed through unchecked on purpose, so
 * the shapes a confused model sends can be driven through the real
 * entry point rather than a typed stand-in for it. */
const simulateAll = (changes: unknown) =>
  executeTool("simulate_changes", { changes }, ctx) as Promise<Record<string, unknown>>;

const onDisk = () => fs.readFileSync(planPath, "utf-8");

describe("asking what a change would do", () => {
  it("returns a complete candidate plan, not a description of one", async () => {
    // A model handed "this would add a term" has to describe what it
    // believes happened. A model handed the resulting plan can read it.
    const r = await simulate("skip_term", { term_index: 3 });
    const candidate = r.candidate_plan as { terms?: { label: string; courses: unknown[] }[] };
    expect(candidate?.terms, "no candidate plan came back").toBeTruthy();
    expect(candidate.terms!.length).toBeGreaterThan(0);
    expect(candidate.terms![0]).toHaveProperty("courses");
  });

  it("leaves the stored plan BYTE-IDENTICAL", async () => {
    // THE ASSERTION THIS TICKET IS ABOUT. Everything else here is how a
    // student reads the answer; this is whether the answer cost them
    // anything.
    const before = onDisk();
    await simulate("skip_term", { term_index: 3 });
    await simulate("optimize_schedule", { target_terms: 6 });
    await simulate("add_course", { code: "CMPSC 465", term_index: 5 });
    expect(onDisk(), "a simulation changed the student's plan").toBe(before);
  });

  it("leaves the in-memory plan alone too, so the next call sees what it should", async () => {
    // The local server keeps one context for the whole session, so a
    // simulation that mutated it would leave every later answer
    // describing a change nobody applied. What stops that is the
    // separate context object the sandbox assigns onto — not the deep
    // copy of the document, which is insurance against a future
    // mutation that edits in place and which no test here can provoke.
    const before = JSON.stringify(ctx.plan);
    const terms = ctx.plan!.terms.length;
    await simulate("add_term", {});
    expect(JSON.stringify(ctx.plan), "the live plan was mutated by a simulation").toBe(before);
    expect(ctx.plan!.terms.length).toBe(terms);
    expect(ctx.items.length, "the live items were rebuilt from a simulated plan").toBeGreaterThan(0);
  });

  it("says plainly that nothing was applied", async () => {
    // A model summarising this for a student must not be able to read
    // it as "done". No `ok`, no revision it could quote as proof.
    const r = await simulate("add_term", {});
    expect(r.applied, "a simulation did not say it was unapplied").toBe(false);
    expect(r.simulated, "a simulation did not say it was one").toBe(true);
    expect(String(r.nothing_changed ?? ""), "does not say the plan is untouched").toMatch(/not been|nothing|unchanged/i);
    expect(r.ok, "a simulation answered with the shape of an applied change").toBeUndefined();
    expect(r.revision, "a simulation reported a new revision").toBeUndefined();
  });

  it("says it NOWHERE, including inside the candidate", async () => {
    // THE BUG THIS EXISTS FOR, and it was live. The sandbox commit sets
    // `rev` and `updatedAt` on the copy, so the candidate came back
    // carrying a revision that does not exist and a note reading "this
    // is the plan as it was last saved (just now)" — a save that did
    // not happen — while the top level said `applied: false`. A model
    // reads the nested object and tells the student it is saved.
    const r = await simulate("add_term", {});
    const candidate = r.candidate_plan as Record<string, unknown>;
    expect(candidate.revision, "the candidate claimed a revision").toBeUndefined();
    expect(candidate.as_of, "the candidate claimed a save time").toBeUndefined();
    expect(
      String(candidate.freshness_note ?? ""),
      "the candidate said it had been saved",
    ).not.toMatch(/last saved/i);

    // Nothing anywhere in the payload may read as a completed write.
    expect(JSON.stringify(r)).not.toMatch(/"ok":true/);
  });

  it("says which revision it was computed from", async () => {
    const r = await simulate("add_term", {});
    expect(r.based_on_revision, "the preview did not say what it was computed from").toBe(ctx.rev);
  });
});

describe("what the answer tells a student", () => {
  it("names what moved", async () => {
    // "Here is a different plan, spot the difference" is not an answer.
    const r = await simulate("skip_term", { term_index: 2 });
    const moved = r.moved as { code: string; from: string; to: string }[];
    expect(Array.isArray(moved), "no account of what moved").toBe(true);
    expect(moved.length, "skipping a term moved nothing at all").toBeGreaterThan(0);
    expect(moved[0]).toHaveProperty("code");
    expect(moved[0]).toHaveProperty("from");
    expect(moved[0]).toHaveProperty("to");
  });

  it("names a course the change adds", async () => {
    const r = await simulate("add_course", { code: "CMPSC 465", term_index: 5 });
    expect(r.added_courses, "the added course was not named").toContain("CMPSC 465");
  });

  it("names a course the change removes", async () => {
    const r = await simulate("remove_course", { code: "ECON 102" });
    expect(r.removed_courses, JSON.stringify(r)).toContain("ECON 102");
  });

  it("says how the length of the degree changes", async () => {
    const r = await simulate("skip_term", { term_index: 2 });
    expect(r.terms_before).toBe(ctx.plan!.terms.length);
    expect(typeof r.terms_after).toBe("number");
  });

  it("reports no movement as no movement, rather than inventing some", async () => {
    // Re-optimising an already-optimal plan is a legitimate question
    // with a boring answer, and the boring answer has to be available.
    const r = await simulate("optimize_schedule", {});
    expect(Array.isArray(r.moved), "no account of movement at all").toBe(true);
  });
});

describe("a change that does not work", () => {
  it("is reported as impossible, with the reason", async () => {
    // Not a candidate plan that quietly omits the course. A student
    // reading "here is your plan" assumes the thing they asked for is
    // in it.
    const r = await simulate("add_course", { code: "FAKE 999", term_index: 0 });
    expect(r.possible, "an impossible change came back as a plan").toBe(false);
    expect(String(r.reason ?? "")).toMatch(/not in/i);
    expect(r.candidate_plan, "a candidate was returned for a change that cannot happen").toBeUndefined();
  });

  it("is reported as impossible when the term does not exist", async () => {
    const r = await simulate("add_course", { code: "CMPSC 465", term_index: 99 });
    expect(r.possible).toBe(false);
    expect(String(r.reason ?? "")).toMatch(/term/i);
  });

  it("still changes nothing when it fails", async () => {
    const before = onDisk();
    await simulate("add_course", { code: "FAKE 999", term_index: 0 });
    expect(onDisk(), "a failed simulation wrote").toBe(before);
  });

  it("changes nothing on ANY path, including the ones that succeed badly", async () => {
    // BYTE-IDENTITY ACROSS THE WHOLE SURFACE, not just the happy path
    // and one failure. The interesting case is a change that COMMITS
    // inside the sandbox and produces a bad plan — the sandbox write
    // actually runs there, so if it were ever pointed at the real store
    // this is where it would land.
    const pinned = ctx.plan!.terms[4]?.items.find((i) => "code" in i && i.code)?.code as string;
    const before = onDisk();
    for (const [change, args] of [
      ["set_schedule_constraint", { code: pinned, rule: "pin", term_index: 0 }],
      ["set_schedule_constraint", { code: pinned, rule: "not-in", term_index: 1 }],
      ["remove_course", { code: pinned }],
      ["fill_slot", { slot_id: "GE-0-0", code: "CMPSC 465" }],
      ["add_term", {}],
      ["skip_term", { term_index: 2 }],
      ["optimize_schedule", { target_terms: 6 }],
      ["add_course", { code: "CMPSC 465", term_index: 5 }],
      ["add_course", { code: "FAKE 999", term_index: 0 }],
      ["skip_term", { term_index: 99 }],
    ] as [string, Record<string, unknown>][]) {
      await simulate(change, args);
      expect(onDisk(), `simulating ${change} changed the student's plan`).toBe(before);
    }
  });

  it("refuses to simulate something that is not a change at all", async () => {
    const r = await simulate("get_plan", {});
    expect(String(r.error ?? "")).toMatch(/cannot be simulated|not a change/i);
  });

  it("refuses to simulate a tool nobody has heard of", async () => {
    const r = await simulate("drop_out", {});
    expect(String(r.error ?? "")).toMatch(/cannot be simulated|not a change|unknown/i);
  });
});

describe("Violations the change would create", () => {
  /** Pinning a second-year course into the first term. In the fixture
   * that is EE 210, which goes from satisfied to not satisfied — a
   * candidate plan that still LOOKS like a plan. */
  const pinIntoFirstTerm = async () => {
    const code = ctx.plan!.terms[4]?.items.find((i) => "code" in i && i.code)?.code as string | undefined;
    if (!code) throw new Error("fixture has no course in term 4 — this test is no longer testing anything");
    return { code, r: await simulate("set_schedule_constraint", { code, rule: "pin", term_index: 0 }) };
  };

  it("are reported rather than left for the student to find", async () => {
    // THE QUIET FAILURE THIS GUARDS. A candidate that moves a course
    // ahead of its own prerequisite still reads as an answer, and the
    // student registers against it.
    const { code, r } = await pinIntoFirstTerm();
    const violations = r.new_violations as { code: string; was: string; now: string }[];
    expect(violations.map((c) => c.code), "the Violation was not reported").toContain(code);
    // Both sides, so a student can see it is the change that did it.
    const broke = violations.find((c) => c.code === code)!;
    expect(broke.was).toBe("satisfied");
    expect(broke.now).toMatch(/not satisfied|cannot be checked/);
  });

  it("make the answer say the change does not work", async () => {
    const { r } = await pinIntoFirstTerm();
    expect(r.introduces_no_problems, "a plan with a new Violation was presented as clean").toBe(false);
    expect(String(r.reason ?? "")).toMatch(/prerequisite/i);
  });

  it("does not report a Violation the plan already had", async () => {
    // The fixture carries two courses whose prerequisites cannot be
    // checked at all. They were not caused by the student's question,
    // and blaming their question for them is a confident wrong answer
    // about cause — so an untouched plan must report zero.
    const r = await simulate("add_term", {});
    expect((r.new_violations as unknown[]).length, "appending an empty term created a Violation").toBe(0);
    expect(r.introduces_no_problems, "an empty extra term was reported as a problem").toBe(true);
  });

  it("says what it measured, not that the candidate works", async () => {
    // `satisfiable: true` was a claim this cannot support. The fixture
    // plan ALREADY has courses whose prerequisites cannot be checked,
    // so a candidate derived from it was being reported as satisfiable
    // while carrying them. What is actually measured is that the change
    // introduced nothing new (ADR 0002: say what was measured).
    const r = await simulate("add_term", {});
    expect(r.satisfiable, "still claiming more than it measured").toBeUndefined();
    expect(r.introduces_no_problems).toBe(true);
  });

  it("reports a requirement the change leaves unfilled", async () => {
    // A CHANGE CAN BREAK A DEGREE WITHOUT BREAKING A PREREQUISITE.
    // Taking out a course that was filling a requirement leaves the
    // student short of graduating with every prerequisite still
    // perfectly satisfied — and a prerequisite-only check calls that
    // candidate clean.
    const slot = (await simulate("add_term", {})).candidate_plan as {
      terms: { open_slots: { slot_id: string }[] }[];
    };
    const open = slot.terms.flatMap((t) => t.open_slots)[0];
    expect(open, "the fixture has no open slot — this test is no longer testing anything").toBeTruthy();

    const filled = await simulate("fill_slot", { slot_id: open.slot_id, code: "CMPSC 465" });
    expect(filled.possible, JSON.stringify(filled)).toBe(true);
    // Filling one must not be reported as leaving one open.
    expect(
      (filled.newly_unfilled_requirements as unknown[]).length,
      "filling a requirement was reported as unfilling one",
    ).toBe(0);
  });
});

describe("previewing the removal of a required course", () => {
  const requiredCode = (): string => {
    for (const t of ctx.plan!.terms) {
      for (const i of t.items) if ("code" in i && i.code && i.origin) return i.code;
    }
    throw new Error("fixture has no template-placed course");
  };

  it("does not make the model assert the student's consent to answer a question", async () => {
    // THE SELF-DEFEATING VERSION, which is what this was. A student
    // asking "what would happen if I dropped this?" has not agreed to
    // drop it — so demanding `user_explicitly_asked` to ANSWER them
    // taught a model to set that flag on a read. The flag exists to be
    // expensive; a path that requires it routinely is a path that
    // teaches the opposite.
    const r = await simulate("remove_course", { code: requiredCode() });
    expect(r.possible, JSON.stringify(r)).toBe(true);
    expect(r.removed_courses).toContain(requiredCode());
  });

  it("says the real change will need their words", async () => {
    // The condition the preview declined to enforce has to travel with
    // the answer, or a model reads "possible: true" and finds out
    // otherwise on the call that matters.
    const r = await simulate("remove_course", { code: requiredCode() });
    expect(r.requires_consent, "the preview hid the consent requirement").toBe(true);
    expect(String(r.before_doing_this_for_real ?? "")).toMatch(/own words|student_words/);
  });

  it("does not weaken the real removal", async () => {
    // The relaxation must not have leaked out of the sandbox.
    const before = onDisk();
    const r = (await executeTool(
      "remove_course",
      { code: requiredCode(), user_explicitly_asked: true, based_on_revision: ctx.rev },
      ctx,
    )) as { needs_confirmation?: boolean };
    expect(r.needs_confirmation, "the simulation relaxation reached the real write path").toBe(true);
    expect(onDisk()).toBe(before);
  });

  it("refuses to run a simulation flag against a real store", async () => {
    // THE INVARIANT THAT MAKES THE FLAG ACCEPTABLE. It relaxes a guard,
    // which is only safe because a sandbox writes nowhere — so the
    // claim is checked rather than trusted. Loud failure beats quietly
    // dropping the one thing between a model and a requirement.
    const lying = { ...ctx, simulating: true as const };
    await expect(
      executeTool("add_term", { based_on_revision: ctx.rev }, lying),
      "a context claiming to be a simulation wrote to the student's plan",
    ).rejects.toThrow(/simulation/i);
  });
});

describe("the tool itself", () => {
  it("is offered, and counts as a read", async () => {
    expect(listTools().map((t) => t.name)).toContain("simulate_change");
    expect(READABLE_PLAN_TOOLS.has("simulate_change"), "a pure read was classified as a write").toBe(true);
  });

  it("keeps the candidate on the same Edition as the plan it came from", async () => {
    // ADR 0001. A candidate audited against a different bulletin is a
    // forecast of somebody else's degree.
    const r = await simulate("add_term", {});
    expect(
      (r.candidate_plan as { edition?: string }).edition,
      "the candidate was audited against a different bulletin",
    ).toBe(ctx.data.edition);
  });
});

/** SEVERAL CHANGES, ONE CANDIDATE (#44).
 *
 * "I want out in seven terms, I've got AP calc and transfer stats, and
 * I'd like to study abroad junior spring" is one sentence, and it is
 * five changes. The reason it cannot be five previews is that the
 * optimiser re-flows the whole plan on each one: the term the third
 * change moved a course into is a term the fourth may empty. Five
 * previews are five different futures, and the student is left to work
 * out the interaction — which is the work they asked for help with.
 */
describe("previewing several changes together", () => {
  /** Appending a term, then putting a course in THAT term.
   *
   * THE PROOF THAT THERE IS ONE SANDBOX. The second change names a term
   * index that does not exist in the stored plan and only exists
   * because the first change ran. Against a fresh copy per change — or
   * against the stored plan — it is out of range. */
  const appendThenFill = () => [
    { tool: "add_term", arguments: {} },
    { tool: "add_course", arguments: { code: "CMPSC 465", term_index: ctx.plan!.terms.length } },
  ];

  it("applies them in order to ONE copy, so each sees the one before it", async () => {
    const r = await simulateAll(appendThenFill());
    expect(r.possible, JSON.stringify(r)).toBe(true);
    expect(r.added_courses, "the second change did not see the term the first one added").toContain("CMPSC 465");
    expect(r.terms_after).toBe((r.terms_before as number) + 1);
  });

  it("is order-sensitive, which is what makes the list a list", async () => {
    // The same two changes the other way round. If this passed, the
    // order the student described would not be the order previewed,
    // and the test above would be proving nothing.
    const r = await simulateAll([...appendThenFill()].reverse());
    expect(r.possible, "a course landed in a term that did not exist yet").toBe(false);
    expect(String(r.reason ?? "")).toMatch(/term_index/);
  });

  it("returns ONE candidate plan, not one per change", async () => {
    const r = await simulateAll(appendThenFill());
    const candidate = r.candidate_plan as { terms?: { label: string; courses: unknown[] }[] };
    expect(candidate?.terms, "no candidate plan came back").toBeTruthy();
    expect(Array.isArray(r.candidate_plans), "a list of candidates came back instead of one").toBe(false);
    expect(candidate.terms!.length).toBe(ctx.plan!.terms.length + 1);
  });

  it("reports everything the single-change preview reports", async () => {
    // The acceptance criterion, field by field. A list that answered
    // with less than one change does would make the useful tool the
    // worse-informed one.
    const r = await simulateAll([
      { tool: "skip_term", arguments: { term_index: 2 } },
      { tool: "add_course", arguments: { code: "CMPSC 465", term_index: 5 } },
    ]);
    expect(r.possible, JSON.stringify(r)).toBe(true);
    expect(Array.isArray(r.moved), "no account of what moved").toBe(true);
    expect((r.moved as unknown[]).length, "skipping a term moved nothing at all").toBeGreaterThan(0);
    expect(r.added_courses, "the added course was not named").toContain("CMPSC 465");
    expect(Array.isArray(r.removed_courses), "no account of what was removed").toBe(true);
    expect(r.terms_before).toBe(ctx.plan!.terms.length);
    expect(typeof r.terms_after, "no term count after the changes").toBe("number");
    expect(Array.isArray(r.new_violations), "no account of what it breaks").toBe(true);
    expect(Array.isArray(r.newly_unfilled_requirements), "no account of what it leaves unfilled").toBe(true);
    expect(typeof r.introduces_no_problems).toBe("boolean");
    expect(r.based_on_revision, "the preview did not say what it was computed from").toBe(ctx.rev);
  });

  it("keeps the candidate on the plan's own Edition", async () => {
    // ADR 0001, and a list is where a re-base would be easiest to
    // smuggle in: several mutations, each rebuilding the terms.
    const r = await simulateAll([
      { tool: "skip_term", arguments: { term_index: 2 } },
      { tool: "optimize_schedule", arguments: { target_terms: 7 } },
    ]);
    expect(
      (r.candidate_plan as { edition?: string }).edition,
      "the candidate was audited against a different bulletin",
    ).toBe(ctx.data.edition);
  });

  it("says plainly, and everywhere, that nothing was applied", async () => {
    const r = await simulateAll(appendThenFill());
    expect(r.applied, "a preview of several changes did not say it was unapplied").toBe(false);
    expect(r.simulated, "a preview did not say it was one").toBe(true);
    expect(r.ok, "a preview answered with the shape of an applied change").toBeUndefined();
    expect(r.revision, "a preview reported a new revision").toBeUndefined();
    expect(String(r.nothing_changed ?? "")).toMatch(/not been|nothing|unchanged/i);

    // INCLUDING INSIDE THE CANDIDATE, which was a live bug for one
    // change and is worse for several: the sandbox has been committed
    // to once per change by the time the view is built.
    const candidate = r.candidate_plan as Record<string, unknown>;
    expect(candidate.revision, "the candidate claimed a revision").toBeUndefined();
    expect(candidate.as_of, "the candidate claimed a save time").toBeUndefined();
    expect(String(candidate.freshness_note ?? ""), "the candidate said it had been saved").not.toMatch(/last saved/i);
    expect(JSON.stringify(r)).not.toMatch(/"ok":true/);
  });

  it("names the calls that would make it real, in order", async () => {
    // There is deliberately no preview to apply later (#39): applying a
    // stored candidate is applying a decision made against a plan that
    // may have moved. So the answer has to say what re-running it looks
    // like, or a model invents an apply step that does not exist.
    const r = await simulateAll(appendThenFill());
    const real = r.to_make_this_real as { in_order?: string[]; note?: string };
    expect(real?.in_order, "the preview did not name the calls that would make it real").toEqual([
      "add_term",
      "add_course",
    ]);
    expect(String(real.note ?? ""), "does not say to re-read the plan first").toMatch(/get_plan/);
    expect(String(real.note ?? ""), "does not tie applying to the current revision").toMatch(/revision/i);
    expect(String(r.nothing_changed ?? ""), "the summary line names no tool to call").toMatch(/add_term/);
  });

  it("leaves the stored plan BYTE-IDENTICAL, for every list it is given", async () => {
    // THE ASSERTION THE WHOLE FEATURE RESTS ON, across every shape:
    // lists that work, lists that fail at the first change, lists that
    // fail at the last, and lists that are not lists.
    const before = onDisk();
    const required = (() => {
      for (const t of ctx.plan!.terms) for (const i of t.items) if ("code" in i && i.code && i.origin) return i.code;
      throw new Error("fixture has no template-placed course");
    })();

    for (const changes of [
      appendThenFill(),
      [{ tool: "skip_term", arguments: { term_index: 2 } }, { tool: "optimize_schedule", arguments: { target_terms: 6 } }],
      [{ tool: "remove_course", arguments: { code: required } }, { tool: "add_term", arguments: {} }],
      [
        { tool: "set_schedule_constraint", arguments: { code: "CHEM 110", rule: "not-in", term_index: 0 } },
        { tool: "fill_slot", arguments: { slot_id: "GE-0-0", code: "CMPSC 465" } },
        { tool: "add_term", arguments: {} },
      ],
      // Fails at the first change, so nothing after it runs.
      [{ tool: "add_course", arguments: { code: "FAKE 999", term_index: 0 } }, { tool: "add_term", arguments: {} }],
      // Fails at the last, so the sandbox has been committed to twice.
      [
        { tool: "add_term", arguments: {} },
        { tool: "skip_term", arguments: { term_index: 2 } },
        { tool: "add_course", arguments: { code: "FAKE 999", term_index: 0 } },
      ],
      // A stated revision that has moved on.
      [{ tool: "add_term", arguments: { based_on_revision: 9999 } }],
      // Not a change at all.
      [{ tool: "drop_out", arguments: {} }],
      // Not a list at all.
      "skip_term",
      [],
    ] as unknown[]) {
      await simulateAll(changes);
      expect(onDisk(), `simulating ${JSON.stringify(changes)} changed the student's plan`).toBe(before);
    }
  });

  it("leaves the live context alone, so the next call sees what it should", async () => {
    const before = JSON.stringify(ctx.plan);
    const rev = ctx.rev;
    await simulateAll(appendThenFill());
    expect(JSON.stringify(ctx.plan), "the live plan was mutated by a preview").toBe(before);
    expect(ctx.rev, "the live revision was advanced by a preview").toBe(rev);
  });
});

describe("a list with a change in it that cannot be made", () => {
  const stoppingList = () => [
    { tool: "skip_term", arguments: { term_index: 2 } },
    { tool: "add_course", arguments: { code: "FAKE 999", term_index: 0 } },
    { tool: "add_term", arguments: {} },
  ];

  it("stops, and names which change failed and why", async () => {
    const r = await simulateAll(stoppingList());
    expect(r.possible, "a list with an impossible change in it came back as a plan").toBe(false);
    const stopped = r.stopped_at as { index?: number; position?: string; tool?: string };
    expect(stopped?.tool, "the answer did not name the change that failed").toBe("add_course");
    expect(stopped.index, "the answer did not say where in the list it failed").toBe(1);
    expect(String(stopped.position ?? ""), "a student cannot find change 1 in their own request").toMatch(/2 of 3/);
    expect(String(r.reason ?? ""), "the answer did not say why").toMatch(/not in/i);
  });

  it("returns NO candidate, because a plan with two of three changes is one nobody asked for", async () => {
    const r = await simulateAll(stoppingList());
    expect(r.candidate_plan, "a partial candidate was returned").toBeUndefined();
    expect(r.moved, "a partial account of movement was returned").toBeUndefined();
    expect(r.terms_after, "a partial plan was described").toBeUndefined();
  });

  it("does not let the changes before it read as having happened", async () => {
    const r = await simulateAll(stoppingList());
    expect(r.applied).toBe(false);
    expect(r.ok).toBeUndefined();
    expect(r.revision).toBeUndefined();
    expect(String(r.nothing_changed ?? ""), "does not say the earlier changes went nowhere either").toMatch(
      /discarded|not been changed/i,
    );
  });

  it("refuses the whole list when one entry is not a change at all", async () => {
    const r = await simulateAll([{ tool: "add_term", arguments: {} }, { tool: "drop_out", arguments: {} }]);
    expect(String(r.error ?? "")).toMatch(/cannot be simulated/i);
    expect(String(r.error ?? ""), "the refusal did not say which entry was wrong").toMatch(/2 of 2/);
    expect(r.candidate_plan, "a candidate was built for a list containing a non-change").toBeUndefined();
  });

  it("refuses a list that is not a list, is empty, or is absurdly long", async () => {
    expect(String((await simulateAll("skip_term")).error ?? "")).toMatch(/must be a list/i);
    expect(String((await simulateAll([])).error ?? "")).toMatch(/empty|nothing/i);
    const many = Array.from({ length: 21 }, () => ({ tool: "add_term", arguments: {} }));
    expect(String((await simulateAll(many)).error ?? ""), "an unbounded list was accepted").toMatch(/at most/i);
  });

  it("refuses an entry whose arguments are not arguments", async () => {
    // Not repaired into something plausible. Guessing what a malformed
    // entry meant is this server deciding what the model meant, which
    // is the same mistake as deciding what a student meant.
    const r = await simulateAll([{ tool: "add_term", arguments: "all of them" }]);
    expect(String(r.error ?? "")).toMatch(/not an object/i);
  });
});

describe("a list computed from a plan that has moved on", () => {
  it("is refused rather than previewed", async () => {
    // A student must never be shown a candidate built on a plan that is
    // no longer theirs. The preview writes nothing, so nothing is lost
    // — but they would act on it.
    const r = await simulateAll([
      { tool: "add_term", arguments: { based_on_revision: ctx.rev } },
      { tool: "skip_term", arguments: { term_index: 2, based_on_revision: 9999 } },
    ]);
    expect(r.possible, "a preview was built from a revision the plan is not at").toBe(false);
    expect(r.candidate_plan).toBeUndefined();
    expect((r.stopped_at as { index?: number })?.index, "the refusal did not name the stale entry").toBe(1);
    expect(String(r.reason ?? "")).toMatch(/revision/i);
    expect(String(r.remedy ?? "")).toMatch(/get_plan/);
  });

  it("says the whole list shares one revision, so a model stops chaining them", async () => {
    // A model that has learned to chain mutations will pass rev, rev+1,
    // rev+2 — which are the sandbox's own bookkeeping and nothing a
    // student's plan was ever at. Refusing without explaining that
    // produces a model that retries the same wrong numbers.
    const r = await simulateAll([
      { tool: "add_term", arguments: { based_on_revision: ctx.rev } },
      { tool: "add_term", arguments: { based_on_revision: (ctx.rev ?? 0) + 1 } },
    ]);
    expect(r.possible).toBe(false);
    expect(String(r.remedy ?? ""), "the refusal did not explain the one-revision rule").toMatch(
      /same reading|same revision/i,
    );
  });

  it("previews happily when every change states the revision the plan IS at", async () => {
    const r = await simulateAll([
      { tool: "add_term", arguments: { based_on_revision: ctx.rev } },
      { tool: "skip_term", arguments: { term_index: 2, based_on_revision: ctx.rev } },
    ]);
    expect(r.possible, JSON.stringify(r)).toBe(true);
  });
});

describe("removing a required course somewhere in a list", () => {
  const requiredCode = (): string => {
    for (const t of ctx.plan!.terms) {
      for (const i of t.items) if ("code" in i && i.code && i.origin) return i.code;
    }
    throw new Error("fixture has no template-placed course");
  };

  it("is previewable without the model asserting the student's consent", async () => {
    const r = await simulateAll([
      { tool: "add_term", arguments: {} },
      { tool: "remove_course", arguments: { code: requiredCode() } },
    ]);
    expect(r.possible, JSON.stringify(r)).toBe(true);
    expect(r.removed_courses).toContain(requiredCode());
  });

  it("still warns that the real change needs their words, even when it is not the first change", async () => {
    // The single-change version asked this of the ORIGINAL plan and of
    // the one change it had. A list has to ask it of the plan as it
    // stands when that change is reached, or the warning goes missing
    // on exactly the request most likely to contain it.
    const r = await simulateAll([
      { tool: "add_term", arguments: {} },
      { tool: "remove_course", arguments: { code: requiredCode() } },
    ]);
    expect(r.requires_consent, "the preview hid the consent requirement").toBe(true);
    expect(r.consent_needed_for, "the preview did not say which course needs consent").toContain(requiredCode());
    expect(String(r.before_doing_this_for_real ?? "")).toMatch(/own words|student_words/);
  });

  it("says nothing about consent when nothing required is being removed", async () => {
    const r = await simulateAll([{ tool: "add_term", arguments: {} }]);
    expect(r.requires_consent, "a harmless list demanded consent").toBeUndefined();
  });
});

describe("the single-change tool is the one-element case", () => {
  it("answers identically to a list of one", async () => {
    // NOT A SECOND IMPLEMENTATION. Two preview paths would eventually
    // disagree about what the same change does, and a bug fixed in one
    // would survive in the other.
    const asOne = await simulate("skip_term", { term_index: 2 });
    const asList = await simulateAll([{ tool: "skip_term", arguments: { term_index: 2 } }]);
    expect(JSON.stringify(asList), "the two tools describe the same change differently").toBe(
      JSON.stringify(asOne),
    );
  });

  it("answers identically when the change cannot be made", async () => {
    const asOne = await simulate("add_course", { code: "FAKE 999", term_index: 0 });
    const asList = await simulateAll([{ tool: "add_course", arguments: { code: "FAKE 999", term_index: 0 } }]);
    expect(JSON.stringify(asList), "the two tools refuse the same change differently").toBe(JSON.stringify(asOne));
  });

  it("keeps the field a single-change caller already reads", async () => {
    // `changes` is always there, because a list of one is still a list.
    // Dropping `change` would take a field away from callers who did
    // nothing wrong.
    const r = await simulate("add_term", {});
    expect(r.change, "the single-change answer lost its own field").toEqual({ tool: "add_term", arguments: {} });
    expect(r.changes).toEqual([{ tool: "add_term", arguments: {} }]);
  });

  it("does not claim a single change is several", async () => {
    const r = await simulate("add_term", {});
    expect(String(r.nothing_changed ?? ""), "a one-change preview talked about changes").not.toMatch(/these \d+/);
  });
});

describe("the list tool itself", () => {
  it("is offered, and counts as a read", async () => {
    expect(listTools().map((t) => t.name)).toContain("simulate_changes");
    expect(READABLE_PLAN_TOOLS.has("simulate_changes"), "a pure read was classified as a write").toBe(true);
  });

  it("takes named changes with explicit arguments, never a sentence", async () => {
    // THE GOVERNING PRINCIPLE (#39), asserted against the advertised
    // schema: the model interprets, the engine computes. A field here
    // that took free text would be this server deciding what a student
    // meant, and the first version of it would look harmless.
    const def = listTools().find((t) => t.name === "simulate_changes")!;
    const schema = def.inputSchema as {
      properties: { changes: { items: { properties: Record<string, unknown>; required?: string[] } } };
    };
    const fields = Object.keys(schema.properties.changes.items.properties).sort();
    expect(fields, "a change carries something other than a tool and its arguments").toEqual([
      "arguments",
      "tool",
    ]);
    expect(schema.properties.changes.items.required).toContain("tool");
  });
});
