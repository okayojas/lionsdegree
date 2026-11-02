/** Declaring a Program from the chat (#47).
 *
 * "Add a math minor" is the thing a student most often wants from an
 * assistant that can see their plan, and until this ticket the connector
 * could describe a Program in detail and not add it. #46 built the engine
 * merge and wired the planner's own menu to it; this is the half that
 * lets the assistant reach the same function.
 *
 * THE POINT OF KEEPING IT SEPARATE was that it cannot be built first. A
 * connector that merged Programs its website could not would be writing
 * Plans a student cannot reproduce, inspect or undo in the browser — and
 * "the assistant did something to my degree and the planner does not
 * know how" is the single worst failure available to this project.
 *
 * So what is tested here is the CONNECTOR's half: that the slug a model
 * supplies is resolved against the student's own Edition and not guessed,
 * that the student's work survives, that dropping a Program needs their
 * own words, and that the answer carries enough for an assistant to say
 * what actually changed rather than what it meant to change. The merge
 * itself is an engine property and is tested at the engine, against a
 * Plan carrying completed Courses, additions, filled Slots and
 * Constraints (#46); observing it again through two layers of transport
 * would be observing transport.
 *
 * The hosted half is in `worker-program-declare.test.ts`, which runs the
 * same calls through `fetch(Request, Env)`. The local one working has
 * never been evidence about the hosted one.
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

/** A Program that publishes REQUIREMENTS AND NO GRID, which is most
 * minors and certificates, and the case a student actually asks for. Its
 * prescribed courses are MATH 140 and MATH 141 — one the fixture has
 * already completed and one it already schedules, so this single slug
 * exercises the two things a merge must not get wrong. */
const MATH_MINOR = "eberly-science-mathematics-minor";
/** A Program that publishes a term-by-term GRID, so the other path is
 * covered: a second major folded into existing Terms. */
const STATS_MAJOR = "eberly-science-statistics-bs";
const ESC = "engineering-engineering-science-bs";

let planPath: string;
let ctx: ToolContext;

async function open(edit: (plan: PlanDoc) => void = () => {}): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-programs-"));
  planPath = path.join(dir, "plan.json");
  const file = JSON.parse(JSON.stringify(FIXTURE)) as { plan: PlanDoc };
  edit(file.plan);
  fs.writeFileSync(planPath, JSON.stringify(file));
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
}

beforeEach(() => open());

const call = (name: string, args: Record<string, unknown> = {}) =>
  executeTool(name, { based_on_revision: ctx.rev, ...args }, ctx);

const file = () => fs.readFileSync(planPath, "utf-8");
const onDisk = (): PlanDoc => JSON.parse(file()).plan;
const codesInPlan = (): string[] =>
  onDisk().terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));

/** A sentence a student could plausibly have said. Deliberately not model
 * narration — `consentProblem` rejects that, and it should. */
const SAID = "i've decided the math minor isn't worth it, please take it off my degree";

