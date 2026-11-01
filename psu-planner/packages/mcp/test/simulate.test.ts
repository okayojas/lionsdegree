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
    expect(r.applied).toBe(false);
    expect(r.simulated).toBe(true);
    expect(String(r.nothing_changed ?? ""), "does not say the plan is untouched").toMatch(/not been|nothing|unchanged/i);
    expect(r.ok, "a simulation answered with the shape of an applied change").toBeUndefined();
    expect(r.revision, "a simulation reported a new revision").toBeUndefined();
  });

  it("says which revision it was computed from", async () => {
    const r = await simulate("add_term", {});
    expect(r.based_on_revision).toBe(ctx.rev);
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
    expect(r.added_courses).toContain("CMPSC 465");
  });

  it("names a course the change removes", async () => {
    const r = await simulate("remove_course", {
      code: "ECON 102",
      user_explicitly_asked: true,
      student_words: "I would rather not take that one",
    });
    expect(r.removed_courses).toContain("ECON 102");
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
    expect(Array.isArray(r.moved)).toBe(true);
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
    expect(onDisk()).toBe(before);
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

describe("prerequisites the change would break", () => {
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
    const conflicts = r.new_conflicts as { code: string; was: string; now: string }[];
    expect(conflicts.map((c) => c.code), "the broken prerequisite was not reported").toContain(code);
    // Both sides, so a student can see it is the change that did it.
    const broke = conflicts.find((c) => c.code === code)!;
    expect(broke.was).toBe("satisfied");
    expect(broke.now).toMatch(/not satisfied|cannot be checked/);
  });

  it("make the answer say the change does not work", async () => {
    const { r } = await pinIntoFirstTerm();
    expect(r.satisfiable, "a plan that breaks a prerequisite was presented as workable").toBe(false);
    expect(String(r.reason ?? "")).toMatch(/prerequisite/i);
  });

  it("does not report a conflict that the plan already had", async () => {
    // The fixture carries two courses whose prerequisites cannot be
    // checked at all. They were not caused by the student's question,
    // and blaming their question for them is a confident wrong answer
    // about cause — so an untouched plan must report zero.
    const r = await simulate("add_term", {});
    expect((r.new_conflicts as unknown[]).length, "appending an empty term broke a prerequisite").toBe(0);
    expect(r.satisfiable).toBe(true);
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
    expect((r.candidate_plan as { edition?: string }).edition).toBe(ctx.data.edition);
  });
});
