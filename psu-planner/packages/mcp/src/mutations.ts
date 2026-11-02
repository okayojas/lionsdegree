/** Tools that change the plan.
 *
 * Separate from the read tools because the rules are different. Reads can be
 * wrong and waste a student's time; writes can lose work. Three rules come
 * straight from an incident where an assistant, asked to avoid one course in
 * one semester, removed it and several electives to "consolidate" and left
 * the plan unrecoverable (DECISIONS.md 4.1):
 *
 *   1. A scheduling conflict is answered by CONSTRAINING, never by removing.
 *   2. Removing a required course needs the student to have actually said so.
 *      A model cannot grant itself that permission from a description it read.
 *   3. A bulk change is ONE deterministic call. A model hand-moving fifty
 *      courses over dozens of round trips is how "graduate in six semesters"
 *      timed out with no answer at all.
 *
 * And one rule about the file: a refusal writes NOTHING. The plan on disk is
 * the student's work, and a half-applied change is harder to notice than a
 * rejected one. */
import {
  GENED_BUCKETS,
  bucketAccepts,
  buildItems,
  buildSchedule,
  codeMatchesPool,
  exportPlanFile,
  optimizeSchedule,
  poolHasMembership,
  rankSlotPicks,
  parseTermLabel,
  resolveSlotPool,
  termSequence,
  type PlanDoc,
  type ScheduleConstraint,
} from "@psu-planner/engine";
import type { ToolContext } from "./tools.js";
import { MemoryPlanStore } from "./planStore.js";
import { planView } from "./planView.js";
import {
  notInBulletin,
  notRecorded,
  priorCourseCodes,
  recordPriorCredit,
  unrecordPriorCredit,
} from "./previousCourses.js";

export interface MutationResult {
  ok?: boolean;
  error?: string;
  [k: string]: unknown;
}

/** The revision the store is at, as far as this context knows.
 *
 * ONE ACCESSOR, because there were two: the guard compared the model's
 * claim against `ctx.rev ?? 0` while `commit` swapped against
 * `ctx.rev ?? ctx.plan.rev ?? 0`. Wherever `ctx.rev` was undefined the
 * two layers were guarding different numbers, which is the one thing a
 * two-layer check must never do.
 *
 * The store's number wins over the document's: the column is what a
 * compare-and-swap is matched against, and the document's copy can lag
 * it when a device coalesced edits before pushing. */
export const heldRev = (ctx: ToolContext): number => ctx.rev ?? ctx.plan?.rev ?? 0;

/** What a model is told when its change was computed from a Plan that
 * has since moved on.
 *
 * NAMES THE REMEDY, because "conflict" on its own invites a retry of the
 * same bytes — which fails again, and the model either loops or gives up
 * and tells the student their planner is broken. Re-read, recompute,
 * call again. */
const staleWrite = (name: string, computedFrom: number, held?: number): MutationResult => ({
  error:
    "The plan changed while you were working on it, so this change was not applied — " +
    "nothing was overwritten and nothing was merged.",
  stale_read: true,
  // BOTH NUMBERS, on the refusal as well as on the success. Without
  // them a transcript shows that something lost a race but not what,
  // and the student asking "what happened to my edit?" has nothing to
  // look at.
  based_on_revision: computedFrom,
  current_revision: held,
  remedy:
    `Call get_plan to read the current plan, decide whether ${name} still makes sense ` +
    "against it, and then call again. Do not repeat this call unchanged: it was computed " +
    "from a revision that no longer exists.",
  // NOT "the student just edited their plan". That is the usual cause,
  // not a fact — a write can also be refused because the row is not
  // visible to this session at all, and telling a student they edited
  // something they did not is a confident wrong answer about their own
  // actions.
  why: "Most often the student edited their plan in the planner while you were working.",
});