describe("declaring a program", () => {
  it("adds it to the plan", async () => {
    const r = (await call("add_program", { slug: MATH_MINOR })) as {
      ok?: boolean; added_program?: string; programs?: string[]; program_name?: string;
    };
    expect(r.ok, `add_program did not report success: ${JSON.stringify(r).slice(0, 300)}`).toBe(true);
    expect(onDisk().programs, "the program is not on the stored plan").toContain(MATH_MINOR);
    expect(onDisk().programs, "declaring a minor dropped the student's major").toContain(ESC);
    expect(r.program_name, "the answer does not name the program in words a student would recognise").toMatch(/Mathematics/i);
  });

  it("does not reset the student's completed courses", async () => {
    // The failure this guards is the one #46 was filed for: before it,
    // the only way to change which Programs a Plan was for was to start
    // over, and starting over cost two years of recorded progress.
    expect(FIXTURE.plan.completed["MATH 140"], "the fixture records no completed course, so this proves nothing").toBe(true);
    await call("add_program", { slug: MATH_MINOR });
    expect(onDisk().completed["MATH 140"], "a completed course was reset by declaring a minor").toBe(true);
    expect(onDisk().completed["ENGL 015"], "a completed course was reset by declaring a minor").toBe(true);
  });

  it("reports a prescribed course the student has already taken instead of scheduling it again", async () => {
    // MATH 140 is prescribed by the minor AND already passed. Putting it
    // back on the chart would tell a student to retake calculus.
    const r = (await call("add_program", { slug: MATH_MINOR })) as {
      already_completed?: string[]; courses_added?: string[];
    };
    expect(r.already_completed, "the answer does not say which of the new requirements are already met").toContain("MATH 140");
    expect(r.courses_added ?? [], "a course the student has already passed was scheduled again").not.toContain("MATH 140");
    expect(
      codesInPlan().filter((c) => c === "MATH 140"),
      "the plan now schedules a course the student completed two years ago",
    ).toEqual([]);
  });

  it("counts a course both programs require once, and says so", async () => {
    // The double major's honesty. MATH 141 is in the plan already because
    // Engineering Science requires it; the minor requires it too.
    expect(codesInPlan(), "the fixture does not already schedule MATH 141, so sharing cannot be observed").toContain("MATH 141");
    const r = (await call("add_program", { slug: MATH_MINOR })) as { courses_already_in_plan?: string[] };
    expect(r.courses_already_in_plan, "the answer does not name the requirement the two programs share").toContain("MATH 141");
    expect(
      codesInPlan().filter((c) => c === "MATH 141"),
      "a shared requirement was scheduled twice, so the student is told to take it again",
    ).toHaveLength(1);
  });

  it("says plainly when the program publishes no term-by-term grid", async () => {
    // Most minors and certificates publish none. A student told "added"
    // who then sees no new courses in their first two years would
    // reasonably conclude it had not worked.
    const r = (await call("add_program", { slug: MATH_MINOR })) as { placement?: string };
    expect(r.placement, "nothing explains why a minor added no term-by-term sequence").toMatch(/no suggested-plan grid/i);
  });

  it("folds a second major's own grid into the terms the student already has", async () => {
    // The other path: a Program that DOES publish a grid. Its courses have
    // to land among the terms the student already has, not all after them,
    // or the result is not a plan anybody follows.
    //
    // NOT "the term count is unchanged", which is what the engine test
    // asserts against a freshly generated plan. A second full major does
    // not fit in this student's eight terms under a 19-credit cap, so the
    // optimizer extends it — correctly, and saying otherwise would be
    // asserting that a 34-course plan fits where it does not. What is
    // actually at stake is WHERE the new work goes.
    const before = onDisk().terms.length;
    const r = (await call("add_program", { slug: STATS_MAJOR })) as {
      ok?: boolean; courses_added?: string[]; placement?: string;
    };
    expect(r.ok, `add_program did not report success: ${JSON.stringify(r).slice(0, 300)}`).toBe(true);
    expect(r.courses_added?.length, "a second major with a published grid added no courses at all").toBeGreaterThan(0);
    expect(r.placement, "a program WITH a grid was described as having none").toBeUndefined();

    const after = onDisk();
    const addedTerms = after.terms
      .map((t, i) => (t.items.some((x) => "code" in x && r.courses_added!.includes(x.code)) ? i : -1))
      .filter((i) => i >= 0);
    expect(addedTerms.length, "the second major's courses are in no term at all").toBeGreaterThan(1);
    expect(
      Math.min(...addedTerms),
      `every one of the second major's courses landed at or after term ${before} — it was appended, not folded`,
    ).toBeLessThan(before / 2);
  });

  it("returns the resulting plan, not just what it intended", async () => {
    // So the assistant can tell the student what actually changed. An
    // answer that only echoes the request is one a model fills in from
    // its own expectations.
    const r = (await call("add_program", { slug: MATH_MINOR })) as {
      plan?: { terms?: unknown[]; edition?: string }; revision?: number;
    };
    expect(r.plan?.terms?.length, "no plan came back, so the assistant can only describe its own intent").toBeGreaterThan(0);
    expect(r.revision, "the answer does not say which revision the plan is now at").toBe(FIXTURE.plan.rev + 1);
  });

  it("keeps the plan pinned to its own edition", async () => {
    // ADR 0001. Re-basing a continuing student onto the newest bulletin
    // is the exact failure that ADR forbids, and a merge is where it
    // would happen without anybody noticing.
    await call("add_program", { slug: MATH_MINOR });
    expect(onDisk().edition, "declaring a program re-based the plan onto another bulletin edition").toBe(
      FIXTURE.plan.edition,
    );
  });
});

