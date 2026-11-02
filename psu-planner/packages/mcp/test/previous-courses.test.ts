/** Recording what a student has ALREADY taken.
 *
 * The gap this closes is the one that makes every other answer wrong in the
 * confident direction: before it, a student with AP calculus and a
 * transferred statistics course was told to take both again, and the audit
 * agreed. There was no way for an assistant to say otherwise.
 *
 * Prior credit is completion, so these assert the planner's own behaviour
 * reached through a tool call: the Course leaves the scheduled Terms,
 * coverage is honoured (MATH 251 answers the MATH 250 the Program lists),
 * and a Course the Bulletin does not carry is REFUSED rather than recorded.
 *
 * The fixture is a real exported Plan, copied per test, and every assertion
 * reads the FILE afterwards — a refusal that still wrote would be worse than
 * no guard at all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool, listTools, loadContext, type ToolContext } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const SOURCE = path.join(here, "fixtures", "plan.json");

/** MATH 231 covers MATH 230 in the 2026-2027 coverage data, and MATH 230 is
 * a template course in the fixture's Term 3 — so recording the one the
 * student actually took has to clear the one their Program lists. */
const COVERS = "MATH 231";
const COVERED = "MATH 230";
/** The Template offers ECON 104 as an alternative to the ECON 102 it placed. */
const ALTERNATIVE = "ECON 104";
const ALTERNATIVE_FOR = "ECON 102";
/** In the catalog, in nobody's template here: a free elective already passed. */
const FREE = "ART 1";

let planPath: string;
let ctx: ToolContext;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-prior-"));
  planPath = path.join(dir, "plan.json");
  fs.copyFileSync(SOURCE, planPath);
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
});

const call = (name: string, args: Record<string, unknown> = {}) =>
  executeTool(name, { based_on_revision: ctx.rev, ...args }, ctx);
const onDisk = () => JSON.parse(fs.readFileSync(planPath, "utf-8")).plan;
const codesIn = (): string[] =>
  onDisk().terms.flatMap((t: { items: { code?: string }[] }) => t.items.flatMap((i) => (i.code ? [i.code] : [])));
const completedOnDisk = (): string[] =>
  Object.keys(onDisk().completed).filter((c) => onDisk().completed[c]);

