/** What a change — or a whole list of them — would do, without doing it.
 *
 * "I want out in seven terms, I've got AP calc and transfer stats, and
 * I'd like to study abroad junior spring" is one sentence a student
 * would actually say. The assistant turns it into five explicit changes
 * and previews them TOGETHER, as one candidate plan.
 *
 * TOGETHER IS THE WHOLE POINT. Five separate previews are not an answer
 * to a question about a combination, because the optimiser re-flows the
 * entire plan on every change: the term the third one moved a course
 * into is a term the fourth one may empty. A student handed five
 * previews has to simulate the interaction in their head, which is the
 * work they asked for help with.
 *
 * THE GOVERNING PRINCIPLE (#39): the model interprets, the engine
 * computes. What arrives here is a list of NAMED changes with explicit
 * arguments, never a sentence describing a preference. Turning a
 * rambling into that list is the assistant's job and it is good at it;
 * deciding what a student meant is not something this server may do.
 *
 * THE SECOND DECISION: this does not simulate anything. It runs the REAL
 * mutations, through the real optimiser, against a sandbox copy of the
 * plan. A second scheduling implementation written "just for previews"
 * would drift from the first, and the drift would show up as a student
 * being shown a plan the planner then refuses to produce — a forecast of
 * a system that does not exist.
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
 * the optimiser.
 *
 * ONE SANDBOX FOR THE WHOLE LIST, which is what makes a list mean
 * anything: each change is applied to the plan the one before it left
 * behind, exactly as it would be if the student made them in order. A
 * sandbox per change would produce five previews of five different
 * futures and call them one candidate. */
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
    // A Course the catalog has no entry for scores SAT, which the
    // optimiser needs and a diff must not repeat (#49): it would mean a
    // change that moves an unknown Course anywhere is reported as
    // breaking nothing, which is a claim about requirements nobody has
    // read. Unknown degrades to "cannot be checked" here.
    const chkNow = checkCourse(cat, i.code, i.sem, after.sched);
    const now = chkNow.known === false ? 1 : chkNow.value;
    if (now === 2) continue;

    const previously = wasAt.get(i.code);
    // A Course the change ADDED has no "before" to compare against, so
    // an unsatisfied prerequisite on it is caused by the change by
    // definition.
    const wasChk = previously
      ? checkCourse(before.data.catalog, i.code, previously.sem, before.sched)
      : null;
    const was = wasChk ? (wasChk.known === false ? 1 : wasChk.value) : 2;
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

/** One named change with its arguments — the only thing this server
 * accepts. Not a description of a preference; see the header. */
export interface PlannedChange {
  tool: string;
  arguments: Record<string, unknown>;
}

/** How many changes one preview may carry.
 *
 * EVERY CHANGE RE-RUNS THE OPTIMISER over the whole plan, so the cost of
 * a list is linear in its length and paid inside a single request. The
 * hosted connector is a Worker isolate with a CPU budget, and an
 * unbounded list is a way for one call to spend all of it — which would
 * fail as a timeout with nothing to say, the symptom #39 names as the
 * hardest kind to chase. Twenty is far past anything a student's
 * rambling turns into; the ticket's own worked example is five. */
const MAX_CHANGES = 20;

/** Read the list a model sent, or say exactly what is wrong with it.
 *
 * REJECTED, NEVER REPAIRED. Guessing that a bare string meant
 * `{ tool: it, arguments: {} }`, or that a missing list meant an empty
 * one, is this server deciding what the model meant — the same mistake
 * as deciding what a student meant, one layer in. */
