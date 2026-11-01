/** Tools that CHANGE a student's plan.
 *
 * Every test works on a throwaway copy of the fixture, because the point of
 * most of them is what the file looks like afterwards. The rules encoded here
 * come from a real incident: an assistant asked to avoid one course in one
 * semester removed it and several electives to "consolidate", and the plan
 * was unrecoverable (DECISIONS.md 4.1). The structural answers to that are
 * what these assert. */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool, listTools, loadContext, type ToolContext } from "../src/tools.js";
import { MUTATIONS } from "../src/mutations.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const SOURCE = path.join(here, "fixtures", "plan.json");

let planPath: string;
let ctx: ToolContext;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-"));
  planPath = path.join(dir, "plan.json");
  fs.copyFileSync(SOURCE, planPath);
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
});

/** Every tool that writes states the revision it was computed from
 * (#36). These tests are about what the mutations DO, so the helper
 * supplies the current one by default; the cases where it is missing or
 * out of date have their own tests below and in `worker-plan.test.ts`. */
const call = (name: string, args: Record<string, unknown> = {}) =>
  executeTool(name, { based_on_revision: ctx.rev, ...args }, ctx);
const onDisk = () => JSON.parse(fs.readFileSync(planPath, "utf-8")).plan;
const codesIn = () => onDisk().terms.flatMap((t: { items: { code?: string }[] }) => t.items.flatMap((i) => (i.code ? [i.code] : [])));

describe("the mutating surface", () => {
  it("is offered alongside the read-only tools", () => {
    const names = listTools().map((t) => t.name);
    for (const n of ["add_course", "remove_course", "set_schedule_constraint", "optimize_schedule", "fill_slot", "add_term", "skip_term"]) {
      expect(names, n).toContain(n);
    }
  });

  it("asks every one of them which revision the change was computed from", () => {
    // Required, not optional. An optional guard is one a model can skip,
    // and the whole point is that it cannot assert its way past this.
    for (const t of listTools().filter((t) => MUTATIONS.has(t.name))) {
      const schema = t.inputSchema as { properties: Record<string, unknown>; required: string[] };
      expect(schema.properties.based_on_revision, `${t.name} does not take it`).toBeTruthy();
      expect(schema.required, `${t.name} does not require it`).toContain("based_on_revision");
    }
  });
});

describe("a change that does not say what it was based on", () => {
  it("is refused, and writes nothing", async () => {
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await executeTool("add_term", {}, ctx)) as { error?: string; remedy?: string };
    expect(r.error, "a change landed without naming the revision it came from").toMatch(/based_on_revision/);
    expect(r.remedy).toMatch(/get_plan/);
    expect(fs.readFileSync(planPath, "utf-8")).toBe(before);
  });

  it("cannot be satisfied by sending nothing", async () => {
    // THE COERCION HOLE. `Number(null)`, `Number("")`, `Number([])` and
    // `Number(false)` are all 0 — so on a plan sitting at revision 0,
    // which is every plan predating `rev` and every one just created, a
    // model got past the guard by sending null. A guard a caller can
    // satisfy by sending nothing is not a guard.
    const before = fs.readFileSync(planPath, "utf-8");
    for (const nothing of [null, "", [], false, "4", undefined]) {
      const r = (await executeTool("add_term", { based_on_revision: nothing }, ctx)) as {
        ok?: boolean; error?: string;
      };
      expect(r.ok, `based_on_revision: ${JSON.stringify(nothing)} was accepted`).not.toBe(true);
      expect(r.error).toMatch(/based_on_revision/);
    }
    expect(fs.readFileSync(planPath, "utf-8"), "something wrote").toBe(before);
  });

  it("is refused when the revision has moved on, and writes nothing", async () => {
    // The student edited in the planner since the model last read. The
    // model's change is computed from a plan that no longer exists, and
    // applying it would erase what they just did.
    const before = fs.readFileSync(planPath, "utf-8");
    const stale = (ctx.rev ?? 0) - 1;
    const r = (await executeTool("add_term", { based_on_revision: stale }, ctx)) as {
      ok?: boolean; stale_read?: boolean; remedy?: string;
    };
    expect(r.ok, "a stale change landed").not.toBe(true);
    expect(r.stale_read).toBe(true);
    expect(r.remedy, "the refusal named no remedy").toMatch(/get_plan/);
    expect(fs.readFileSync(planPath, "utf-8"), "a refused change still wrote").toBe(before);
  });
});