describe("declaring a program that cannot be declared", () => {
  it("refuses a slug this edition does not publish, and names what it does", async () => {
    // A model that found nothing invents a plausible program. The refusal
    // has to close the gap it would otherwise fill from memory.
    const before = file();
    const r = (await call("add_program", { slug: "quantum-sorcery-minor" })) as {
      ok?: boolean; error?: string; did_you_mean?: unknown[]; editions_this_connector_carries?: string[];
    };
    expect(r.ok, "a program that does not exist was added to a student's degree").not.toBe(true);
    expect(r.error, "the refusal does not say which bulletin was searched").toMatch(/bulletin/i);
    expect(r.editions_this_connector_carries, "the refusal does not say which editions are held").toBeTruthy();
    expect(file(), "a refused declaration still wrote to the plan").toBe(before);
  });

  it("says a program the plan already has is already there, without taking a revision", async () => {
    const before = file();
    const r = (await call("add_program", { slug: ESC })) as { ok?: boolean; error?: string; programs?: string[] };
    expect(r.ok).not.toBe(true);
    expect(r.error, "the refusal does not say the program is already on the plan").toMatch(/already one of/i);
    expect(r.programs, "the refusal does not say what the plan's programs actually are").toContain(ESC);
    expect(file(), "asking for a program the student already has advanced the revision").toBe(before);
  });

  it("refuses a missing slug rather than guessing one", async () => {
    const r = (await call("add_program", {})) as { ok?: boolean; error?: string; remedy?: string };
    expect(r.ok).not.toBe(true);
    expect(r.error, "an empty slug was not refused by name").toMatch(/slug is required/i);
    expect(r.remedy, "the refusal does not point at the tool that produces a real slug").toMatch(/search_programs/i);
  });
});

