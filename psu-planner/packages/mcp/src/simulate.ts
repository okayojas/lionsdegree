/** What a change would do, without doing it.
 *
 * "What would my plan look like if I studied abroad in fall 2027?" The
 * student gets a complete candidate plan, an account of what moved, and
 * anything the change breaks — and their stored plan is untouched.
 *
 * THE WHOLE DESIGN IS ONE DECISION: this does not simulate anything. It
 * runs the REAL mutation, through the real optimiser, against a sandbox
 * copy of the plan. A second scheduling implementation written "just
 * for previews" would drift from the first, and the drift would show up
 * as a student being shown a plan the planner then refuses to produce —
 * a forecast of a system that does not exist.
 *
 * So the only thing this module owns is the sandbox and the diff. The
 * sandbox is a deep copy plus a store that writes nowhere; the diff is
 * the difference between two schedules the engine built.
 *
 * And the response is shaped so a model cannot read it as "done". No
 * `ok`, no new revision — the two fields a successful mutation returns
 * and the two a model would quote back to a student as proof.
 */
import { buildItems, buildSchedule, checkCourse, type PlanDoc, type PlanItem } from "@psu-planner/engine";
import { executeMutation, MUTATIONS, type MutationResult } from "./mutations.js";
import { MemoryPlanStore } from "./planStore.js";
import { planView } from "./planView.js";
import type { ToolContext } from "./tools.js";

/** Where a Course sits, by term label, in one schedule. */
type Placement = Map<string, { sem: number; label: string }>;

function placements(plan: PlanDoc, items: PlanItem[]): Placement {
  const at: Placement = new Map();
  for (const i of items) {
    if (i.kind !== "course" || !i.code) continue;
    at.set(i.code, { sem: i.sem, label: plan.terms[i.sem]?.label ?? `term ${i.sem}` });
  }
  return at;
}

/** A context the mutation can write to and nobody can read from.
 *
 * WHAT ACTUALLY ISOLATES THIS is the separate context object: `commit`
 * ASSIGNS `plan`, `items` and `sched` onto whatever it is handed, so
 * assigning them here leaves the caller's context alone. Every mutation
 * today also builds its own copy before editing, so sharing the
 * document would happen to work.
 *
 * The deep copy is here anyway, and the distinction is worth stating
 * rather than overclaiming: it is insurance against a future mutation
 * that edits a Plan IN PLACE. That one would reach through a shared
 * reference into the live session — a change nobody applied, quietly
 * true for every later answer — and it would not fail a test, it would
 * just be wrong. Copying costs microseconds on a path that already runs
 * the optimiser. */
function sandbox(ctx: ToolContext): ToolContext {
  const plan: PlanDoc = JSON.parse(JSON.stringify(ctx.plan));
  const items = buildItems(plan, ctx.data.catalog);
  return {
    ...ctx,
    plan,
    // AT THE REVISION THE REAL STORE REPORTS, not the one written in
    // the document. Hosted they differ, and a sandbox starting from the
    // wrong one refuses changes the planner would accept.
    store: new MemoryPlanStore(plan, ctx.rev ?? plan.rev ?? 0),
    items,
    sched: buildSchedule(plan, items, ctx.data.catalog),
  };
}

/** Courses whose prerequisites stop being satisfied because of this
 * change — and ONLY because of it.
 *
 * A requirement that was already unverifiable is not something the
 * student's question broke, and reporting it here would blame their
 * question for a gap that predates it. Comparing before against after
 * is what keeps the list honest.
 *
 * Degradation is conservative in the usual direction (iron rule 2): a
 * Course that moves from "satisfied" to "cannot determine" is listed,
 * because a student acting on this needs to know the answer stopped
 * being checkable, not just that it stopped being yes. */