describe("the prior-credit tools", () => {
  it("are offered, and each states the revision it was computed from", () => {
    const tools = listTools();
    for (const name of ["add_previous_course", "remove_previous_course"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is not offered at all`).toBeTruthy();
      const schema = tool!.inputSchema as { properties: Record<string, unknown>; required: string[] };
      expect(schema.properties.based_on_revision, `${name} does not take based_on_revision`).toBeTruthy();
      expect(schema.required, `${name} does not require based_on_revision`).toContain("based_on_revision");
    }
  });
});

describe("a course the student has already taken", () => {
  it("is recorded as completed", async () => {
    const r = (await call("add_previous_course", { codes: [FREE] })) as { ok?: boolean; recorded?: string[] };
    expect(r.ok, `recording ${FREE} did not succeed: ${JSON.stringify(r)}`).toBe(true);
    expect(r.recorded, "the result did not say what it recorded").toEqual([FREE]);
    expect(completedOnDisk(), `${FREE} was not written to the stored plan`).toContain(FREE);
  });

  it("disappears from the scheduled terms, so the plan stops telling them to take it", async () => {
    expect(codesIn(), "the fixture does not schedule the course this test is about").toContain(COVERED);
    await call("add_previous_course", { codes: [COVERED] });
    expect(codesIn(), `${COVERED} is still scheduled after being recorded as already taken`)
      .not.toContain(COVERED);
  });

  it("clears the requirement it COVERS, not only its own card", async () => {
    // The student took MATH 251; the Program lists MATH 250. Clearing only
    // the exact code leaves them looking at a schedule that still says to
    // take what they have already passed.
    const r = (await call("add_previous_course", { codes: [COVERS] })) as {
      ok?: boolean; no_longer_scheduled?: string[];
    };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(codesIn(), `${COVERS} covers ${COVERED}, which is still on the schedule`).not.toContain(COVERED);
    expect(r.no_longer_scheduled, "the model was not told which requirement this answered")
      .toContain(COVERED);
  });

  it("clears the card it was offered as an ALTERNATIVE to", async () => {
    expect(codesIn(), "the fixture no longer schedules the alternative's card").toContain(ALTERNATIVE_FOR);
    await call("add_previous_course", { codes: [ALTERNATIVE] });
    expect(codesIn(), `${ALTERNATIVE} satisfies the ${ALTERNATIVE_FOR} card, which is still scheduled`)
      .not.toContain(ALTERNATIVE_FOR);
  });

  it("counts toward the audit, which is the question the student actually asked", async () => {
    const before = JSON.stringify(await call("audit_requirements"));
    await call("add_previous_course", { codes: [COVERS] });
    const after = JSON.stringify(await call("audit_requirements"));
    expect(after, "recording prior credit changed nothing in the audit").not.toBe(before);
  });

  it("counts toward the credit totals immediately", async () => {
    const before = (await call("get_plan")) as { credits: { completed: number } };
    const r = (await call("add_previous_course", { codes: [FREE] })) as {
      plan?: { credits?: { completed: number } };
    };
    expect(r.plan?.credits?.completed, "the returned plan carried no completed-credit total")
      .toBeGreaterThan(before.credits.completed);
  });

  it("can be several in ONE call", async () => {
    // A student listing four AP exams must not cost four round trips and
    // four revisions (DECISIONS.md 4.1, rule 3).
    const r = (await call("add_previous_course", { codes: [FREE, COVERS, "CMPSC 465"] })) as {
      ok?: boolean; recorded?: string[];
    };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.recorded, "a multi-course call did not record all of them")
      .toEqual([FREE, COVERS, "CMPSC 465"]);
    for (const code of [FREE, COVERS, "CMPSC 465"]) {
      expect(completedOnDisk(), `${code} was dropped from a multi-course call`).toContain(code);
    }
  });

  it("is accepted under the singular `code` a model will reach for", async () => {
    // Every other mutation on this server takes `code`. A model using that
    // habit here would otherwise be told "no courses named" and retry the
    // same shape.
    const r = (await call("add_previous_course", { code: FREE })) as { ok?: boolean; recorded?: string[] };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.recorded, "the singular spelling recorded nothing").toEqual([FREE]);
  });

  it("is recorded even though no program template contains it", async () => {
    // A free elective already passed still counts toward the degree's
    // credits, and refusing it would make the tool useless for exactly the
    // transfer credit it exists for.
    const r = (await call("add_previous_course", { codes: [FREE] })) as { ok?: boolean };
    expect(r.ok, `${FREE} is in nobody's template and was refused: ${JSON.stringify(r)}`).toBe(true);
    expect(completedOnDisk(), `${FREE} was not recorded`).toContain(FREE);
  });

  it("returns the resulting plan, not just an acknowledgement", async () => {
    const r = (await call("add_previous_course", { codes: [FREE] })) as { plan?: { terms?: unknown[] } };
    expect(r.plan?.terms, "the mutation did not return the resulting plan").toBeTruthy();
  });
});

describe("a course that is not in the bulletin", () => {
  it("is REFUSED rather than recorded", async () => {
    // Iron rule 2. An unverifiable claim that a course was passed takes a
    // real requirement out of a real audit on nothing but a spelling.
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await call("add_previous_course", { codes: ["BASKT 999"] })) as {
      ok?: boolean; error?: string; not_in_the_catalog?: string[];
    };
    expect(r.ok, "an unverifiable course was recorded as passed").not.toBe(true);
    expect(r.error, "the refusal did not say the course is not in the catalog").toMatch(/not in the/i);
    expect(r.not_in_the_catalog, "the refusal did not name the course it could not find")
      .toEqual(["BASKT 999"]);
    expect(fs.readFileSync(planPath, "utf-8"), "a refused recording still wrote").toBe(before);
  });

  it("takes the whole call down with it, rather than half-recording", async () => {
    // A call the model was told failed, which nonetheless changed the
    // schedule, is harder to notice than one that did nothing.
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await call("add_previous_course", { codes: [FREE, "BASKT 999"] })) as { ok?: boolean };
    expect(r.ok, "a batch with one bad code was partly applied").not.toBe(true);
    expect(completedOnDisk(), `${FREE} was recorded despite the call being refused`).not.toContain(FREE);
    expect(fs.readFileSync(planPath, "utf-8"), "a refused batch still wrote").toBe(before);
  });

  it("says nothing that reads as success", async () => {
    const r = (await call("add_previous_course", { codes: ["BASKT 999"] })) as Record<string, unknown>;
    expect(r.ok, "a refusal carried ok").toBeUndefined();
    expect(r.recorded, "a refusal listed courses as recorded").toBeUndefined();
    expect(r.plan, "a refusal returned a plan as though one had been written").toBeUndefined();
  });

  it("tells the model to search rather than to guess again", async () => {
    const r = (await call("add_previous_course", { codes: ["BASKT 999"] })) as { remedy?: string };
    expect(r.remedy, "the refusal named no remedy").toMatch(/search_catalog/);
  });
});

