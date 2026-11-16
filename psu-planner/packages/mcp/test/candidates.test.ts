/** A what-if the student can keep and look at.
 *
 * `simulate_changes` answers "what would these five changes do" once and
 * then the answer scrolls away. A student weighing "seven terms, or study
 * abroad, or both?" is asking a COMPARATIVE question, and nothing held two
 * answers side by side.
 *
 * THE DECISION EVERY TEST HERE IS ABOUT: what gets stored is the list of
 * CHANGES, never the plan they produce. Storing the document would mean
 * keeping a what-if installs a decision made against a plan that may have
 * moved since — the thing the compare-and-swap in ADR 0003 exists to
 * refuse, and the exact objection `simulate_changes` raises when it says
 * there is no preview to apply later. So the assertions below are mostly
 * about what is NOT in the stored plan, and about a what-if and a preview
 * of the same changes being incapable of disagreeing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CANDIDATES, type Candidate, type PlanDoc } from "@psu-planner/engine";
import { executeTool, listTools, loadContext, type ToolContext } from "../src/tools.js";
import { runChanges, sandbox } from "../src/sandbox.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const SOURCE = path.join(here, "fixtures", "plan.json");

let planPath: string;
let ctx: ToolContext;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-cand-"));
  planPath = path.join(dir, "plan.json");
  fs.copyFileSync(SOURCE, planPath);
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
});

const rev = () => ctx.rev ?? ctx.plan!.rev;

const save = (args: Record<string, unknown>) =>
  executeTool(
    "save_candidate",
    { based_on_revision: rev(), ...args },
    ctx,
  ) as Promise<Record<string, unknown>>;

const stored = (): Candidate[] =>
  (JSON.parse(fs.readFileSync(planPath, "utf-8")).plan as PlanDoc).candidates ?? [];

const ONE_CHANGE = [{ tool: "skip_term", arguments: { term_index: 3 } }];

describe("saving a what-if", () => {
  it("puts it on the student's own plan document, named, with its changes", async () => {
    const r = await save({ name: "a term off", changes: ONE_CHANGE });
    expect(r.error, String(r.error)).toBeUndefined();

    const on = stored();
    expect(on.length, "nothing was written to the plan").toBe(1);
    expect(on[0].name).toBe("a term off");
    expect(on[0].changes, "the changes were not what was stored").toEqual([
      { tool: "skip_term", arguments: { term_index: 3 } },
    ]);
    expect(on[0].basedOnRev, "the what-if does not say what it was worked out from").toBe(1);
  });

  it("stores the CHANGES and nothing that looks like a plan", async () => {
    // THE WHOLE TICKET. A stored `terms` array here would be a plan
    // document under another name, and keeping it later would overwrite
    // whatever the student did in the meantime.
    await save({ name: "a term off", changes: ONE_CHANGE });
    const written = JSON.stringify(stored()[0]);
    expect(written, "a plan document was stored inside the what-if").not.toMatch(/"terms"/);
    expect(written, "a schedule was stored inside the what-if").not.toMatch(/"slotFills"/);
  });

  it("strips the revision out of the stored changes", async () => {
    // A frozen `based_on_revision` would make this what-if refuse itself
    // the moment the student edited anything, because it is recomputed
    // against the plan as it stands rather than replayed against the one
    // it was worked out from.
    await save({
      name: "a term off",
      changes: [{ tool: "skip_term", arguments: { term_index: 3, based_on_revision: rev() } }],
    });
    expect(
      JSON.stringify(stored()[0].changes),
      "the what-if froze a revision into its own changes",
    ).not.toMatch(/based_on_revision/);
  });

  it("says plainly that nothing has been applied, and draws nothing", async () => {
    const r = await save({ name: "a term off", changes: ONE_CHANGE });
    expect(r.applied, "a model could read this as the change having happened").toBe(false);
    expect(r.nothing_changed).toBeTruthy();
    // The planner draws it. A diagram here would be the second
    // implementation of the chart this whole ticket exists to avoid.
    expect(r.diagram, "save_candidate drew a picture of the plan").toBeUndefined();
    expect(r.candidate_plan, "save_candidate returned a plan document").toBeUndefined();
    expect(String(r.where_to_find_it), "the model is not told where the student will see it")
      .toMatch(/tab/i);
  });

  it("leaves the plan's own content alone", async () => {
    const before = JSON.parse(fs.readFileSync(planPath, "utf-8")).plan as PlanDoc;
    await save({ name: "a term off", changes: ONE_CHANGE });
    const after = JSON.parse(fs.readFileSync(planPath, "utf-8")).plan as PlanDoc;
    expect(after.terms, "saving a what-if rescheduled the student's plan").toEqual(before.terms);
    expect(after.completed).toEqual(before.completed);
    expect(after.rev, "saving a what-if did not advance the revision by one").toBe(before.rev + 1);
  });
});

describe("what saving a what-if refuses", () => {
  it("refuses one with no name", async () => {
    const r = await save({ changes: ONE_CHANGE });
    expect(String(r.error), "a nameless what-if was saved").toMatch(/name/i);
    expect(stored().length, "a refusal still wrote to the plan").toBe(0);
  });

  it("refuses one with nothing in it", async () => {
    const r = await save({ name: "nothing at all", changes: [] });
    expect(String(r.error)).toMatch(/empty/i);
    expect(stored().length).toBe(0);
  });

  it("refuses one computed from a revision the plan has moved past", async () => {
    // The same rule as every other write (ADR 0003). A what-if worked out
    // against a plan the student has since edited is a comparison against
    // a plan they no longer have.
    const r = (await executeTool(
      "save_candidate",
      { name: "stale", changes: ONE_CHANGE, based_on_revision: rev() + 5 },
      ctx,
    )) as Record<string, unknown>;
    expect(r.stale_read, "a stale what-if was accepted").toBe(true);
    expect(stored().length).toBe(0);
  });

  it("refuses one whose change cannot be made, and saves nothing", async () => {
    // A tab that opened on an error the moment it was created, after the
    // student was told their option was saved.
    const r = await save({
      name: "add a course that is not there",
      changes: [{ tool: "add_course", arguments: { code: "NOPE 999", term_index: 0 } }],
    });
    expect(r.error, "an uncomputable what-if was saved").toBeTruthy();
    expect(r.not_saved).toBeTruthy();
    expect(stored().length).toBe(0);
  });

  it("refuses a what-if of a what-if", async () => {
    // A branch from a branch: out of scope, and every rule here would need
    // a second answer for the inner one.
    const r = await save({
      name: "recursion",
      changes: [{ tool: "save_candidate", arguments: { name: "inner", changes: ONE_CHANGE } }],
    });
    expect(String(r.error), "a what-if was allowed to contain a what-if")
      .toMatch(/cannot be simulated/i);
    expect(stored().length).toBe(0);
  });

  it("refuses a second one by the same name", async () => {
    await save({ name: "a term off", changes: ONE_CHANGE });
    const r = await save({ name: "A Term Off", changes: ONE_CHANGE });
    expect(String(r.error), "two tabs would have carried the same label").toMatch(/already/i);
    expect(stored().length).toBe(1);
  });

  it("refuses past the cap and names what is already there", async () => {
    // NOT a silent drop of the oldest: that deletes a comparison the
    // student is in the middle of making, and nothing tells them which one
    // went.
    for (let i = 0; i < MAX_CANDIDATES; i++) {
      const r = await save({ name: `option ${i}`, changes: ONE_CHANGE });
      expect(r.error, `option ${i} was refused before the cap: ${String(r.error)}`).toBeUndefined();
    }
    const over = await save({ name: "one too many", changes: ONE_CHANGE });
    expect(over.error, "the cap did not hold").toBeTruthy();
    expect(over.candidates, "the refusal does not say which what-ifs are in the way").toEqual(
      Array.from({ length: MAX_CANDIDATES }, (_, i) => `option ${i}`),
    );
    expect(stored().length, "the oldest what-if was silently dropped").toBe(MAX_CANDIDATES);
  });
});

describe("a what-if and a preview of the same changes", () => {
  it("cannot disagree about the plan those changes leave behind", async () => {
    // THE NO-DRIFT PROPERTY, at the lowest seam that has both halves. The
    // planner draws a tab by running `runChanges` against a sandbox; the
    // connector reports a preview by running `runChanges` against a
    // sandbox. If those two could differ, a student would be shown a plan
    // the planner then refuses to produce — the failure #47, #50, #53 and
    // #54 were each one instance of.
    const changes = [
      { tool: "skip_term", arguments: { term_index: 3 } },
      { tool: "optimize_schedule", arguments: {} },
    ];
    const preview = (await executeTool("simulate_changes", { changes }, ctx)) as Record<string, unknown>;
    expect(preview.possible, String(preview.reason ?? preview.error)).toBe(true);

    const run = await runChanges(sandbox(ctx), changes);
    if ("refused" in run) throw new Error(`the tab refused what the preview allowed: ${String(run.refused.reason)}`);

    const asTab = run.after.plan!;
    const asPreview = preview.candidate_plan as { terms: { label: string; courses: { code: string }[] }[] };
    expect(asTab.terms.map((t) => t.label), "the tab and the preview lay the plan out differently")
      .toEqual(asPreview.terms.map((t) => t.label));
    for (let i = 0; i < asPreview.terms.length; i++) {
      const drawn = asTab.terms[i].items.flatMap((it) => ("code" in it ? [it.code] : [])).sort();
      const told = asPreview.terms[i].courses.map((c) => c.code).sort();
      // The preview reports resolved items (moves and slot fills applied)
      // while the document carries specs, so the comparison is on the
      // courses the term's own cards name — which is what a student sees
      // in the chart.
      expect(told, `term ${i} differs between the tab and the preview`).toEqual(
        expect.arrayContaining(drawn),
      );
    }
  });

  it("offers the same list of changes a preview will accept", async () => {
    // A model told it may use `save_candidate` as a change inside a
    // what-if would be refused for taking the offer.
    const r = await save({ name: "x", changes: [{ tool: "not_a_tool", arguments: {} }] });
    expect(r.can_simulate, "the offered list is missing").toBeTruthy();
    expect(r.can_simulate as string[], "a model is offered a change it will be refused for")
      .not.toContain("save_candidate");
  });
});

describe("a what-if the student wrote and one their assistant wrote", () => {
  it("leave the same plan behind when they hold the same changes", async () => {
    // TWO AUTHORS, ONE APPLIER (#59). The planner can now build a change
    // list itself — the `+` makes an empty one and each edit appends to
    // it — and the thing that stops the two authors drifting is that
    // neither of them applies anything: both lists go through
    // `runChanges`. If a student-authored list could produce a different
    // plan from an identical assistant-authored one, "keep this one"
    // would mean two different things depending on who typed it.
    const changes = [
      { tool: "skip_term", arguments: { term_index: 3 } },
      { tool: "optimize_schedule", arguments: {} },
    ];
    // The assistant's: sent over the wire, each change stating the
    // revision it was computed from, and stored by `save_candidate`.
    await save({
      name: "theirs",
      changes: changes.map((c) => ({ ...c, arguments: { ...c.arguments, based_on_revision: rev() } })),
    });
    const assistants = stored()[0].changes;
    // The student's: what the planner appends, which never carries a
    // revision at all.
    const students = changes;
    expect(assistants, "the two authors do not even store the same list").toEqual(students);

    const a = await runChanges(sandbox(ctx), assistants);
    const b = await runChanges(sandbox(ctx), students);
    if ("refused" in a) throw new Error(`the assistant's what-if refused: ${String(a.refused.reason)}`);
    if ("refused" in b) throw new Error(`the student's what-if refused: ${String(b.refused.reason)}`);
    expect(JSON.stringify(b.after.plan!.terms), "the same changes left two different plans")
      .toBe(JSON.stringify(a.after.plan!.terms));
  });
});

describe("keeping a what-if that takes a required course out", () => {
  /** A Course the student's Program requires — the one kind of removal
   * the consent gate stands in front of. */
  const required = (): string => {
    const code = ctx
      .plan!.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i && i.origin ? [i.code] : [])))[0];
    if (!code) throw new Error("the fixture plan has no required course to remove");
    return code;
  };

  it("is still refused when a model asks for it without the student's words", async () => {
    // THE HOSTED GATE, UNMOVED. Everything #59 changed is on the
    // planner's side; over the wire this is exactly as it was.
    const r = (await executeTool(
      "remove_course",
      { code: required(), based_on_revision: rev() },
      ctx,
    )) as Record<string, unknown>;
    expect(r.ok, "a required course came out on a model's say-so").toBeUndefined();
    expect(r.needs_confirmation).toBe(true);
    expect(String(r.error)).toMatch(/student/i);
  });

  it("goes through when the student themselves is the one keeping it", async () => {
    // THE OWNER'S DECISION (#59). `byTheStudent` is set only by the
    // planner in the student's own browser, where the caller IS the
    // person whose degree this is — the same one-click removal the
    // course card already offers.
    const code = required();
    const r = (await executeTool(
      "remove_course",
      { code, based_on_revision: rev() },
      { ...ctx, byTheStudent: true },
    )) as Record<string, unknown>;
    expect(r.error, String(r.error)).toBeUndefined();
    expect(r.removed).toBe(code);
    // AND IT SAYS WHAT IT WAS DONE ON THE STRENGTH OF. An empty quote
    // beside a dropped requirement reads as a removal justified by
    // nothing said at all.
    expect(String(r.on_the_strength_of), "the transcript does not say who took it out")
      .toMatch(/student kept a what-if/i);
  });

  it("is never something a request over the wire can switch on", async () => {
    // THE FLAG'S WHOLE SAFETY PROPERTY is that the hosted connector does
    // not set it. Nothing in this package may assign it: the moment a
    // worker did, `user_explicitly_asked` would be optional for any model
    // that knew the field name.
    const src = path.resolve(here, "..", "src");
    const offenders: string[] = [];
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith(".ts")) continue;
      const text = fs.readFileSync(path.join(src, f), "utf-8");
      // An assignment, not a read: `ctx.byTheStudent` in the gate is the
      // point of the field.
      if (/byTheStudent\s*[:=]\s*(true|!)/.test(text)) offenders.push(f);
    }
    expect(offenders, `the connector itself sets byTheStudent in ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("the tool a student's assistant is offered", () => {
  it("is on the surface, requires a name and the changes, and states a revision", () => {
    const def = listTools().find((t) => t.name === "save_candidate");
    expect(def, "save_candidate is not offered at all").toBeTruthy();
    const schema = def!.inputSchema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required.sort()).toEqual(["based_on_revision", "changes", "name"]);
    expect(def!.description, "the model is not told the plan is unchanged").toMatch(/not changed/i);
  });
});