function readChanges(raw: unknown): { changes: PlannedChange[] } | { refusal: SimulationResult } {
  const note = {
    can_simulate: [...MUTATIONS].sort(),
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
    // A MISSING OR EMPTY NAME FALLS THROUGH to the name check below
    // rather than being refused here, so a nameless change is answered
    // with the same sentence as an unrecognised one — "that cannot be
    // simulated". Two refusals for one mistake is two messages a model
    // has to learn to read.
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

/** The English list a model reads back to a student: "a, b and c". */
const andList = (parts: string[]): string =>
  parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/** Which change this was, for a refusal that has to name one.
 *
 * `index` is 0-based so it indexes the list the model sent; the prose
 * counts from one because that is how a person reads a list. Both,
 * because a refusal nobody can locate in their own request is a refusal
 * nobody can act on. */
const at = (changes: PlannedChange[], i: number) => ({
  index: i,
  position: `change ${i + 1} of ${changes.length}`,
  tool: changes[i].tool,
  arguments: changes[i].arguments,
});

/** Run an ordered list of changes against one copy of the plan and
 * report what the lot of them would do.
 *
 * `simulateChange` is the one-element case of this and nothing else —
 * there is deliberately no second implementation, because the single
 * and multiple paths would otherwise disagree about what a preview
 * reports and a bug fixed in one would survive in the other. */
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

export async function simulateChanges(ctx: ToolContext, raw: unknown): Promise<SimulationResult> {
  const read = readChanges(raw);
  if ("refusal" in read) return read.refusal;
  const changes = read.changes;
  const one = changes.length === 1;

  // NAMES FIRST, BEFORE ANY WORK. A list whose fifth entry is not a
  // change at all is refused before the first four touch a sandbox, so
  // there is never a half-built candidate to be tempted into returning.
  for (let i = 0; i < changes.length; i++) {
    if (MUTATIONS.has(changes[i].tool)) continue;
    const named = changes[i].tool || "that";
    return {
      error:
        `${named} cannot be simulated — only a change to the plan can be.` +
        (one ? "" : ` (${at(changes, i).position})`),
      can_simulate: [...MUTATIONS].sort(),
      note: "To see the plan as it stands, call get_plan.",
    };
  }

  if (!ctx.plan) return { error: "There is no plan to simulate a change against." };

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
  const held = heldRev(ctx);
  for (let i = 0; i < changes.length; i++) {
    const stated = changes[i].arguments.based_on_revision;
    if (typeof stated !== "number" || stated === held) continue;
    return {
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
    };
  }

  const before = ctx;
  const after = sandbox(ctx);

  // THE REAL MUTATIONS, in order, against the one sandbox — with the
  // real optimiser behind each. The sandbox's revision is stated so the
  // guard in `executeMutation` is satisfied by the copy rather than
  // bypassed: a simulation that skipped the concurrency check would be
  // using a different code path from the one it is previewing. It is
  // re-read each time round because a change that lands advances it.
  const needsConsent: string[] = [];
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];

    // Asked of the sandbox BEFORE this change runs, because afterwards
    // the Course is gone and the question is unanswerable.
    const required = removesRequiredCourse(after, change);
    if (required && !needsConsent.includes(required)) needsConsent.push(required);

    const result = (await executeMutation(
      change.tool,
      { ...change.arguments, based_on_revision: heldRev(after) },
      after,
    )) as MutationResult | null;

    if (result && !result.error && result.ok === true) continue;

    // IMPOSSIBLE IS AN ANSWER, AND A PARTIAL CANDIDATE IS NOT. Returning
    // the plan as it stood after three of five changes would be a plan
    // nobody asked for, handed to a student as the answer to a question
    // about five. Returning a candidate that quietly lacks the thing
    // they asked for is the same failure one step smaller: they would
    // read "here is your plan with that change" and not notice the
    // omission. So the run stops, the sandbox is dropped unread, and
    // the answer names which change failed and why.
    return {
      simulated: true,
      applied: false,
      possible: false,
      based_on_revision: ctx.rev,
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
  const names = changes.map((c) => c.tool);

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
      (one
        ? `To make this change for real, call ${names[0]}, `
        : `To make these ${names.length} changes for real, call ${andList(names)} in that order, `) +
      "or tell them to do it in the planner.",
    possible: true,
    based_on_revision: ctx.rev,
    changes,
    // THE SINGLE-CHANGE ANSWER KEEPS ITS FIELD. A list of one is still a
    // list, so `changes` is always there — but dropping `change` would
    // quietly take a field away from a tool whose callers did nothing
    // wrong.
    ...(one ? { change: changes[0] } : {}),

    // HOW THIS BECOMES REAL, named rather than implied, because the
    // alternative a model reaches for is an id to apply later — and
    // applying a stored candidate is applying a decision made against a
    // plan that may have moved since (#39, out of scope). Re-running
    // the calls against the revision the plan is at THEN is what makes
    // the compare-and-swap mean anything.
    to_make_this_real: {
      in_order: names,
      note:
        "There is no preview to apply later and no id to quote. Call get_plan, then make these " +
        "calls in this order, each stating the revision get_plan returned — so if the student " +
        "edited their plan in the meantime the change is refused rather than overwriting them.",
    },

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
    ...(needsConsent.length
      ? {
          requires_consent: true,
          consent_needed_for: needsConsent,
          // PHRASED TO COVER BOTH, since #47 added a Program to the list.
          // "math-minor is required by the student's degree" is not a
          // sentence about anything, and a model reading it back to a
          // student would be saying something false about their own plan.
          before_doing_this_for_real:
            `Taking ${andList(needsConsent)} out of this student's degree needs them to ask for it ` +
            "in their own words — show them this preview, and pass what they say back as " +
            "student_words if they confirm.",
        }
      : {}),

    // NOT `satisfiable`. That word claims the candidate works, and this
    // only knows that the changes introduced nothing NEW — the fixture
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
    // student their plan is saved. A list makes it worse, not better:
    // the copy has been committed to once per change by then.
    candidate_plan: planView({ ...after, rev: undefined, updatedAt: undefined }, after.plan!),
  };
}

/** Run `change` against a copy and report what it would do.
 *
 * ONE ELEMENT, THEN THE SAME CODE. This is the whole of the
 * single-change tool: a second implementation would drift from the
 * list's, and the drift would be two tools disagreeing about what a
 * preview of the same change reports. */
export async function simulateChange(
  ctx: ToolContext,
  change: string,
  changeArgs: Record<string, unknown>,
): Promise<SimulationResult> {
  return simulateChanges(ctx, [{ tool: change, arguments: changeArgs }]);
}