describe("dropping a program", () => {
  const drop = (extra: Record<string, unknown> = {}) =>
    call("remove_program", { slug: MATH_MINOR, ...extra });

  beforeEach(async () => {
    await call("add_program", { slug: MATH_MINOR });
  });

  it("is refused without the student's own words, however the flag is set", async () => {
    // THE WHOLE GATE. A boolean is the easiest thing in the world for a
    // model to assert, and dropping a Program removes a set of
    // requirements rather than one.
    const before = file();
    const r = (await drop({ user_explicitly_asked: true })) as {
      ok?: boolean; error?: string; needs_confirmation?: boolean;
    };
    expect(r.ok, "a program was dropped on a model's say-so").not.toBe(true);
    expect(r.error, "the refusal does not ask for the student's words").toMatch(/student_words/i);
    expect(r.needs_confirmation, "the refusal does not say what would make it possible").toBe(true);
    expect(file(), "a refused drop still wrote to the plan").toBe(before);
  });

  it("is refused when the flag is missing even with words", async () => {
    const r = (await drop({ student_words: SAID })) as { ok?: boolean; error?: string };
    expect(r.ok).not.toBe(true);
    expect(r.error, "the refusal does not name the flag that is missing").toMatch(/user_explicitly_asked/i);
  });

  it("is refused when the words are the model narrating its own authority", async () => {
    // "The user asked me to" is not a quote, it is the model agreeing
    // with itself.
    const r = (await drop({
      user_explicitly_asked: true,
      student_words: "the student asked me to remove this program",
    })) as { ok?: boolean; error?: string };
    expect(r.ok, "a model's description of the student was accepted as the student").not.toBe(true);
    expect(r.error, "the refusal does not say the words read as a description").toMatch(/their own words|description of the student/i);
  });

  it("drops it when the student has actually asked", async () => {
    const r = (await drop({ user_explicitly_asked: true, student_words: SAID })) as {
      ok?: boolean; removed_program?: string; programs?: string[];
    };
    expect(r.ok, `remove_program did not report success: ${JSON.stringify(r).slice(0, 300)}`).toBe(true);
    expect(onDisk().programs, "the program is still on the plan after being dropped").not.toContain(MATH_MINOR);
    expect(onDisk().programs, "dropping the minor took the student's major with it").toContain(ESC);
  });

  it("echoes the words back, so a fabricated claim is something the student can find", async () => {
    // Nothing here can verify that a student said anything — every field
    // arrives from the model, including the quote. What is real is the
    // echo: an invented sentence now sits in the transcript beside a
    // dropped degree.
    const r = (await drop({ user_explicitly_asked: true, student_words: SAID })) as {
      on_the_strength_of?: string;
    };
    expect(r.on_the_strength_of, "the sentence the drop was justified by is not in the answer").toBe(SAID);
  });

  it("names the courses it removed and the ones it kept", async () => {
    const r = (await drop({ user_explicitly_asked: true, student_words: SAID })) as {
      courses_removed?: string[]; courses_kept?: string[]; remaining_programs_checked?: string[];
    };
    // MATH 141 is required by Engineering Science too, so it stays — and
    // saying so is the difference between a student trusting this and
    // checking their whole plan by hand afterwards.
    expect(r.courses_kept, "a course the student's major still requires was not reported as kept").toContain("MATH 141");
    expect(codesInPlan(), "a course the major still requires was removed with the minor").toContain("MATH 141");
    expect(r.remaining_programs_checked, "the answer does not say which programs the check covered").toContain(ESC);
  });

  it("reports what it leaves unfilled", async () => {
    const r = (await drop({ user_explicitly_asked: true, student_words: SAID })) as {
      leaves_unfilled?: unknown[]; note?: string;
    };
    // An empty list is a real answer here and the common one — dropping a
    // minor whose courses the major also needs leaves nothing short. What
    // matters is that the field is present and the note is honest about
    // what survived.
    expect(Array.isArray(r.leaves_unfilled), "the answer does not report unfilled requirements at all").toBe(true);
    expect(r.note, "the note does not reassure the student about what stays").toMatch(/completed courses/i);
  });

  it("refuses a program the plan does not have, and writes nothing", async () => {
    const before = file();
    const r = (await call("remove_program", {
      slug: STATS_MAJOR,
      user_explicitly_asked: true,
      student_words: SAID,
    })) as { ok?: boolean; error?: string };
    expect(r.ok).not.toBe(true);
    expect(r.error, "the refusal does not say the plan does not have that program").toMatch(/not one of this plan's programs/i);
    expect(file(), "a refused drop still wrote to the plan").toBe(before);
  });
});

describe("previewing a program change before making it", () => {
  it("shows what declaring a minor would do, and changes nothing", async () => {
    const before = file();
    const r = (await call("simulate_changes", {
      changes: [{ tool: "add_program", arguments: { slug: MATH_MINOR, based_on_revision: ctx.rev } }],
    })) as { simulated?: boolean; applied?: boolean; possible?: boolean; plan?: unknown };
    expect(r.simulated, "the preview did not run").toBe(true);
    expect(r.possible, `declaring a minor was reported impossible: ${JSON.stringify(r).slice(0, 300)}`).toBe(true);
    expect(r.applied, "a preview reported itself as applied").toBe(false);
    expect(file(), "a simulation wrote to the student's plan").toBe(before);
    expect(onDisk().programs, "a simulation added the program for real").not.toContain(MATH_MINOR);
  });

  it("previews dropping a program WITHOUT demanding consent, and says consent will be needed", async () => {
    // A student asking "what would happen if I dropped my minor?" has not
    // agreed to drop it. Requiring the flag to answer them would teach a
    // model to assert consent on a read — the exact assertion the gate
    // exists to make expensive. So the preview runs and carries the
    // condition the real change will impose.
    await call("add_program", { slug: MATH_MINOR });
    const r = (await call("simulate_changes", {
      changes: [{ tool: "remove_program", arguments: { slug: MATH_MINOR, based_on_revision: ctx.rev } }],
    })) as {
      possible?: boolean; requires_consent?: boolean; consent_needed_for?: string[];
      before_doing_this_for_real?: string;
    };
    expect(r.possible, `dropping the minor was reported impossible: ${JSON.stringify(r).slice(0, 300)}`).toBe(true);
    expect(r.requires_consent, "the preview did not say the real change needs the student's consent").toBe(true);
    expect(r.consent_needed_for, "the preview does not name what consent is needed for").toContain(MATH_MINOR);
    expect(
      r.before_doing_this_for_real,
      "the sentence a model reads back to the student does not describe dropping anything",
    ).toMatch(/out of this student's degree/i);
    expect(onDisk().programs, "a simulated drop changed the stored plan").toContain(MATH_MINOR);
  });

  it("previews a program change alongside another change, as one candidate", async () => {
    // The reason `simulate_changes` exists: the optimiser re-flows the
    // whole plan on every change, so two separate previews are two
    // different futures. "Add the math minor, and I can't do that in
    // spring" is one question about one plan.
    const r = (await call("simulate_changes", {
      changes: [
        { tool: "add_program", arguments: { slug: MATH_MINOR, based_on_revision: ctx.rev } },
        {
          tool: "set_schedule_constraint",
          arguments: { code: "MATH 141", rule: "not-in", term_index: 1, based_on_revision: ctx.rev },
        },
      ],
    })) as { possible?: boolean; changes?: unknown[]; to_make_this_real?: { in_order?: string[] } };
    expect(r.possible, `the pair was reported impossible: ${JSON.stringify(r).slice(0, 400)}`).toBe(true);
    expect(r.to_make_this_real?.in_order, "the preview does not say how to make it real").toEqual([
      "add_program",
      "set_schedule_constraint",
    ]);
  });
});

describe("a program change and a plan that moved", () => {
  it("is refused on a stale revision, and writes nothing", async () => {
    const before = file();
    const r = (await executeTool(
      "add_program",
      { slug: MATH_MINOR, based_on_revision: (ctx.rev ?? 0) - 1 },
      ctx,
    )) as { ok?: boolean; stale_read?: boolean; current_revision?: number };
    expect(r.ok).not.toBe(true);
    expect(r.stale_read, "a change computed from a revision that no longer exists was applied").toBe(true);
    expect(r.current_revision, "the refusal does not say what revision the plan is actually at").toBe(ctx.rev);
    expect(file(), "a refused declaration still wrote to the plan").toBe(before);
  });

  it("refuses a drop on a stale revision before the consent gate is even reached", async () => {
    // Order matters: a stale drop that passed the consent gate first
    // would have echoed the student's words into a refusal, which reads
    // like something happened.
    await call("add_program", { slug: MATH_MINOR });
    const r = (await executeTool(
      "remove_program",
      {
        slug: MATH_MINOR,
        user_explicitly_asked: true,
        student_words: SAID,
        based_on_revision: (ctx.rev ?? 0) - 1,
      },
      ctx,
    )) as { ok?: boolean; stale_read?: boolean };
    expect(r.ok).not.toBe(true);
    expect(r.stale_read, "a drop computed from a stale revision was applied").toBe(true);
    expect(onDisk().programs, "a refused drop removed the program anyway").toContain(MATH_MINOR);
  });
});