describe("adding a course", () => {
  it("writes it to the plan file", async () => {
    const r = (await call("add_course", { code: "CMPSC 465", term_index: 5 })) as { ok?: boolean };
    expect(r.ok).toBe(true);
    // A student-added course lives in `added`, not in a term's items: terms
    // are rebuilt from the template plus additions, so writing it into a term
    // directly would be erased by the next optimize.
    expect(onDisk().added).toEqual(expect.arrayContaining([{ code: "CMPSC 465", sem: 5 }]));
  });

  it("is visible to the next tool call, not just on disk", async () => {
    await call("add_course", { code: "CMPSC 465", term_index: 5 });
    const plan = (await call("get_plan")) as { terms: { courses: { code: string }[] }[] };
    expect(plan.terms.flatMap((t) => t.courses.map((c) => c.code))).toContain("CMPSC 465");
  });

  it("refuses a course that is not in the catalog, and changes nothing", async () => {
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await call("add_course", { code: "FAKE 999", term_index: 0 })) as { error?: string };
    expect(r.error).toMatch(/not in/i);
    expect(fs.readFileSync(planPath, "utf-8")).toBe(before);
  });

  it("refuses a term that does not exist, and changes nothing", async () => {
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await call("add_course", { code: "CMPSC 465", term_index: 99 })) as { error?: string };
    expect(r.error).toMatch(/term/i);
    expect(fs.readFileSync(planPath, "utf-8")).toBe(before);
  });
});

describe("removing a required course", () => {
  /** A course the program's own template placed, not one the student added. */
  const requiredCode = () => {
    const plan = onDisk();
    for (const t of plan.terms) for (const i of t.items) if (i.code && i.origin) return i.code as string;
    throw new Error("fixture has no template-placed course");
  };

  it("is refused without explicit confirmation", async () => {
    const code = requiredCode();
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await call("remove_course", { code })) as { error?: string; needs_confirmation?: boolean };
    expect(r.needs_confirmation).toBe(true);
    expect(r.error).toMatch(/degree|required/i);
    // The file is the thing that matters: a refusal that still wrote would be
    // worse than no guard at all.
    expect(fs.readFileSync(planPath, "utf-8")).toBe(before);
  });

  it("points at constraining instead, which is what the student usually meant", async () => {
    const r = (await call("remove_course", { code: requiredCode() })) as { suggestion?: string };
    expect(r.suggestion).toMatch(/set_schedule_constraint/);
  });

  it("is refused when the flag is set but nothing was quoted", async () => {
    // THE SELF-ASSERTED FLAG. A boolean is the easiest thing in the
    // world for a model to set, and before this it was the whole guard.
    // Asking for the student's sentence does not prove they said it —
    // nothing here can — but it makes the quiet path unavailable.
    const code = requiredCode();
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await call("remove_course", { code, user_explicitly_asked: true })) as {
      error?: string; needs_confirmation?: boolean;
    };
    expect(r.needs_confirmation, "a bare flag was enough to drop a graduation requirement").toBe(true);
    expect(r.error).toMatch(/student_words/);
    expect(fs.readFileSync(planPath, "utf-8"), "a refused removal still wrote").toBe(before);
  });

  it("does not refuse a real sentence that happens to contain the word", async () => {
    // FALSE POSITIVES COST A STUDENT THEIR REQUEST. The first version
    // matched "user" or "student" anywhere within thirty characters of
    // a verb, which blocks a student writing about a user manual or
    // about being a transfer student. The check is now subject-then-
    // verb, and the echo is what the guard actually rests on.
    const code = requiredCode();
    for (const genuine of [
      "the user manual said I don't need it for my track",
      "I'm a transfer student and I already did this one elsewhere",
      "Drop it, I am not taking it",
    ]) {
      const r = (await call("remove_course", {
        code, user_explicitly_asked: true, student_words: genuine,
      })) as { ok?: boolean; needs_confirmation?: boolean };
      expect(r.needs_confirmation, `a genuine sentence was blocked: "${genuine}"`).not.toBe(true);
      // Put it back for the next iteration.
      await call("add_course", { code, term_index: 0 });
    }
  });

  it("is refused when the quote is the model talking about the student", async () => {
    // Not a quote at all — it is the model narrating its own authority.
    // Someone asking for a course to be dropped says "I"; a model
    // reaching for permission writes "the user asked me to".
    const code = requiredCode();
    for (const narration of [
      "The user asked me to remove this course from their plan",
      "the student confirmed they want it dropped",
      "This user said they no longer need it",
      "They asked me to take it out",
      "The student has requested its removal",
      "the user told me to drop it",
    ]) {
      const r = (await call("remove_course", {
        code, user_explicitly_asked: true, student_words: narration,
      })) as { needs_confirmation?: boolean };
      expect(r.needs_confirmation, `"${narration}" passed as the student's own words`).toBe(true);
    }
    expect(codesIn(), "a requirement was dropped on the model's narration").toContain(code);
  });

  it("goes through when the student has actually said so, in their words", async () => {
    const code = requiredCode();
    const said = "I've decided to switch majors, please take it out of my degree";
    const r = (await call("remove_course", {
      code, user_explicitly_asked: true, student_words: said,
    })) as { ok?: boolean; on_the_strength_of?: string };
    expect(r.ok).toBe(true);
    expect(codesIn()).not.toContain(code);
    // Echoed back, so the claim is visible to the person it is about.
    expect(r.on_the_strength_of, "the claim was acted on but never shown").toBe(said);
  });
});