/** Apply a change, persist it, and refresh the context so the next tool call
 * sees the new plan. Nothing is written if `mutate` throws or returns false.
 *
 * THE WRITE IS A COMPARE-AND-SWAP (ADR 0003): it names the revision it
 * was computed from and lands only if the store is still at it. Hosted,
 * the other writer is the student's own planner tab, and the thing being
 * overwritten would be an edit they made thirty seconds ago. Iron rule 2
 * applied to concurrency — a change that cannot be shown to be based on
 * current state is refused, not best-guessed. */
async function commit(
  ctx: ToolContext,
  name: string,
  mutate: (plan: PlanDoc) => void | false,
): Promise<MutationResult | null> {
  // Work on a copy: a mutation that throws halfway must not leave the
  // in-memory plan in a state the store does not match.
  // `executeTool` refuses every mutation by name when there is no Plan
  // (it is not in CATALOG_ONLY), so this cannot be reached without one.
  // this function writes to a student's degree, and "the caller promised"
  // is not the guarantee to rely on there.
  if (!ctx.plan) throw new Error("no plan is loaded, so there is nothing to change");
  if (!ctx.store) throw new Error("no plan store is configured, so there is nowhere to write");
  // THE INVARIANT BEHIND `simulating`. The flag relaxes the consent
  // gate, which is only acceptable because a sandbox writes nowhere —
  // so the claim is checked rather than trusted. A flag that reached a
  // real context fails here, loudly, instead of quietly dropping the
  // one guard standing between a model and a graduation requirement.
  if (ctx.simulating && !(ctx.store instanceof MemoryPlanStore)) {
    throw new Error("a context marked as a simulation is holding a real plan store");
  }

  const next: PlanDoc = JSON.parse(JSON.stringify(ctx.plan));
  if (mutate(next) === false) return null;

  // BASED ON THE STORE'S REVISION, not the document's. The two differ
  // when a device coalesced edits before pushing, and the store's is the
  // number the swap is matched against.
  const base = heldRev(ctx);
  next.rev = base + 1;
  next.updatedAt = new Date().toISOString();

  if ((await ctx.store.write(next, base)) === "stale") return staleWrite(name, base);

  ctx.plan = next;
  ctx.rev = next.rev;
  ctx.updatedAt = next.updatedAt;
  ctx.items = buildItems(next, ctx.data.catalog);
  ctx.sched = buildSchedule(next, ctx.items, ctx.data.catalog);
  return { ok: true, based_on_revision: base, revision: next.rev };
}

/** Did a commit refuse? A refusal must be returned to the model as-is,
 * never dressed up with the fields a successful change would carry —
 * "removed: MATH 230" beside an error is a sentence a model will read as
 * success. */
const refused = (r: MutationResult | null): boolean => !!r?.stale_read;

/** Re-run the optimizer and persist. Used after any change that moves work
 * around, so the plan a student reads is always a schedulable one. */
function reoptimize(ctx: ToolContext, plan: PlanDoc): PlanDoc {
  const items = buildItems(plan, ctx.data.catalog);
  const catalog = ctx.data.catalog;
  optimizeSchedule(plan, catalog, { maxCredits: 19 });
  void items;
  return plan;
}

/** Why this removal cannot proceed, or null if it can.
 *
 * THE LAST THING BETWEEN A MODEL MISREADING A SENTENCE AND A DROPPED
 * GRADUATION REQUIREMENT. The old guard was one boolean, written when
 * the Plan was a file on the student's own disk and the blast radius of
 * getting it wrong was a file they could undo. Hosted, the model is
 * reaching a shared database over the network and the student is not
 * watching.
 *
 * A boolean is the easiest thing in the world for a model to assert. So
 * the flag is no longer sufficient: it must come with the student's own
 * sentence, and that sentence is echoed back where a human can see it.
 *
 * WHAT THIS CAN AND CANNOT DO, stated plainly because overclaiming here
 * would be worse than the weak guard it replaced. It cannot verify that
 * a student said anything. Nothing at this layer can: every field
 * arrives from the model, including the quote.
 *
 * THE PROPERTY THAT IS REAL is the echo. A removal of a required Course
 * now carries, into the student's own transcript, the sentence it was
 * justified by — so a fabricated one is something they can find, where a
 * silently-set boolean was not. Everything below is a cheap filter in
 * front of that, not the guarantee.
 *
 * The one pattern worth catching is a model narrating its own authority
 * — "the user asked me to" is not a quote, it is the model agreeing with
 * itself. It is matched tightly (subject immediately followed by the
 * verb) because a loose match blocks real sentences: a student writing
 * "the user manual said I don't need it" is quoting nobody but
 * themselves. A determined paraphrase gets through, and that is what the
 * echo is for.
 *
 * The same rule on both servers, deliberately. A security property that
 * depends on which deployment you reached is one nobody can reason
 * about, and the local student deserves the guard too. */
