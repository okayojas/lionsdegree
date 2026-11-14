/** One copy of a student's Plan, with a change already applied to it.
 *
 * EXTRACTED so the dependency runs one way. `simulate.ts` reports what a
 * change would do; `planDiagram.ts` draws the plan it would leave behind.
 * Both need this, and while it lived in `simulate.ts` the diagram module
 * imported the simulation module — so the simulation could never import
 * the diagram back without a cycle. That is precisely what was needed to
 * let a preview come back WITH a picture of itself.
 *
 * Nothing here changed in the move. The sandbox is still the only place
 * a simulated mutation runs, and `commit` in `mutations.ts` still refuses
 * to proceed if a context claiming to be a simulation is holding a real
 * store — so a flag that escaped into production fails loudly rather than
 * quietly relaxing the consent gate.
 */
import { buildItems, buildSchedule, type PlanDoc } from "@psu-planner/engine";
import { executeMutation, heldRev, MUTATIONS, type MutationResult } from "./mutations.js";
import { MemoryPlanStore } from "./planStore.js";
import type { ToolContext } from "./tools.js";
// TYPE ONLY. A value import would put the cycle back: `simulate.ts` now
// imports the drawing, and the drawing module imports this one.
import type { SimulationResult } from "./simulate.js";

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
 * the optimiser.
 *
 * ONE SANDBOX FOR THE WHOLE LIST, which is what makes a list mean
 * anything: each change is applied to the plan the one before it left
 * behind, exactly as it would be if the student made them in order. A
 * sandbox per change would produce five previews of five different
 * futures and call them one candidate. */
export function sandbox(ctx: ToolContext): ToolContext {
  const plan: PlanDoc = JSON.parse(JSON.stringify(ctx.plan));
  const items = buildItems(plan, ctx.data.catalog);
  return {
    ...ctx,
    simulating: true,
    plan,
    // AT THE REVISION THE REAL STORE REPORTS, not the one written in
    // the document. Hosted they differ, and a sandbox starting from the
    // wrong one refuses changes the planner would accept. Through the
    // shared accessor, because `mutations.ts` has that comment about
    // there being exactly one of these and this file had made it three.
    store: new MemoryPlanStore(plan, heldRev(ctx)),
    items,
    sched: buildSchedule(plan, items, ctx.data.catalog),
  };
}

/** A sandbox with one change already applied, or the refusal a student
 * would have been given.
 *
 * WHY IT IS SEPARATE FROM `simulateChanges`. `plan_diagram` draws the
 * plan a change would leave behind; it needs the CONTEXT — items and
 * schedule — not the report of what moved. Both go through the same
 * `sandbox()` and the same `executeMutation`, so the candidate a
 * student is shown and the candidate they are told about are produced
 * by one code path. A second preview implementation would drift, and
 * the drift would be a picture of a plan the planner then refuses to
 * produce.
 *
 * The sandbox's `rev` and `updatedAt` are left as the mutation set
 * them: the copy genuinely did advance and is entitled to know it.
 * Stripping them is the reporting caller's job, at the point of
 * handing something outward — see where `planView` is called. */
export async function candidateContext(
  ctx: ToolContext,
  change: string,
  changeArgs: Record<string, unknown>,
): Promise<{ after: ToolContext } | { refused: SimulationResult }> {
  if (!MUTATIONS.has(change)) {
    return {
      refused: {
        error: `${change || "that"} cannot be simulated — only a change to the plan can be.`,
        can_simulate: [...MUTATIONS].sort(),
        note: "To see the plan as it stands, call get_plan.",
      },
    };
  }
  if (!ctx.plan) return { refused: { error: "There is no plan to simulate a change against." } };

  // A STATED REVISION IS HONOURED, NOT OVERWRITTEN — the same rule
  // `simulateChanges` applies, and for the same reason: a preview
  // built from a revision the plan has moved past shows a student a
  // plan that is no longer theirs. Replacing it with the sandbox's own
  // would make the check silently unreachable, which is what the first
  // version of this function did until its test said so.
  const held = heldRev(ctx);
  const stated = changeArgs.based_on_revision;
  if (typeof stated === "number" && stated !== held) {
    return {
      refused: {
        simulated: true,
        applied: false,
        possible: false,
        based_on_revision: held,
        change: { tool: change, arguments: changeArgs },
        reason:
          "That revision is not the one the plan is at now, so a preview built from it would " +
          "show the student a plan that is no longer theirs.",
        remedy: "Call get_plan, then simulate against what it returns.",
        nothing_changed: "The student's plan has not been changed.",
      },
    };
  }

  const after = sandbox(ctx);
  const result = (await executeMutation(
    change,
    { ...changeArgs, based_on_revision: heldRev(after) },
    after,
  )) as MutationResult | null;

  if (!result || result.error || result.ok !== true) {
    return {
      refused: {
        simulated: true,
        applied: false,
        possible: false,
        based_on_revision: ctx.rev,
        change: { tool: change, arguments: changeArgs },
        reason: String(result?.error ?? `${change} could not be applied to this plan.`),
        ...(result?.suggestion ? { suggestion: result.suggestion } : {}),
        nothing_changed:
          "The student's plan has not been changed, and this change cannot be made as asked.",
      },
    };
  }
  return { after };
}