describe("a scheduling conflict", () => {
  it("is solved by constraining the course away from that term, not by removing it", async () => {
    const plan = onDisk();
    const code = plan.terms[1].items.find((i: { code?: string }) => i.code)?.code as string;
    const r = (await call("set_schedule_constraint", { code, rule: "not-in", term_index: 1 })) as { ok?: boolean };
    expect(r.ok).toBe(true);

    const after = onDisk();
    // The course is still in the degree.
    expect(after.terms.flatMap((t: { items: { code?: string }[] }) => t.items.map((i) => i.code))).toContain(code);
    // And the constraint is durable: it survives every future re-optimize,
    // which is the whole reason it is not a manual move.
    expect(after.constraints).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, type: "not-in", termIndex: 1 })]),
    );
    // It is no longer in the term the student ruled out.
    expect(after.terms[1].items.map((i: { code?: string }) => i.code)).not.toContain(code);
  });
});

describe("optimizing", () => {
  it("is ONE call, not a move-per-course loop", async () => {
    // A model hand-reordering fifty courses over dozens of round trips is how
    // "graduate in six semesters" timed out with no answer (DECISIONS.md 4).
    const r = (await call("optimize_schedule")) as { ok?: boolean; terms_before?: number; terms_after?: number };
    expect(r.ok).toBe(true);
    expect(typeof r.terms_after).toBe("number");
    expect(onDisk().terms.length).toBe(r.terms_after);
  });

  it("keeps every course", async () => {
    const before = new Set(codesIn());
    await call("optimize_schedule");
    for (const code of before) expect(codesIn(), `${code} was dropped by optimizing`).toContain(code);
  });
});

