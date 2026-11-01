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
import { planView } from "./planView.js";

export interface MutationResult {
  ok?: boolean;
  error?: string;
  [k: string]: unknown;
}

/** What a model is told when its change was computed from a Plan that
 * has since moved on.
 *
 * NAMES THE REMEDY, because "conflict" on its own invites a retry of the
 * same bytes — which fails again, and the model either loops or gives up
 * and tells the student their planner is broken. Re-read, recompute,
 * call again. */
const staleWrite = (name: string): MutationResult => ({
  error:
    "The plan changed while you were working on it, so this change was not applied — " +
    "nothing was overwritten and nothing was merged.",
  stale_read: true,
  remedy:
    `Call get_plan to read the current plan, decide whether ${name} still makes sense ` +
    "against it, and then call again. Do not repeat this call unchanged: it was computed " +
    "from a revision that no longer exists.",
  why: "The student almost certainly edited their plan in the planner just now.",
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

  const next: PlanDoc = JSON.parse(JSON.stringify(ctx.plan));
  if (mutate(next) === false) return null;

  // BASED ON THE STORE'S REVISION, not the document's. The two differ
  // when a device coalesced edits before pushing, and the store's is the
  // number the swap is matched against.
  const base = ctx.rev ?? ctx.plan.rev ?? 0;
  next.rev = base + 1;
  next.updatedAt = new Date().toISOString();

  if ((await ctx.store.write(next, base)) === "stale") return staleWrite(name);

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
 * WHAT THIS CAN AND CANNOT DO. It cannot verify that a student said
 * anything — nothing at this layer can, and pretending otherwise would
 * be its own kind of lie. What it can do is make the quiet path
 * unavailable: a model cannot drop a requirement by setting one field
 * true, it has to produce words and those words are shown. The
 * third-person check below is the cheap half of that — a quote of a
 * student says "I"; a model narrating its own authority writes "the
 * user asked me to", which is not a quote at all.
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
  if (words.length < 8) {
    return "student_words does not read as something a student said — quote their actual sentence.";
  }

  // A MODEL DESCRIBING ITS OWN PERMISSION, which is the thing this
  // whole guard exists to refuse. Someone asking for a course to be
  // dropped talks about themselves and the course; a model reaching for
  // authority it was not given writes about "the user".
  if (/\b(the |this )?(user|student)\b[^.?!]{0,30}\b(asked|confirmed|said|wants|requested|agreed)\b/i.test(words)) {
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
  "add_term",
  "fill_slot",
  "optimize_schedule",
  "remove_course",
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
  const stated = Number(args.based_on_revision);
  if (!Number.isInteger(stated)) {
    return {
      error: `${name} needs based_on_revision: the revision of the plan this change was computed from.`,
      remedy:
        "Call get_plan, then call this again with the `revision` it returned. Every change you " +
        "make returns a new revision, so you can chain changes without re-reading each time.",
      why: "Without it there is no way to tell this change apart from one based on a plan the student has since edited.",
    };
  }
  if (stated !== (ctx.rev ?? 0)) return staleWrite(name);

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

    case "remove_course": {
      if (!ctx.items.some((i) => i.kind === "course" && i.code === code)) {
        return { error: `${code || args.code} is not in the plan` };
      }
      // ASKED BEFORE THE REMOVAL, because afterwards the Course is not
      // in the Plan and nothing is required of anyone — which read as
      // "this was never a requirement" and dropped the claim from the
      // result, exactly where it is supposed to be visible.
      const wasRequired = isRequired(ctx, code);
      if (wasRequired) {
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
