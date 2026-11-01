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
import { executeMutation, heldRev, MUTATIONS, type MutationResult } from "./mutations.js";
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

/** Violations the change CREATES — a Course scheduled before something
 * it enforces as a prerequisite (CONTEXT.md) — and only the ones it
 * creates.
 *
 * A requirement that was already unverifiable is not something the
 * student's question broke, and reporting it here would blame their
 * question for a gap that predates it. Comparing before against after
 * is what keeps the list honest.
 *
 * Degradation is conservative in the usual direction (iron rule 2):
 * ANY fall counts, including "satisfied" to "cannot be checked" — a
 * student acting on this needs to know the answer stopped being
 * checkable, not just that it stopped being yes. */
function newViolations(
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
    // ANY DOWNGRADE, not only a fall from "satisfied". The first
    // version tested `was === 2`, which silently dropped a Course going
    // from "cannot be checked" to "not satisfied" — a change turning an
    // open question into a known blocker, reported as nothing at all.
    // That is the inverse of iron rule 2, in the file whose comment
    // claimed to be applying it.
    if (now < was) {
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

/** What a simulation answers with.
 *
 * `ok` and `revision` are typed as `never` rather than left off, which
 * is the one thing an index signature can still do here: the two fields
 * a successful mutation returns are now impossible to set by accident,
 * including by a future `...spread` of a MutationResult into this
 * object. That spread is exactly how the candidate plan came to carry a
 * revision that did not exist. */
export interface SimulationResult {
  ok?: never;
  revision?: never;
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

  // A STATED REVISION IS HONOURED, NOT OVERWRITTEN. The model is told
  // to pass the change's arguments verbatim, and those may carry the
  // `based_on_revision` every mutation requires — which this used to
  // silently replace with the sandbox's own. Nothing could be lost by
  // that (a simulation writes nothing), but the student would be shown
  // a preview of a plan that is no longer theirs and told nothing.
  const held = heldRev(ctx);
  const stated = changeArgs.based_on_revision;
  if (typeof stated === "number" && stated !== held) {
    return {
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
    };
  }

  const before = ctx;
  const after = sandbox(ctx);

  // Asked of the ORIGINAL plan, before the change removes the Course
  // and makes the question unanswerable.
  const removesRequired =
    change === "remove_course" &&
    (ctx.plan.terms ?? []).some((t) =>
      t.items.some(
        (i) => "code" in i && i.code === String(changeArgs.code ?? "").trim().toUpperCase() && !!i.origin,
      ),
    );

  // THE REAL MUTATION, with the real optimiser behind it. The sandbox's
  // revision is stated so the guard in `executeMutation` is satisfied
  // by the copy rather than bypassed — a simulation that skipped the
  // concurrency check would be using a different code path from the
  // one it is previewing.
  const result = (await executeMutation(change, { ...changeArgs, based_on_revision: heldRev(after) }, after)) as
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

  // A CHANGE CAN BREAK A DEGREE WITHOUT BREAKING A PREREQUISITE.
  // Removing a Course that was filling a requirement, or re-flowing a
  // Plan so a Slot empties, leaves the student short of graduating with
  // every prerequisite still perfectly satisfied. Reporting only
  // prerequisites would call that candidate clean.
  const openSlots = (c: ToolContext) =>
    new Set(c.items.filter((i) => i.kind === "slot" && i.id).map((i) => i.id!));
  const wasOpen = openSlots(before);
  const unfilled = [...openSlots(after)]
    .filter((id) => !wasOpen.has(id))
    .map((id) => {
      const slot = after.items.find((i) => i.id === id);
      return { slot_id: id, requirement: slot?.slotLabel ?? slot?.slot ?? "a requirement" };
    });

  const moved = [...nowAt.entries()]
    .filter(([code, to]) => wasAt.has(code) && wasAt.get(code)!.sem !== to.sem)
    .map(([code, to]) => ({ code, from: wasAt.get(code)!.label, to: to.label }));

  const violations = newViolations(before, after);

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

    new_violations: violations,
    newly_unfilled_requirements: unfilled,

    // SAID HERE BECAUSE THE PREVIEW DID NOT ASK FOR IT. The consent
    // gate is relaxed for a simulation — a student asking "what would
    // happen if I dropped this?" has not agreed to drop it — so the
    // answer has to carry the condition the real change will impose,
    // or a model reads "possible: true" and finds out otherwise.
    ...(removesRequired
      ? {
          requires_consent: true,
          before_doing_this_for_real:
            "This course is required by the student's degree. Making this change needs them to " +
            "ask for it in their own words — show them this preview, and pass what they say back " +
            "as student_words if they confirm.",
        }
      : {}),

    // NOT `satisfiable`. That word claims the candidate works, and this
    // only knows that the change introduced nothing NEW — the fixture
    // alone carries two courses whose prerequisites cannot be checked
    // at all, and a plan with those in it was being reported as
    // satisfiable. Saying what was actually measured is the whole
    // discipline here (ADR 0002).
    introduces_no_problems: violations.length === 0 && unfilled.length === 0,
    ...(violations.length || unfilled.length
      ? {
          reason: [
            violations.length
              ? `This change leaves ${violations.length} course${violations.length === 1 ? "" : "s"} ` +
                "scheduled before a prerequisite it needs"
              : "",
            unfilled.length
              ? `it leaves ${unfilled.length} requirement${unfilled.length === 1 ? "" : "s"} ` +
                "that was filled now open"
              : "",
          ]
            .filter(Boolean)
            .join(", and ") + ". Tell the student before they act on it.",
        }
      : {}),

    // Pinned to the Plan's own Edition because the sandbox carries the
    // same catalog (ADR 0001) — a candidate audited against a different
    // bulletin is a forecast of somebody else's degree.
    //
    // WITH NO REVISION AND NO TIMESTAMP, and this was a live bug. The
    // sandbox commit sets `rev` and `updatedAt` on the copy, so the
    // candidate came back carrying `revision: 2` and a freshness note
    // reading "this is the plan as it was last saved (just now)" — a
    // revision that does not exist and a save that did not happen. The
    // top level said `applied: false` while the object nested inside it
    // described a successful write. A model summarising that tells the
    // student their plan is saved.
    candidate_plan: planView({ ...after, rev: undefined, updatedAt: undefined }, after.plan!),
  };
}