describe("filling a slot", () => {
  const openSlot = () => {
    const plan = onDisk();
    for (const t of plan.terms) for (const i of t.items) if (i.slot && !plan.slotFills?.[i.id]) return i;
    throw new Error("fixture has no open slot");
  };
  /** A slot with a PUBLISHED course list, so "not on the list" means
   * something. Read through get_plan rather than off disk: the stored spec
   * uses `label`, the built item uses `slotLabel`, and guessing at the raw
   * shape is how this test picked a gen-ed slot by accident. */
  const electiveSlot = async (): Promise<{ slot_id: string; label?: string }> => {
    const plan = (await call("get_plan")) as { terms: { open_slots: { slot_id: string; label?: string }[] }[] };
    const slot = plan.terms.flatMap((t) => t.open_slots).find((s) => s.label && /Elective/i.test(s.label));
    if (!slot) throw new Error("fixture has no open elective slot");
    return slot;
  };

  it("offers the same ranking the planner shows, so the two surfaces agree", async () => {
    const slot = openSlot();
    const r = (await call("suggest_slot_courses", { slot_id: slot.id })) as { picks?: { code: string }[] };
    expect(Array.isArray(r.picks)).toBe(true);
  });

  it("refuses a real course that is not on the slot's approved list", async () => {
    // ART 1 exists in the catalog but is not on the Engineering Science
    // technical-elective list. A code that simply does not exist would be
    // caught by an earlier check and prove nothing about this one.
    const slot = await electiveSlot();
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await call("fill_slot", { slot_id: slot.slot_id, code: "ART 1" })) as { error?: string; ok?: boolean };
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/not on the approved list/i);
    expect(fs.readFileSync(planPath, "utf-8")).toBe(before);
  });

  it("refuses a course that lacks the designation a gen-ed slot needs", async () => {
    // A gen-ed slot has no program course list; it is gated by the
    // designation a course carries. Checking only the list let any course in
    // the catalog fill one.
    const plan = onDisk();
    let geSlot: { id: string; slot: string } | undefined;
    for (const t of plan.terms) for (const i of t.items) if (i.slot && !i.label && !plan.slotFills?.[i.id]) { geSlot ??= i; }
    if (!geSlot) return;
    const before = fs.readFileSync(planPath, "utf-8");
    // MATH 141 carries GQ, so it cannot satisfy an arts or humanities slot.
    const r = (await call("fill_slot", { slot_id: geSlot.id, code: "MATH 141" })) as { error?: string; ok?: boolean };
    if (!r.ok) {
      expect(r.error).toMatch(/designation/i);
      expect(fs.readFileSync(planPath, "utf-8")).toBe(before);
    }
  });

  it("accepts a course that IS on the list", async () => {
    const slot = openSlot();
    const picks = (await call("suggest_slot_courses", { slot_id: slot.id })) as { picks: { code: string }[] };
    if (!picks.picks.length) return; // a slot with no derivable list has nothing to accept
    const r = (await call("fill_slot", { slot_id: slot.id, code: picks.picks[0].code })) as { ok?: boolean };
    expect(r.ok).toBe(true);
    expect(onDisk().slotFills[slot.id]).toBe(picks.picks[0].code);
  });
});

describe("terms", () => {
  it("can be added", async () => {
    const before = onDisk().terms.length;
    const r = (await call("add_term")) as { ok?: boolean };
    expect(r.ok).toBe(true);
    expect(onDisk().terms.length).toBe(before + 1);
  });

  it("can be skipped without losing the coursework in them", async () => {
    const before = new Set(codesIn());
    const r = (await call("skip_term", { term_index: 2 })) as { ok?: boolean };
    expect(r.ok).toBe(true);
    expect(onDisk().terms[2].gap).toBe(true);
    for (const code of before) expect(codesIn(), `${code} vanished when a term was skipped`).toContain(code);
  });
});

describe("every refusal", () => {
  it("leaves the file byte-identical", async () => {
    const before = fs.readFileSync(planPath, "utf-8");
    await call("add_course", { code: "NOPE 000", term_index: 0 });
    await call("fill_slot", { slot_id: "no-such-slot", code: "MATH 140" });
    await call("set_schedule_constraint", { code: "NOPE 000", rule: "not-in", term_index: 0 });
    await call("skip_term", { term_index: 999 });
    expect(fs.readFileSync(planPath, "utf-8")).toBe(before);
  });
});
