/** One copy of a student's Plan, with a change already applied to it —
 * and the one place an ordered list of changes is run.
 *
 * EXTRACTED so the dependency runs one way. `simulate.ts` reports what a
 * change would do; `planDiagram.ts` draws the plan it would leave behind.
 * Both need this, and while it lived in `simulate.ts` the diagram module
 * imported the simulation module — so the simulation could never import
 * the diagram back without a cycle. That is precisely what was needed to
 * let a preview come back WITH a picture of itself.
 *
 * The sandbox is still the only place a simulated mutation runs, and
 * `commit` in `mutations.ts` still refuses to proceed if a context
 * claiming to be a simulation is holding a real store — so a flag that
 * escaped into production fails loudly rather than quietly relaxing the
 * consent gate.
 *
 * WHY THE LIST RUNNER MOVED HERE (#56). A Candidate tab is the plan a
 * saved list of changes would leave behind, drawn by the planner itself,
 * and the planner is in the browser. If it applied those changes by a
 * second route, a tab and a `simulate_changes` preview of the same
 * changes could disagree — a picture of a degree the planner then refuses
 * to produce, which is the drift this codebase has paid for five times
 * over. So `runChanges` is what both of them call, and it does not know
 * which it is serving: whether anything is written is decided entirely by
 * the store on the context it is handed, exactly as `commit` intends.
 */
import { buildItems, buildSchedule, type PlanDoc } from "@psu-planner/engine";
import { executeMutation, heldRev, PLANNABLE_CHANGES, type MutationResult } from "./mutations.js";
import { MemoryPlanStore } from "./planStore.js";
import type { ToolContext } from "./tools.js";

/** What a simulation answers with.
 *
 * `ok` and `revision` are typed as `never` rather than left off, which
 * is the one thing an index signature can still do here: the two fields
 * a successful mutation returns are now impossible to set by accident,
 * including by a future `...spread` of a MutationResult into this
 * object. That spread is exactly how the candidate plan came to carry a
 * revision that did not exist.
 *
 * Declared here rather than in `simulate.ts` because the refusals below
 * are built here now, and a type whose definition sits on the other side
 * of an import cycle is a type nobody can move. Re-exported from
 * `simulate.ts`, which is still where callers expect to find it. */
export interface SimulationResult {
  ok?: never;
  revision?: never;
  [k: string]: unknown;
}

/** One named change with its arguments — the only thing this server
 * accepts. Not a description of a preference; see `simulate.ts`. */
