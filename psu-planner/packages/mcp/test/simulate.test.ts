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