function consentProblem(args: Record<string, unknown>): string | null {
  if (args.user_explicitly_asked !== true) {
    return "Set user_explicitly_asked only after the student has actually asked.";
  }

  const words = typeof args.student_words === "string" ? args.student_words.trim() : "";
  if (!words) {
    return "student_words is required here: quote what the student said when they asked for this.";
  }
  // Only the degenerate case. A longer floor was arbitrary — it rejected
  // "Drop it." while admitting "yes drop" — and dressing an arbitrary
  // number up as a judgement about what a student sounds like is the
  // overclaiming this guard is supposed to avoid.
  if (words.length < 3) {
    return "student_words is too short to be anything the student said — quote their sentence.";
  }

  // "The user asked me to", not "the user manual said". Subject, then
  // verb, with nothing in between but a hedge.
  const narrating = /\b(the |this )?(user|student|they)\s+(has |have |already |just )?(asked|confirmed|said|told|wants|wanted|requested|agreed|approved)\b/i;
  if (narrating.test(words)) {
    return (
      "student_words reads as your description of the student rather than their own words. " +
      "Quote them directly, or ask them if they have not been asked."
    );
  }

  return null;
}

/** Does the Plan carry this Course because a Program requires it?
 *
 * `origin` is what makes it a requirement rather than something the
 * student added. With no Plan there is nothing required of anyone, and
 * the caller (remove_course's consent gate) reads false as "not required"
 * -- which is the safe direction only because every mutation is already
 * refused without a Plan. */
const isRequired = (ctx: ToolContext, code: string): boolean =>
  !!ctx.plan?.terms.some((t) => t.items.some((i) => "code" in i && i.code === code && !!i.origin));

/** Every tool this function handles.
 *
 * Stated once so the planless guard below can be scoped to it, and
 * exported so `mcp-surface.test.ts` can check the catalog-only surface
 * against the real list rather than a second hand-written one. */
export const MUTATIONS: ReadonlySet<string> = new Set([
  "add_course",
  "add_previous_course",
  "add_summer_session",
  "add_term",
  "fill_slot",
  "optimize_schedule",
  "remove_course",
  "remove_previous_course",
  "set_schedule_constraint",
  "skip_term",
]);

