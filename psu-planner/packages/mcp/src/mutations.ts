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
  type CourseSpec,
  type PlanDoc,
  type PlanItem,
  type ScheduleConstraint,
} from "@psu-planner/engine";
import type { ToolContext } from "./tools.js";
import { MemoryPlanStore } from "./planStore.js";
import { planView } from "./planView.js";

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
  "add_term",
  "clear_schedule_constraint",
  "delete_term",
  "fill_slot",
  "move_course",
  "optimize_schedule",
  "remove_course",
  "restore_course",
  "restore_term",
  "set_schedule_constraint",
  "skip_term",
  "swap_alternative",
]);

/** The Plan item a Course CODE names, or undefined.
 *
 * THE MAPPING THIS TICKET TURNS ON, and getting it wrong is silent. The
 * planner's own reversibility works on ITEM IDS — `store.ts` removeItem,
 * restoreItem and the chat's move_course all key `plan.moves` and
 * `plan.removed` by `item.id` — while every tool here takes a Course
 * code, because a code is what the student says and what a model has.
 *
 * The two coincide for exactly one of the three kinds of Course in a
 * Plan. `buildItems` ids a Template-placed Course by its code, a Course
 * the student added as `add-<code>`, and a Course filling a Slot by the
 * SLOT's id (`EL-5-4`) — the code never appears in that last id at all.
 *
 * So `p.moves[code] = 3` is correct one time in three and does NOTHING
 * the other two: the override is written under a key `semOf` never
 * reads, the tool answers "moved to Fall 2028", and the Course has not
 * budged. Asking `buildItems` — through `ctx.items`, which is rebuilt
 * after every commit — is what makes one answer true for all three. */
const itemFor = (ctx: ToolContext, code: string): PlanItem | undefined =>
  ctx.items.find((i) => i.kind === "course" && i.code === code);

/** Relabel every Term from the academic sequence.
 *
 * Labels are POSITIONAL (`terms.ts`), so splicing a Term out of the
 * middle and leaving the rest alone produces a calendar that does not
 * exist — Fall 2026, Spring 2027, Spring 2028 — which a student reads as
 * a lost year rather than as a renumbering. The optimizer relabels this
 * way at the end of every run and `add_term` derives its one label the
 * same way; this is that rule applied to a deletion. */