function newConflicts(
  before: ToolContext,
  after: ToolContext,
): { code: string; term: string; was: string; now: string }[] {
  const word = (v: number) => (v === 2 ? "satisfied" : v === 1 ? "cannot be checked" : "not satisfied");
  const cat = after.data.catalog;
  const wasAt = placements(before.plan!, before.items);

  const out: { code: string; term: string; was: string; now: string }[] = [];
  for (const i of after.items) {
    if (i.kind !== "course" || !i.code) continue;
    const now = checkCourse(cat, i.code, i.sem, after.sched).value;
    if (now === 2) continue;

    const previously = wasAt.get(i.code);
    // A Course the change ADDED has no "before" to compare against, so
    // an unsatisfied prerequisite on it is caused by the change by
    // definition.
    const was = previously
      ? checkCourse(before.data.catalog, i.code, previously.sem, before.sched).value
      : 2;
    if (was === 2) {
      out.push({
        code: i.code,
        term: after.plan!.terms[i.sem]?.label ?? `term ${i.sem}`,
        was: word(was),
        now: word(now),
      });
    }
  }
  return out;
}

export interface SimulationResult {
  [k: string]: unknown;
}

/** Run `change` against a copy and report what it would do. */
export async function simulateChange(
  ctx: ToolContext,
  change: string,
  changeArgs: Record<string, unknown>,
): Promise<SimulationResult> {
  if (!MUTATIONS.has(change)) {
    return {
      error: `${change || "that"} cannot be simulated — only a change to the plan can be.`,
      can_simulate: [...MUTATIONS].sort(),
      note: "To see the plan as it stands, call get_plan.",
    };
  }
  if (!ctx.plan) return { error: "There is no plan to simulate a change against." };

  const before = ctx;
  const after = sandbox(ctx);

  // THE REAL MUTATION, with the real optimiser behind it. The sandbox's
  // revision is stated so the guard in `executeMutation` is satisfied
  // by the copy rather than bypassed — a simulation that skipped the
  // concurrency check would be using a different code path from the
  // one it is previewing.
  const result = (await executeMutation(change, { ...changeArgs, based_on_revision: after.rev ?? 0 }, after)) as
    | MutationResult
    | null;

  if (!result || result.error || result.ok !== true) {
    // IMPOSSIBLE IS AN ANSWER. Returning a candidate plan that quietly
    // lacks the thing the student asked for would be read as "here is
    // your plan with that change" — they would not notice the omission.
    return {
      simulated: true,
      applied: false,
      possible: false,
      based_on_revision: ctx.rev,
      change: { tool: change, arguments: changeArgs },
      reason: String(result?.error ?? `${change} could not be applied to this plan.`),
      ...(result?.suggestion ? { suggestion: result.suggestion } : {}),
      nothing_changed: "The student's plan has not been changed, and this change cannot be made as asked.",
    };
  }

  const wasAt = placements(before.plan!, before.items);
  const nowAt = placements(after.plan!, after.items);

  const moved = [...nowAt.entries()]
    .filter(([code, to]) => wasAt.has(code) && wasAt.get(code)!.sem !== to.sem)
    .map(([code, to]) => ({ code, from: wasAt.get(code)!.label, to: to.label }));

  const conflicts = newConflicts(before, after);

  return {
    simulated: true,
    // THREE WAYS OF SAYING THE SAME THING, because this is the one
    // misreading that costs a student their plan. A model skimming for
    // a success flag finds `applied: false`; one reading prose finds
    // the sentence; one looking for `ok` or a new revision — the two
    // fields a real change returns — finds neither.
    applied: false,
    nothing_changed:
      "This is a preview. The student's stored plan has not been changed. " +
      "To make this change for real, call " + change + ", or tell them to do it in the planner.",
    possible: true,
    based_on_revision: ctx.rev,
    change: { tool: change, arguments: changeArgs },

    moved,
    added_courses: [...nowAt.keys()].filter((c) => !wasAt.has(c)),
    removed_courses: [...wasAt.keys()].filter((c) => !nowAt.has(c)),
    terms_before: before.plan!.terms.length,
    terms_after: after.plan!.terms.length,

    new_conflicts: conflicts,
    // A candidate that breaks a prerequisite is not a plan the student
    // can follow, and saying so is the difference between a preview and
    // a trap.
    satisfiable: conflicts.length === 0,
    ...(conflicts.length
      ? {
          reason:
            `This change leaves ${conflicts.length} course${conflicts.length === 1 ? "" : "s"} ` +
            "without a satisfied prerequisite. Tell the student that before they act on it.",
        }
      : {}),

    // Pinned to the Plan's own Edition because the sandbox carries the
    // same catalog (ADR 0001) — a candidate audited against a different
    // bulletin is a forecast of somebody else's degree.
    candidate_plan: planView(after, after.plan!),
  };
}