export interface PlannedChange {
  tool: string;
  arguments: Record<string, unknown>;
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
  if (!PLANNABLE_CHANGES.has(change)) {
    return {
      refused: {
        error: `${change || "that"} cannot be simulated — only a change to the plan can be.`,
        can_simulate: [...PLANNABLE_CHANGES].sort(),
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

/** How many changes one list may carry.
 *
 * EVERY CHANGE RE-RUNS THE OPTIMISER over the whole plan, so the cost of
 * a list is linear in its length and paid inside a single request. The
 * hosted connector is a Worker isolate with a CPU budget, and an
 * unbounded list is a way for one call to spend all of it — which would
 * fail as a timeout with nothing to say, the symptom #39 names as the
 * hardest kind to chase. Twenty is far past anything a student's
 * rambling turns into; the ticket's own worked example is five. */
export const MAX_CHANGES = 20;

/** Read the list a model sent, or say exactly what is wrong with it.
 *
 * REJECTED, NEVER REPAIRED. Guessing that a bare string meant
 * `{ tool: it, arguments: {} }`, or that a missing list meant an empty
 * one, is this server deciding what the model meant — the same mistake
 * as deciding what a student meant, one layer in. */
export function readChanges(
  raw: unknown,
): { changes: PlannedChange[] } | { refusal: SimulationResult } {
  const note = {
    can_simulate: [...PLANNABLE_CHANGES].sort(),
    note: "Pass changes as a list of { tool, arguments } objects, in the order they should happen.",
  };
  if (!Array.isArray(raw)) {
    return { refusal: { error: "changes must be a list of changes to try.", ...note } };
  }
  if (raw.length === 0) {
    return {
      refusal: {
        error: "changes was empty, and a list with nothing in it previews nothing.",
        ...note,
      },
    };
  }
  if (raw.length > MAX_CHANGES) {
    return {
      refusal: {
        error:
          `That is ${raw.length} changes, and this previews at most ${MAX_CHANGES} at once — ` +
          "each one re-runs the optimiser over the whole plan.",
        note: "Preview the ones the student is actually deciding between, then preview the rest.",
      },
    };
  }

  const changes: PlannedChange[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown> | null;
    const where = `change ${i + 1} of ${raw.length}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { refusal: { error: `${where} is not a { tool, arguments } object.`, ...note } };
    }
    // A MISSING OR EMPTY NAME FALLS THROUGH to the name check in
    // `runChanges` rather than being refused here, so a nameless change
    // is answered with the same sentence as an unrecognised one — "that
    // cannot be simulated". Two refusals for one mistake is two messages
    // a model has to learn to read.
    const tool = typeof entry.tool === "string" ? entry.tool.trim() : "";
    // An ABSENT `arguments` is read as none, because `optimize_schedule`
    // genuinely takes none and a model that omitted the empty object
    // meant the change it named. Anything present but not an object is
    // refused: that is a model having meant something we cannot see.
    const args = entry.arguments;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return { refusal: { error: `${where} has arguments that are not an object.`, ...note } };
    }
    changes.push({ tool, arguments: (args ?? {}) as Record<string, unknown> });
  }
  return { changes };
}

/** Is this change the removal of a Course the student's degree requires?
 *
 * `origin` is what makes a Course a requirement rather than something
 * the student added. ASKED OF THE PLAN AS IT STANDS when the change is
 * about to run, not of the original: in a list, change four may remove a
 * Course that change two put there, and only the plan at that moment
 * knows whether a Program required it. For a one-element list the plan
 * at that moment IS the original, so the single-change answer is
 * unchanged. */
function removesRequiredCourse(ctx: ToolContext, change: PlannedChange): string | null {
  // DROPPING A PROGRAM IS ALWAYS THIS (#47), with no question to ask of
  // the Plan: the whole point of a Program is that it requires things, so
  // there is no version of the change that is not the removal of
  // requirements. Named by slug rather than by code because that is what
  // the student is being asked to agree to.
  if (change.tool === "remove_program") {
    const slug = String(change.arguments.slug ?? "").trim();
    return slug && (ctx.plan?.programs ?? []).includes(slug) ? slug : null;
  }
  if (change.tool !== "remove_course") return null;
  const code = String(change.arguments.code ?? "").trim().toUpperCase();
  if (!code) return null;
  const required = (ctx.plan?.terms ?? []).some((t) =>
    t.items.some((i) => "code" in i && i.code === code && !!i.origin),
  );
  return required ? code : null;
}

/** Which change this was, for a refusal that has to name one.
 *
 * `index` is 0-based so it indexes the list the model sent; the prose
 * counts from one because that is how a person reads a list. Both,
 * because a refusal nobody can locate in their own request is a refusal
 * nobody can act on. */
export const at = (changes: PlannedChange[], i: number) => ({
  index: i,
  position: `change ${i + 1} of ${changes.length}`,
  tool: changes[i].tool,
  arguments: changes[i].arguments,
});

/** Run an ordered list of changes against `ctx`, in order, and hand back
 * the context they leave behind — or the refusal that stopped them.
 *
 * THE ONE PLACE A LIST OF CHANGES IS APPLIED. `simulate_changes` hands
 * it a sandbox and reports the difference; a Candidate tab hands it a
 * sandbox and draws the plan; "keep this one" hands it the REAL context
 * and the writes land. Nothing here knows the difference — whether a
 * change is written is decided by the store on the context, which is the
 * separation `commit` was built for.
 *
 * It does NOT make the sandbox itself. A function that always sandboxed
 * could never be the path that applies a Candidate for real, and then
 * applying one would need a second implementation of this loop — the
 * exact drift the Candidate design exists to avoid.
 *
 * IMPOSSIBLE IS AN ANSWER, AND A PARTIAL RESULT IS NOT. The run stops at
 * the first change that will not apply and names it. For a preview the
 * context is dropped unread; for a real apply the changes before it have
 * landed, and the caller is obliged to say so rather than claim the
 * whole list happened. */
export async function runChanges(
  ctx: ToolContext,
  changes: PlannedChange[],
): Promise<{ after: ToolContext; needsConsent: string[] } | { refused: SimulationResult; stoppedAt: number }> {
  const one = changes.length === 1;

  // NAMES FIRST, BEFORE ANY WORK. A list whose fifth entry is not a
  // change at all is refused before the first four touch the plan, so
  // there is never a half-built result to be tempted into returning.
  for (let i = 0; i < changes.length; i++) {
    if (PLANNABLE_CHANGES.has(changes[i].tool)) continue;
    const named = changes[i].tool || "that";
    return {
      stoppedAt: i,
      refused: {
        error:
          `${named} cannot be simulated — only a change to the plan can be.` +
          (one ? "" : ` (${at(changes, i).position})`),
        can_simulate: [...PLANNABLE_CHANGES].sort(),
        note: "To see the plan as it stands, call get_plan.",
      },
    };
  }

  if (!ctx.plan) {
    return { stoppedAt: 0, refused: { error: "There is no plan to simulate a change against." } };
  }

  // A STATED REVISION IS HONOURED, NOT OVERWRITTEN. The model is told
  // to pass each change's arguments verbatim, and those may carry the
  // `based_on_revision` every mutation requires — which this used to
  // silently replace with the sandbox's own. Nothing could be lost by
  // that (a simulation writes nothing), but the student would be shown
  // a preview of a plan that is no longer theirs and told nothing.
  //
  // EVERY CHANGE IN A LIST IS CHECKED AGAINST THE SAME NUMBER, because
  // every change in a list was computed from the same reading of the
  // plan. The chain a model might expect — R, then R+1, then R+2 — is
  // the sandbox's internal bookkeeping, and a student's preview must
  // not depend on a model guessing it right.
  //
  // A SAVED CANDIDATE CARRIES NO SUCH NUMBER, on purpose: it is stripped
  // when the Candidate is stored, because a Candidate is recomputed
  // against the plan as it stands and a frozen revision would make every
  // one of them refuse itself the moment the student edited anything.
  const held = heldRev(ctx);
  for (let i = 0; i < changes.length; i++) {
    const stated = changes[i].arguments.based_on_revision;
    if (typeof stated !== "number" || stated === held) continue;
    return {
      stoppedAt: i,
      refused: {
        simulated: true,
        applied: false,
        possible: false,
        based_on_revision: held,
        changes,
        ...(one ? { change: changes[0] } : {}),
        stopped_at: at(changes, i),
        reason:
          "That revision is not the one the plan is at now, so a preview built from it would " +
          "show the student a plan that is no longer theirs.",
        remedy:
          "Call get_plan, then simulate against what it returns." +
          (one
            ? ""
            : " Every change in one list is computed from the same reading of the plan, so they all " +
              "state that same revision — not one revision per change."),
        nothing_changed: "The student's plan has not been changed.",
      },
    };
  }

  // THE REAL MUTATIONS, in order, against the one context — with the
  // real optimiser behind each. The context's revision is stated so the
  // guard in `executeMutation` is satisfied by it rather than bypassed:
  // a simulation that skipped the concurrency check would be using a
  // different code path from the one it is previewing. It is re-read
  // each time round because a change that lands advances it.
  //
  // CAPTURED BEFORE THE LOOP. A refusal reports the revision the list was
  // computed from, and `commit` ADVANCES `ctx.rev` on every change that
  // lands — so reading it at the point of failure would report the third
  // change refused against a revision two edits in the future, a number
  // nothing the model ever saw.
  const startRev = ctx.rev;
  const needsConsent: string[] = [];
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];

    // Asked BEFORE this change runs, because afterwards the Course is
    // gone and the question is unanswerable.
    const required = removesRequiredCourse(ctx, change);
    if (required && !needsConsent.includes(required)) needsConsent.push(required);

    const result = (await executeMutation(
      change.tool,
      { ...change.arguments, based_on_revision: heldRev(ctx) },
      ctx,
    )) as MutationResult | null;

    if (result && !result.error && result.ok === true) continue;

    return {
      stoppedAt: i,
      refused: {
        simulated: true,
        applied: false,
        possible: false,
        based_on_revision: startRev,
        changes,
        ...(one ? { change: changes[0] } : {}),
        stopped_at: at(changes, i),
        reason: String(result?.error ?? `${change.tool} could not be applied to this plan.`),
        ...(result?.suggestion ? { suggestion: result.suggestion } : {}),
        nothing_changed:
          "The student's plan has not been changed, and this change cannot be made as asked." +
          (one
            ? ""
            : " No candidate plan is returned: the changes before this one ran only inside a sandbox " +
              "that has been discarded, so none of them is in a plan anybody can see."),
      },
    };
  }

  return { after: ctx, needsConsent };
}