export async function executeMutation(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<MutationResult | null> {
  const code = typeof args.code === "string" ? args.code.trim().toUpperCase() : "";
  const termIndex = Number(args.term_index ?? NaN);
  const cat = ctx.data.catalog;

  // SCOPED TO NAMES THIS FUNCTION HANDLES. `executeTool` calls this
  // first for every tool and reads null as "not a mutation, carry on",
  // so an unscoped guard here answered `get_course_details` with "needs
  // a plan" and short-circuited the whole read surface.
  //
  // For a name it does handle, reaching here without a Plan is a routing
  // bug — and it must not return null either, because that would fall
  // through to the read switch and turn a misroute into a confidently
  // wrong answer rather than an error.
  if (!MUTATIONS.has(name)) return null;
  if (!ctx.plan) {
    return { error: `${name} needs a plan, and this connector has none loaded.` } as unknown as MutationResult;
  }

  // WHAT THE MODEL WAS LOOKING AT, checked before anything is computed.
  //
  // The store's compare-and-swap cannot do this job alone. The hosted
  // connector is stateless and re-reads the Plan at the start of every
  // request, so a swap against its own read is a race nobody can lose —
  // microseconds wide, and it would pass while the model acted on a
  // picture several turns old. The revision that has to match is the one
  // the model saw when it DECIDED.
  //
  // Both layers earn their place: this one catches a stale decision, the
  // store's catches a genuine race with the planner tab.
  // STRICTLY A NUMBER. `Number(null)`, `Number("")`, `Number([])` and
  // `Number(false)` are all 0, so coercing here let a model past the
  // guard on any Plan sitting at revision 0 by sending null — which is
  // every Plan that predates `rev` and every one just created. A guard
  // a caller can satisfy by sending nothing is not a guard.
  const stated = args.based_on_revision;
  if (typeof stated !== "number" || !Number.isInteger(stated)) {
    return {
      error: `${name} needs based_on_revision: the revision of the plan this change was computed from.`,
      remedy:
        "Call get_plan, then call this again with the `revision` it returned. Every change you " +
        "make returns a new revision, so you can chain changes without re-reading each time.",
      why: "Without it there is no way to tell this change apart from one based on a plan the student has since edited.",
    };
  }
  if (stated !== heldRev(ctx)) return staleWrite(name, stated, heldRev(ctx));

  // A GETTER, NOT A SNAPSHOT. `commit` REPLACES `ctx.plan` with the
  // mutated document, so anything that reads the Plan after a commit must
  // re-read it. Capturing it once in a local was the first version of
  // this, and `optimize_schedule` then reported the term count of the
  // Plan it had replaced — the test caught it at 7 against 8.
  const plan = () => ctx.plan!;

  switch (name) {
    case "add_course": {
      if (!cat[code]) return { error: `${code || args.code} is not in the ${ctx.data.edition} catalog — search for it first` };
      if (!Number.isInteger(termIndex) || termIndex < 0 || termIndex >= plan().terms.length) {
        return { error: `term_index must be between 0 and ${plan().terms.length - 1}` };
      }
      if (ctx.items.some((i) => i.kind === "course" && i.code === code)) {
        return { error: `${code} is already in the plan` };
      }
      const r = await commit(ctx, name, (p) => { p.added.push({ code, sem: termIndex }); });
      if (refused(r)) return r!;
      return { ...r, added: code, term: plan().terms[termIndex]?.label, plan: planView(ctx, plan()) };
    }

    // AP, transfer, summer, a term before they started planning. The
    // behaviour lives in `previousCourses.ts`; what is here is the gate
    // (iron rule 2) and the account given back to the model.
    case "add_previous_course": {
      const codes = priorCourseCodes(args);
      if (!codes.length) {
        return {
          error: "add_previous_course needs the courses the student has already taken.",
          remedy: 'Pass codes: ["MATH 140", "CHEM 110"] — one call for all of them.',
        };
      }
      const unknown = notInBulletin(codes, cat);
      if (unknown.length) {
        // ALL OR NOTHING. Recording the codes that checked out and
        // refusing the rest would leave the student's schedule half
        // changed by a call the model was told had failed, which is
        // harder to notice than a call that did nothing.
        return {
          error:
            `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in the ${ctx.data.edition} ` +
            "catalog, so nothing in this call was recorded.",
          not_in_the_catalog: unknown,
          why:
            "A course we cannot find is a course we cannot verify, and recording it as passed would " +
            "take a real requirement out of the student's audit on nothing but a spelling.",
          remedy:
            "Call search_catalog for the ones that did not match, confirm the codes with the student, " +
            "then call again with every code — including the ones that were fine.",
        };
      }

      let outcome!: ReturnType<typeof recordPriorCredit>;
      let reflowed = false;
      const r = await commit(ctx, name, (p) => {
        outcome = recordPriorCredit(p, codes, ctx.data.coveredBy);
        // The planner's own rule (store.ts `autoReoptimize`): completion
        // frees up the schedule, so re-flow it — unless the student has
        // dragged cards themselves, in which case reshuffling would throw
        // away an arrangement they made by hand.
        if (Object.keys(p.moves).length === 0) {
          reoptimize(ctx, p);
          reflowed = true;
        }
      });
      if (refused(r)) return r!;
      return {
        ...r,
        recorded: outcome.recorded,
        ...(outcome.alreadyRecorded.length ? { already_recorded: outcome.alreadyRecorded } : {}),
        // NAMED, not counted. "3 courses were removed" leaves the model
        // unable to tell the student that the MATH 250 they were going to
        // take is covered by the MATH 251 they already passed.
        no_longer_scheduled: outcome.noLongerScheduled,
        note:
          (reflowed
            ? "The schedule was re-flowed around what they have already done. "
            : "The schedule was left as the student arranged it — they have moved cards by hand. ") +
          "Courses the recorded ones cover are no longer scheduled; the audit and credit totals " +
          "below already reflect this.",
        plan: planView(ctx, plan()),
      };
    }

    case "remove_previous_course": {
      const codes = priorCourseCodes(args);
      if (!codes.length) {
        return {
          error: "remove_previous_course needs the courses to stop treating as already taken.",
          remedy: 'Pass codes: ["MATH 140"] — get_plan lists what is currently recorded.',
        };
      }
      const never = notRecorded(plan(), codes);
      if (never.length) {
        return {
          error:
            `${never.join(", ")} ${never.length === 1 ? "is" : "are"} not recorded as already taken, ` +
            "so nothing in this call was undone.",
          not_recorded: never,
          remedy: "Call get_plan for completed_courses, which is the list this tool removes from.",
        };
      }

      let outcome!: ReturnType<typeof unrecordPriorCredit>;
      const r = await commit(ctx, name, (p) => {
        outcome = unrecordPriorCredit(p, codes);
        // Re-flowed under the same rule as recording: a requirement put
        // back into the term it used to sit in has to find a term its
        // prerequisites allow, and the optimizer is what does that.
        if (Object.keys(p.moves).length === 0) reoptimize(ctx, p);
      });
      if (refused(r)) return r!;
      return {
        ...r,
        no_longer_recorded: outcome.noLongerRecorded,
        back_in_the_plan: outcome.restored,
        ...(outcome.restoredBlind.length
          ? {
              put_back_without_a_record: outcome.restoredBlind,
              caution:
                "These were recorded somewhere other than this connector — the planner's own " +
                "checkbox or a spreadsheet import — so what they originally cleared is not known. " +
                "The course itself is back in the plan; tell the student to check the requirement " +
                "it was standing in for.",
            }
          : {}),
        plan: planView(ctx, plan()),
      };
    }

    case "remove_course": {
      if (!ctx.items.some((i) => i.kind === "course" && i.code === code)) {
        return { error: `${code || args.code} is not in the plan` };
      }
      // ASKED BEFORE THE REMOVAL, because afterwards the Course is not
      // in the Plan and nothing is required of anyone — which read as
      // "this was never a requirement" and dropped the claim from the
      // result, exactly where it is supposed to be visible.
      const wasRequired = isRequired(ctx, code);
      // NOT ASKED OF A PREVIEW. A student asking "what would happen if
      // I dropped this?" has not agreed to drop it, and requiring the
      // flag to answer them would teach a model to assert consent on a
      // read — the exact assertion this gate exists to make expensive.
      // The simulation reports that consent will be needed instead.
      if (wasRequired && !ctx.simulating) {
        // The model cannot grant itself this. A catalog description it read
        // is not the student speaking (DECISIONS.md 5.0, S4).
        const refusal = consentProblem(args);
        if (refusal) {
          return {
            error: `${code} is required by the student's degree, so it cannot be removed on your say-so. ${refusal}`,
            needs_confirmation: true,
            suggestion:
              "If they want it out of a particular term rather than out of the degree, use " +
              "set_schedule_constraint with rule \"not-in\". If they genuinely want it dropped out of " +
              "their degree, ask them, wait for their answer, and call again with " +
              "user_explicitly_asked: true and student_words set to what they actually said.",
          };
        }
      }
      const r = await commit(ctx, name, (p) => {
        p.removed = { ...(p.removed ?? {}) };
        for (const t of p.terms) {
          for (const i of t.items) {
            if ("code" in i && i.code === code) {
              // Keyed by code: a CourseSpec carries no id of its own. The
              // spec itself is stashed so Restore has something to put back
              // after a re-optimize rebuilds the terms without it.
              p.removedSpecs = { ...(p.removedSpecs ?? {}), [code]: i };
              p.removed[code] = true;
            }
          }
          t.items = t.items.filter((i) => !("code" in i && i.code === code));
        }
        p.added = p.added.filter((a) => a.code !== code);
      });
      if (refused(r)) return r!;
      return {
        ...r,
        removed: code,
        restorable: true,
        // ECHOED BACK, so the claim is visible. Nothing here can verify
        // that a student said this — but a fabricated quote sitting in
        // the transcript beside a dropped requirement is something they
        // can find, and an unverifiable claim nobody ever sees is not.
        on_the_strength_of: wasRequired ? String(args.student_words ?? "") : undefined,
        plan: planView(ctx, plan()),
      };
    }

    case "set_schedule_constraint": {
      if (!cat[code]) return { error: `${code || args.code} is not in the ${ctx.data.edition} catalog` };
      const rule = String(args.rule ?? "not-in");
      if (!["not-in", "not-before", "pin"].includes(rule)) {
        return { error: `rule must be one of: not-in, not-before, pin` };
      }
      if (!Number.isInteger(termIndex) || termIndex < 0 || termIndex >= plan().terms.length) {
        return { error: `term_index must be between 0 and ${plan().terms.length - 1}` };
      }
      const r = await commit(ctx, name, (p) => {
        const constraint: ScheduleConstraint = { code, type: rule as ScheduleConstraint["type"], termIndex };
        p.constraints = [...(p.constraints ?? []).filter((c) => !(c.code === code && c.type === rule)), constraint];
        // Constraints are honoured by the optimizer, so the plan is re-flowed
        // rather than the course being moved by hand. That is what makes them
        // durable across every future optimize.
        reoptimize(ctx, p);
      });
      if (refused(r)) return r!;
      return {
        ...r,
        constraint: { code, rule, term: plan().terms[termIndex]?.label },
        note: "The course is still in the degree; the schedule was re-flowed around the constraint.",
        plan: planView(ctx, plan()),
      };
    }

    case "optimize_schedule": {
      const before = plan().terms.length;
      const target = Number(args.target_terms ?? NaN);
      let note = "";
      const r = await commit(ctx, name, (p) => {
        const res = optimizeSchedule(p, cat, {
          maxCredits: 19,
          ...(Number.isInteger(target) && target > 0 ? { targetTerms: target } : {}),
        });
        note = res.capstoneNote ?? "";
      });
      if (refused(r)) return r!;
      return {
        ...r,
        terms_before: before,
        terms_after: plan().terms.length,
        note: note || undefined,
        plan: planView(ctx, plan()),
      };
    }

    case "fill_slot": {
      const slotId = String(args.slot_id ?? "");
      const slot = ctx.items.find((i) => i.kind === "slot" && i.id === slotId);
      if (!slot) return { error: `no open slot with id ${slotId} — call get_plan for the current slot ids` };
      if (!cat[code]) return { error: `${code || args.code} is not in the ${ctx.data.edition} catalog` };

      // The same checks the planner's own card makes, so the two surfaces
      // cannot disagree about what satisfies a requirement. BOTH kinds of
      // slot are gated: a gen-ed slot carries no program pool, and checking
      // only the pool let any course in the catalog fill one.
      const bucket = GENED_BUCKETS.find((b) => b.key === slot.slot);
      if (bucket && !bucketAccepts(bucket, cat[code])) {
        return {
          error: `${code} does not carry the ${bucket.key} designation this requirement needs (${bucket.label})`,
          suggestion: "Call suggest_slot_courses for this slot_id to see what does count.",
        };
      }
      const prog = slot.slotProgram ? ctx.data.programs[slot.slotProgram] : undefined;
      const pool = prog && slot.slotLabel ? resolveSlotPool(slot.slotLabel, prog.requirementSections) : null;
      if (poolHasMembership(pool) && !codeMatchesPool(code, pool)) {
        return {
          error: `${code} is not on the approved list for ${slot.slotLabel ?? "this requirement"}`,
          suggestion: "Call suggest_slot_courses for this slot_id to see what does count.",
        };
      }
      const r = await commit(ctx, name, (p) => { p.slotFills[slotId] = code; });
      if (refused(r)) return r!;
      return { ...r, filled: slotId, with: code, plan: planView(ctx, plan()) };
    }

    case "add_term": {
      const r = await commit(ctx, name, (p) => {
        // Labels come from the term sequence rather than being invented, so
        // an appended term lands correctly after a summer the student opted
        // into.
        const first = parseTermLabel(p.terms[0]?.label ?? "");
        const start =
          first && first.kind !== "Summer"
            ? { term: first.kind as "Fall" | "Spring", year: first.year }
            : { term: "Fall" as const, year: new Date().getFullYear() };
        const labels = termSequence(start, p.terms.length + 1, p.summerYears ?? []);
        p.terms.push({ label: labels[p.terms.length]?.label ?? `Term ${p.terms.length + 1}`, items: [] });
      });
      if (refused(r)) return r!;
      return { ...r, terms: plan().terms.length, plan: planView(ctx, plan()) };
    }

    case "add_summer_session": {
      // THE ONLY TOOL HERE THAT INSERTS A TERM IN THE MIDDLE, which is
      // why it is its own tool and not a flavour of `add_term`.
      //
      // Three kinds of state are keyed by TERM INDEX — a Constraint's
      // `termIndex`, a student-added Course's `sem`, and every manual
      // move in `moves` — and every other tool on this surface addresses
      // Terms by index too. Insert a Term at index 3 and term 3 becomes
      // term 4, so a Constraint reading "not in term 3" now names a Term
      // the student never ruled out. The concrete failure: a student who
      // said "no CHEM 110 in spring 2028", takes a summer, and finds
      // CHEM 110 scheduled in spring 2028 anyway with the refusal silently
      // transferred to the following fall. Nothing errors, nothing looks
      // wrong, and it surfaces a year later at registration.
      //
      // The remap below is the whole job, and it is deliberately a mirror
      // of `addSummerSession` in `apps/web/src/store.ts`: two surfaces
      // writing the same Plan must renumber it the same way, or the
      // planner and the assistant disagree about which Term a Constraint
      // belongs to.
      const year = Math.round(Number(args.year));
      // Bounded rather than merely finite: `Number("2027!")` is NaN but
      // `Number(true)` is 1, and "Summer 1" is a label no sequence can
      // place. A model mis-reading "summer after my junior year" as a
      // term index (3) must not create one.
      if (!Number.isFinite(year) || year < 2020 || year > 2040) {
        return { error: "year must be a calendar year, e.g. 2027 for Summer 2027" };
      }
      const label = `Summer ${year}`;

      // IDEMPOTENT, AND CHECKED BEFORE ANYTHING IS WRITTEN. A model that
      // retries this call (a timeout, a re-read, a student repeating
      // themselves) must not get a second Summer 2027 — and far worse,
      // must not run the remap twice, which would walk every Constraint
      // two Terms forward instead of one. Nothing is committed here, so
      // the revision does not move; it is reported unchanged so the
      // model's next call still names a revision that exists.
      const already = plan().terms.findIndex((t) => t.label === label);
      const optedIn = (plan().summerYears ?? []).includes(year);
      if (already >= 0 || optedIn) {
        return {
          ok: true,
          unchanged: true,
          already_present: true,
          summer: label,
          // Null, not -1 or 0, when the Plan carries the opt-in but does
          // not run as far as that summer. A term index is a position in
          // a list, and inventing one here is how a later `add_course`
          // would land in the wrong Term.
          term_index: already >= 0 ? already : null,
          based_on_revision: stated,
          revision: heldRev(ctx),
          note:
            already >= 0
              ? `${label} is already in the plan, so nothing changed and no term indexes moved.`
              : `The student has already opted into ${label}, but the plan does not run that far yet. ` +
                "Nothing changed. Call optimize_schedule or add_term to extend it.",
          plan: planView(ctx, plan()),
        };
      }

      // After that year's spring, which is where a summer session sits
      // (Summer 2027 follows Spring 2027 and precedes Fall 2027), so every
      // label after the insertion stays correct without being rewritten.
      const springIdx = plan().terms.findIndex((t) => t.label === `Spring ${year}`);
      const insertAt = springIdx >= 0 ? springIdx + 1 : plan().terms.length;
      const termsBefore = plan().terms.length;

      const r = await commit(ctx, name, (p) => {
        // Year-keyed, not index-keyed, so the choice survives every future
        // re-optimize — which rebuilds the term list from this list.
        p.summerYears = [...(p.summerYears ?? []), year].sort((a, b) => a - b);
        p.terms.splice(insertAt, 0, { label, items: [] });
        // ALL THREE, IN ONE PLACE. Remapping some and not the rest is the
        // failure this tool exists to avoid: a Constraint that applies to
        // the wrong Term is indistinguishable from a Plan the student
        // asked for.
        for (const c of p.constraints ?? []) if (c.termIndex >= insertAt) c.termIndex++;
        for (const a of p.added) if (a.sem >= insertAt) a.sem++;
        for (const k of Object.keys(p.moves)) if (p.moves[k] >= insertAt) p.moves[k]++;
      });
      if (refused(r)) return r!;
      return {
        ...r,
        summer: label,
        term_index: insertAt,
        // SAID OUT LOUD, because the model is holding indexes from earlier
        // calls and nothing else in the answer would tell it they moved.
        // An index silently reinterpreted is the same wrong Term as an
        // unremapped Constraint, arriving by the other route.
        term_indexes_shifted: { at: insertAt, by: 1, terms_before: termsBefore, terms_after: plan().terms.length },
        renumbering_note:
          `${label} was inserted at index ${insertAt}, so every term from that index on is now one ` +
          "higher than it was. Any term index you were holding from an earlier call is out of date — " +
          "use the indexes in the plan below. Constraints, manual moves and courses the student added " +
          "were moved with their terms and still point at the same terms they did before.",
        note:
          "A summer term holds at most 9 credits and is exempt from the full-time floor" +
          (springIdx >= 0
            ? "."
            : `. The plan has no Spring ${year}, so ${label} was appended at the end; optimize_schedule ` +
              "will resequence it into place."),
        next_step:
          "Call optimize_schedule to let the plan use the new summer capacity, or set_schedule_constraint " +
          `with rule "pin" to put a particular course in it. Nothing has moved into ${label} yet.`,
        plan: planView(ctx, plan()),
      };
    }

    case "skip_term": {
      if (!Number.isInteger(termIndex) || termIndex < 0 || termIndex >= plan().terms.length) {
        return { error: `term_index must be between 0 and ${plan().terms.length - 1}` };
      }
      const r = await commit(ctx, name, (p) => {
        p.terms[termIndex].gap = true;
        // Coursework flows AROUND the gap rather than being dropped: the
        // student is taking a term off, not abandoning those courses.
        reoptimize(ctx, p);
      });
      if (refused(r)) return r!;
      return {
        ...r,
        skipped: plan().terms[termIndex]?.label,
        note: "Coursework was re-flowed around the gap; nothing was removed and graduation moves back one term.",
        plan: planView(ctx, plan()),
      };
    }

    default:
      return null; // not a mutation; the read dispatcher handles it
  }
}