describe("un-recording a course", () => {
  it("restores the requirement it had cleared, so a typo costs one message", async () => {
    // THE ASSERTION THIS WHOLE NOTE-KEEPING EXISTS FOR. The student said
    // MATH 231 and meant something else. Nothing in this tree can rebuild
    // the MATH 230 card from the Program's grid, so without a record of
    // what was cleared the requirement would be gone for good and the audit
    // would never mention it again.
    await call("add_previous_course", { codes: [COVERS] });
    expect(codesIn(), "the covered requirement was never cleared, so this proves nothing")
      .not.toContain(COVERED);

    const r = (await call("remove_previous_course", { codes: [COVERS] })) as {
      ok?: boolean; back_in_the_plan?: string[];
    };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(codesIn(), `un-recording ${COVERS} did not bring ${COVERED} back`).toContain(COVERED);
    expect(r.back_in_the_plan, "the model was not told what came back").toContain(COVERED);
  });

  it("stops treating the course as taken", async () => {
    await call("add_previous_course", { codes: [FREE] });
    await call("remove_previous_course", { codes: [FREE] });
    expect(completedOnDisk(), `${FREE} is still recorded as taken`).not.toContain(FREE);
  });

  it("does not schedule a course nobody ever required", async () => {
    // The correction case: a free elective recorded by mistake must not
    // leave the student scheduled to TAKE it. The planner's own un-mark
    // re-adds the card because there you un-tick something already on your
    // chart; here the student is withdrawing a claim.
    await call("add_previous_course", { codes: [FREE] });
    await call("remove_previous_course", { codes: [FREE] });
    expect(codesIn(), `${FREE} was added to the schedule by withdrawing a claim about it`)
      .not.toContain(FREE);
    expect(
      onDisk().added.map((a: { code: string }) => a.code),
      `${FREE} was added to the plan by withdrawing a claim about it`,
    ).not.toContain(FREE);
  });

  it("restores the course's own card with the template position intact", async () => {
    // `origin` is what makes a card a REQUIREMENT rather than something the
    // student added, and it is what the optimizer anchors to. A card put
    // back as a bare code drifts to the end of the plan and the consent
    // gate on removing it stops applying — so the whole spec is kept, not
    // the code.
    await call("add_previous_course", { codes: [COVERED] });
    await call("remove_previous_course", { codes: [COVERED] });
    const spec = onDisk()
      .terms.flatMap((t: { items: { code?: string; origin?: unknown }[] }) => t.items)
      .find((i: { code?: string }) => i.code === COVERED);
    expect(spec, `${COVERED} was taken off the schedule and never put back`).toBeTruthy();
    expect(spec.origin, `${COVERED} came back without the program position that makes it required`)
      .toBeTruthy();
  });

  it("puts back a course recorded somewhere else, and says it is unsure", async () => {
    // The fixture's MATH 140 was completed in the planner, long before this
    // tool existed, so what it cleared is not known. Leaving it neither
    // passed nor scheduled would be a requirement quietly deleted.
    expect(completedOnDisk(), "the fixture no longer carries a planner-recorded completion")
      .toContain("MATH 140");
    const r = (await call("remove_previous_course", { codes: ["MATH 140"] })) as {
      ok?: boolean; put_back_without_a_record?: string[]; caution?: string;
    };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.put_back_without_a_record, "a completion with no record was dropped silently")
      .toContain("MATH 140");
    expect(r.caution, "the model was not told the restore was a guess").toMatch(/not known/i);
    expect(codesIn(), "MATH 140 is neither completed nor scheduled").toContain("MATH 140");
  });

  it("refuses a course that was never recorded, and writes nothing", async () => {
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await call("remove_previous_course", { codes: ["CMPSC 465"] })) as {
      ok?: boolean; error?: string;
    };
    expect(r.ok, "un-recording something never recorded reported success").not.toBe(true);
    expect(r.error, "the refusal did not say the course was not recorded").toMatch(/not recorded/i);
    expect(fs.readFileSync(planPath, "utf-8"), "a refused un-recording still wrote").toBe(before);
  });
});

describe("a prior-credit change that does not say what it was based on", () => {
  it("is refused for both tools, and writes nothing", async () => {
    const before = fs.readFileSync(planPath, "utf-8");
    for (const name of ["add_previous_course", "remove_previous_course"]) {
      const r = (await executeTool(name, { codes: [FREE] }, ctx)) as { ok?: boolean; error?: string };
      expect(r.ok, `${name} landed without naming the revision it came from`).not.toBe(true);
      expect(r.error, `${name} did not ask for based_on_revision`).toMatch(/based_on_revision/);
    }
    expect(fs.readFileSync(planPath, "utf-8"), "a change with no stated revision wrote").toBe(before);
  });

  it("is refused when the revision has moved on", async () => {
    // The student saved in the planner while the model was thinking.
    const before = fs.readFileSync(planPath, "utf-8");
    const stale = (ctx.rev ?? 0) - 1;
    const r = (await executeTool(
      "add_previous_course",
      { codes: [FREE], based_on_revision: stale },
      ctx,
    )) as { ok?: boolean; stale_read?: boolean };
    expect(r.ok, "a stale prior-credit change landed").not.toBe(true);
    expect(r.stale_read, "the refusal was not reported as a stale read").toBe(true);
    expect(fs.readFileSync(planPath, "utf-8"), "a refused change still wrote").toBe(before);
  });
});

describe("a call naming no courses at all", () => {
  it("is refused by both tools, and writes nothing", async () => {
    const before = fs.readFileSync(planPath, "utf-8");
    for (const name of ["add_previous_course", "remove_previous_course"]) {
      const r = (await call(name, {})) as { ok?: boolean; error?: string; remedy?: string };
      expect(r.ok, `${name} succeeded without being given a course`).not.toBe(true);
      expect(r.remedy, `${name} did not show the model what to send`).toMatch(/codes/);
    }
    expect(fs.readFileSync(planPath, "utf-8"), "an empty call wrote").toBe(before);
  });
});