function relabel(p: PlanDoc): void {
  const first = parseTermLabel(p.terms[0]?.label ?? "");
  const start =
    first && first.kind !== "Summer"
      ? { term: first.kind as "Fall" | "Spring", year: first.year }
      : { term: "Fall" as const, year: new Date().getFullYear() };
  const labels = termSequence(start, p.terms.length, p.summerYears ?? []);
  p.terms = p.terms.map((t, i) => ({ ...t, label: labels[i]?.label ?? `Term ${i + 1}` }));
}

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

    // ---- Rearranging, and taking it back (#42) ----------------------------
    // Six changes the planner has always been able to make. The thread
    // through them is REVERSIBILITY: an assistant that can set a
    // Constraint and never clear it, remove a Course and never restore
    // it, skip a Term and never un-skip it, is one a student cannot
    // safely let near their degree.

    case "move_course": {
      // NOT remove-then-add. The Course stays the same spec in the same
      // `terms[].items` array and only its POSITION is overridden, which
      // is what keeps two things a re-add would destroy: its `origin`
      // (the Template entry it came from, and so the thing that makes a
      // double major's shared requirement count once rather than twice)
      // and its `alternatives` (the other codes the Program already
      // allows, which `swap_alternative` below needs to still be there).
      // `add_course` writes a bare `{code, sem}` into `added` — same
      // Course on the chart, a requirement nothing is attached to.
      const item = itemFor(ctx, code);
      if (!item) return { error: `${code || args.code} is not in the plan` };
      if (!Number.isInteger(termIndex) || termIndex < 0 || termIndex >= plan().terms.length) {
        return { error: `term_index must be between 0 and ${plan().terms.length - 1}` };
      }
      const target = plan().terms[termIndex];
      if (target.gap) {
        // A Gap Term is INTENTIONALLY empty (CONTEXT.md). Dropping a
        // Course into one silently cancels a leave the student declared,
        // and the only trace would be a course card in a term they are
        // not enrolled for.
        return {
          error: `${target.label} is a gap term — the student has said they are not studying then.`,
          suggestion: `Call restore_term for term ${termIndex} if they want to use it after all, then move the course.`,
        };
      }
      const from = plan().terms[item.sem]?.label;
      const r = await commit(ctx, name, (p) => { p.moves[item.id] = termIndex; });
      if (refused(r)) return r!;
      return {
        ...r,
        moved: code,
        from,
        to: plan().terms[termIndex]?.label,
        // SAID, BECAUSE IT IS SURPRISING. `optimizeSchedule` clears
        // `plan.moves` wholesale ("positions were re-derived"), so a hand
        // move is undone by the next optimize. A student told "I moved it"
        // and then shown it back where it was has been misled twice.
        note:
          "A manual move is wiped by the next optimize_schedule. If this placement needs to " +
          "survive, set_schedule_constraint with rule \"pin\" is the durable form of it.",
        plan: planView(ctx, plan()),
      };
    }

    case "swap_alternative": {
      // "CAS 100A or CAS 100B" is the Template offering a choice, not the
      // student adding a course. Only the codes the Template already
      // lists are reachable here, which is the whole difference between
      // this and add_course.
      const to = typeof args.alternative === "string" ? args.alternative.trim().toUpperCase() : "";
      const item = itemFor(ctx, code);
      if (!item) return { error: `${code || args.code} is not in the plan` };
      if (!to) return { error: "alternative is required: the course code to put in its place." };
      const offered = item.alternatives ?? [];
      if (!offered.includes(to)) {
        return {
          // NAMES WHAT IS ON OFFER. "Not an alternative" alone invites a
          // model to try another guess, and the list is three strings.
          error: `${to} is not one of the alternatives the program lists for ${code}.`,
          alternatives: offered,
          suggestion: offered.length
            ? "Swap for one of those, or use fill_slot / add_course if the student wants a course the program did not offer here."
            : `${code} is a fixed requirement — the program offers no alternative to it.`,
        };
      }
      // The alternative often lives in a subject nobody has read yet
      // (ESL 15 for ENGL 15), and an unloaded Course has no title — the
      // resulting plan would show "(not in this edition's catalog)" for
      // a course that is in it. `swapAlternative` in the planner calls
      // refreshCatalog for the same reason.
      await ctx.data.ensureCourses([to]);
      if (!cat[to]) {
        return { error: `${to} is listed as an alternative but is not in the ${ctx.data.edition} catalog` };
      }
      const r = await commit(ctx, name, (p) => {
        for (const t of p.terms) {
          for (const it of t.items) {
            if ("code" in it && it.code === code) {
              // REVERSIBLE BY CONSTRUCTION: the outgoing code becomes an
              // alternative of the incoming one, so the student can swap
              // back with the same tool. `origin` is deliberately not
              // touched — this is still the same Template entry, and
              // dropping it would uncount a shared requirement.
              const alts = new Set(it.alternatives ?? []);
              alts.delete(to);
              alts.add(code);
              it.code = to;
              it.alternatives = [...alts];
              it.unverified = undefined;
              // The item id of a Template Course IS its code, so a manual
              // move recorded against the old code would be orphaned —
              // the Course would snap back to its template term.
              if (code in p.moves) {
                p.moves[to] = p.moves[code];
                delete p.moves[code];
              }
              return;
            }
          }
        }
      });
      if (refused(r)) return r!;
      return {
        ...r,
        swapped: code,
        for: to,
        term: plan().terms[item.sem]?.label,
        note: `${code} is now listed as an alternative to ${to}, so this can be swapped back.`,
        plan: planView(ctx, plan()),
      };
    }

    case "restore_course": {
      // KEYED BY CODE, AND THAT IS NOT AN ACCIDENT OF NAMING. `remove_course`
      // stashes the spec under `removedSpecs[code]` because a CourseSpec
      // carries no id of its own; the planner stashes it under the ITEM
      // id, which for a Template Course is the same string. The two agree
      // for every Course either surface can actually remove, and this
      // reads back exactly what remove_course wrote rather than guessing
      // an id.
      const held = plan();
      const spec = held.removedSpecs?.[code];
      const flagged = !!held.removed?.[code];
      if (!spec && !flagged) {
        return {
          error: `${code || args.code} was not removed from this plan, so there is nothing to restore.`,
          suggestion:
            "Call get_plan to see what is in the plan. A course the student ADDED and then removed " +
            "leaves no record to restore — put it back with add_course.",
        };
      }
      let reflowed = false;
      const r = await commit(ctx, name, (p) => {
        if (p.removed) delete p.removed[code];
        const present = p.terms.some((t) => t.items.some((i) => ("code" in i ? i.code : i.id) === code));
        const saved = p.removedSpecs?.[code];
        if (!present && saved) {
          // A re-optimize since the removal rebuilt the terms without it,
          // so clearing the flag alone would point at nothing. The
          // preserved spec goes back carrying its `origin`, and the
          // optimizer below is what puts it where the Program had it —
          // term 0 is a staging position, not the answer.
          if (!p.terms.length) p.terms.push({ label: "", items: [] });
          p.terms[0].items.push(JSON.parse(JSON.stringify(saved)) as CourseSpec);
          reflowed = true;
        }
        if (p.removedSpecs) delete p.removedSpecs[code];
        if (reflowed) reoptimize(ctx, p);
      });
      if (refused(r)) return r!;
      // Asked of the REBUILT items — `commit` replaces `ctx.items`, and
      // reading the restored Course's term off the pre-commit list would
      // report where it used to be.
      const back = itemFor(ctx, code);
      return {
        ...r,
        restored: code,
        term: back ? plan().terms[back.sem]?.label : undefined,
        note: reflowed
          ? "The course was put back with the program's own placement and the schedule re-flowed around it."
          : "The course was already on the chart and is no longer hidden.",
        plan: planView(ctx, plan()),
      };
    }

    case "restore_term": {
      if (!Number.isInteger(termIndex) || termIndex < 0 || termIndex >= plan().terms.length) {
        return { error: `term_index must be between 0 and ${plan().terms.length - 1}` };
      }
      if (!plan().terms[termIndex].gap) {
        return {
          error: `${plan().terms[termIndex].label} is not a gap term, so there is nothing to un-skip.`,
          suggestion: "Call get_plan: a gap term is one the student has deliberately left empty.",
        };
      }
      const label = plan().terms[termIndex].label;
      const r = await commit(ctx, name, (p) => {
        delete p.terms[termIndex].gap;
        // THE RE-FLOW IS THE POINT, and it is why this cannot just clear
        // the flag. The optimizer splices an empty term in at each gap
        // position; with the flag gone it packs coursework into this term
        // instead, which is what "using the term again" means. Without
        // this the term stays empty and graduation stays a term late —
        // the student would have un-skipped nothing.
        reoptimize(ctx, p);
      });
      if (refused(r)) return r!;
      return {
        ...r,
        restored: label,
        note: "Coursework re-flowed into the term; graduation usually moves earlier by one term.",
        plan: planView(ctx, plan()),
      };
    }

    case "delete_term": {
      if (!Number.isInteger(termIndex) || termIndex < 0 || termIndex >= plan().terms.length) {
        return { error: `term_index must be between 0 and ${plan().terms.length - 1}` };
      }
      if (plan().terms.length <= 1) {
        return { error: "a plan needs at least one term, so the last one cannot be deleted" };
      }
      // THE CRITERION FROM THE TICKET: a Term with coursework in it
      // cannot be SILENTLY emptied. Slots count — an unfilled requirement
      // is a requirement, and deleting the term it sits in would drop a
      // graduation requirement while reporting that a term was tidied up.
      const occupants = ctx.items.filter((i) => i.sem === termIndex);
      if (occupants.length) {
        return {
          error:
            `${plan().terms[termIndex].label} still holds ${occupants.length} ` +
            `item${occupants.length === 1 ? "" : "s"}, so deleting it would take them with it.`,
          holds: occupants.map((i) => i.code ?? i.slotLabel ?? i.slot ?? i.id),
          suggestion:
            "skip_term keeps the term and re-flows its coursework into later terms, which is almost " +
            "always what was meant. move_course moves one course out at a time.",
        };
      }
      const label = plan().terms[termIndex].label;
      const wasGap = !!plan().terms[termIndex].gap;
      let droppedConstraints: { code: string; rule: string; term: string }[] = [];
      const r = await commit(ctx, name, (p) => {
        const [gone] = p.terms.splice(termIndex, 1);
        // A deleted SUMMER term gives up its opted-in year as well.
        // `summerYears` is what puts a summer into the term sequence, so
        // leaving it set re-inserts the summer at the next relabel and
        // the term the student deleted comes back under its own name.
        const ref = parseTermLabel(gone?.label ?? "");
        if (ref?.kind === "Summer") {
          p.summerYears = (p.summerYears ?? []).filter((y) => y !== ref.year);
        }
        // EVERY INDEX-KEYED REFERENCE AFTER THE HOLE MOVES DOWN ONE, the
        // mirror of what `addSummerSession` does when it inserts one. A
        // constraint left pointing at its old number would silently come
        // to mean a different term, which is a rule the student never set.
        droppedConstraints = (p.constraints ?? [])
          .filter((c) => c.termIndex === termIndex)
          .map((c) => ({ code: c.code, rule: c.type, term: label }));
        p.constraints = (p.constraints ?? [])
          // A constraint naming the DELETED term is dropped rather than
          // re-pointed, and reported below. Re-pointing it would attach
          // the student's "not in Spring 2029" to whatever term slid into
          // that slot; keeping it silently would do the same thing later.
          .filter((c) => c.termIndex !== termIndex)
          .map((c) => (c.termIndex > termIndex ? { ...c, termIndex: c.termIndex - 1 } : c));
        for (const a of p.added) if (a.sem >= termIndex) a.sem = Math.max(0, a.sem - 1);
        for (const k of Object.keys(p.moves)) {
          if (p.moves[k] >= termIndex) p.moves[k] = Math.max(0, p.moves[k] - 1);
        }
        relabel(p);
      });
      if (refused(r)) return r!;
      return {
        ...r,
        deleted: label,
        was_a_gap_term: wasGap || undefined,
        terms: plan().terms.length,
        // Reported rather than dropped quietly: a Constraint is something
        // the student said, and losing one without a word is how a plan
        // starts scheduling around nothing.
        constraints_dropped: droppedConstraints.length ? droppedConstraints : undefined,
        note: "Later terms were renumbered and relabelled, so term indices from an earlier get_plan are stale.",
        plan: planView(ctx, plan()),
      };
    }

    case "clear_schedule_constraint": {
      // The other half of set_schedule_constraint. Without it the
      // assistant can impose a rule on a student's own plan and never
      // lift it — "I can take AI 100 in the fall after all" had no
      // answer, and the Constraint outlives every optimize by design.
      const rule = args.rule === undefined || args.rule === null ? null : String(args.rule);
      if (rule !== null && !["not-in", "not-before", "pin"].includes(rule)) {
        return { error: `rule must be one of: not-in, not-before, pin — or omitted to clear every constraint on the course` };
      }
      if (!code) return { error: "code is required: the course whose constraint should be lifted." };
      const matches = (c: ScheduleConstraint) => c.code === code && (rule === null || c.type === rule);
      const held = plan().constraints ?? [];
      // LABELS READ BEFORE THE COMMIT. The re-flow below relabels every
      // term, so asking afterwards which term the lifted constraint named
      // can answer with a different term's name.
      const clearing = held.filter(matches).map((c) => ({
        code: c.code,
        rule: c.type,
        term: plan().terms[c.termIndex]?.label ?? `term ${c.termIndex}`,
      }));
      if (!clearing.length) {
        return {
          error: rule
            ? `there is no ${rule} constraint on ${code || args.code} to clear`
            : `there are no scheduling constraints on ${code || args.code} to clear`,
          constraints: held.map((c) => ({
            code: c.code,
            rule: c.type,
            term: plan().terms[c.termIndex]?.label ?? `term ${c.termIndex}`,
          })),
        };
      }
      const r = await commit(ctx, name, (p) => {
        p.constraints = (p.constraints ?? []).filter((c) => !matches(c));
        // SYMMETRIC WITH SETTING ONE, which the ticket asks for in those
        // words. Setting a constraint re-flows the schedule around it;
        // clearing one without re-flowing leaves the course sitting where
        // the lifted rule pushed it, so the student is told the rule is
        // gone and shown a plan still shaped by it.
        reoptimize(ctx, p);
      });
      if (refused(r)) return r!;
      return {
        ...r,
        cleared: clearing,
        note: "The schedule was re-flowed without the constraint, the same way setting one re-flows it.",
        plan: planView(ctx, plan()),
      };
    }

    default:
      return null; // not a mutation; the read dispatcher handles it
  }
}
