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
import fs from "node:fs";
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

export interface MutationResult {
  ok?: boolean;
  error?: string;
  [k: string]: unknown;
}

/** Apply a change, persist it, and refresh the context so the next tool call
 * sees the new plan. Nothing is written if `mutate` throws or returns false. */
function commit(ctx: ToolContext, mutate: (plan: PlanDoc) => void | false): MutationResult | null {
  // Work on a copy: a mutation that throws halfway must not leave the
  // in-memory plan in a state the file does not match.
  const next: PlanDoc = JSON.parse(JSON.stringify(ctx.plan));
  if (mutate(next) === false) return null;
  next.rev = (next.rev ?? 0) + 1;
  next.updatedAt = new Date().toISOString();
  fs.writeFileSync(ctx.planPath, exportPlanFile(next), "utf-8");
  ctx.plan = next;
  ctx.items = buildItems(next, ctx.data.catalog);
  ctx.sched = buildSchedule(next, ctx.items, ctx.data.catalog);
  return { ok: true };
}

/** Re-run the optimizer and persist. Used after any change that moves work
 * around, so the plan a student reads is always a schedulable one. */
function reoptimize(ctx: ToolContext, plan: PlanDoc): PlanDoc {
  const items = buildItems(plan, ctx.data.catalog);
  const catalog = ctx.data.catalog;
  optimizeSchedule(plan, catalog, { maxCredits: 19 });
  void items;
  return plan;
}

const isRequired = (ctx: ToolContext, code: string): boolean =>
  ctx.plan.terms.some((t) => t.items.some((i) => "code" in i && i.code === code && !!i.origin));

export async function executeMutation(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<MutationResult | null> {
  const code = typeof args.code === "string" ? args.code.trim().toUpperCase() : "";
  const termIndex = Number(args.term_index ?? NaN);
  const cat = ctx.data.catalog;

  switch (name) {
    case "add_course": {
      if (!cat[code]) return { error: `${code || args.code} is not in the ${ctx.data.edition} catalog — search for it first` };
      if (!Number.isInteger(termIndex) || termIndex < 0 || termIndex >= ctx.plan.terms.length) {
        return { error: `term_index must be between 0 and ${ctx.plan.terms.length - 1}` };
      }
      if (ctx.items.some((i) => i.kind === "course" && i.code === code)) {
        return { error: `${code} is already in the plan` };
      }
      const r = commit(ctx, (p) => { p.added.push({ code, sem: termIndex }); });
      return { ...r, added: code, term: ctx.plan.terms[termIndex]?.label };
    }

    case "remove_course": {
      if (!ctx.items.some((i) => i.kind === "course" && i.code === code)) {
        return { error: `${code || args.code} is not in the plan` };
      }
      if (isRequired(ctx, code) && args.user_explicitly_asked !== true) {
        // The model cannot grant itself this. A catalog description it read
        // is not the student speaking (DECISIONS.md 5.0, S4).
        return {
          error: `${code} is required by the student's degree, so it cannot be removed on your say-so.`,
          needs_confirmation: true,
          suggestion:
            "If they want it out of a particular semester rather than out of the degree, use " +
            "set_schedule_constraint with rule \"not-in\". If they genuinely want it dropped, ask them " +
            "to confirm in their own words, then call again with user_explicitly_asked: true.",
        };
      }
      const r = commit(ctx, (p) => {
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
      return { ...r, removed: code, restorable: true };
    }

    case "set_schedule_constraint": {
      if (!cat[code]) return { error: `${code || args.code} is not in the ${ctx.data.edition} catalog` };
      const rule = String(args.rule ?? "not-in");
      if (!["not-in", "not-before", "pin"].includes(rule)) {
        return { error: `rule must be one of: not-in, not-before, pin` };
      }
      if (!Number.isInteger(termIndex) || termIndex < 0 || termIndex >= ctx.plan.terms.length) {
        return { error: `term_index must be between 0 and ${ctx.plan.terms.length - 1}` };
      }
      const r = commit(ctx, (p) => {
        const constraint: ScheduleConstraint = { code, type: rule as ScheduleConstraint["type"], termIndex };
        p.constraints = [...(p.constraints ?? []).filter((c) => !(c.code === code && c.type === rule)), constraint];
        // Constraints are honoured by the optimizer, so the plan is re-flowed
        // rather than the course being moved by hand. That is what makes them
        // durable across every future optimize.
        reoptimize(ctx, p);
      });
      return {
        ...r,
        constraint: { code, rule, term: ctx.plan.terms[termIndex]?.label },
        note: "The course is still in the degree; the schedule was re-flowed around the constraint.",
      };
    }

    case "optimize_schedule": {
      const before = ctx.plan.terms.length;
      const target = Number(args.target_terms ?? NaN);
      let note = "";
      const r = commit(ctx, (p) => {
        const res = optimizeSchedule(p, cat, {
          maxCredits: 19,
          ...(Number.isInteger(target) && target > 0 ? { targetSemesters: target } : {}),
        });
        note = res.capstoneNote ?? "";
      });
      return { ...r, terms_before: before, terms_after: ctx.plan.terms.length, note: note || undefined };
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
      const r = commit(ctx, (p) => { p.slotFills[slotId] = code; });
      return { ...r, filled: slotId, with: code };
    }

    case "add_term": {
      const r = commit(ctx, (p) => {
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
      return { ...r, terms: ctx.plan.terms.length };
    }

    case "skip_term": {
      if (!Number.isInteger(termIndex) || termIndex < 0 || termIndex >= ctx.plan.terms.length) {
        return { error: `term_index must be between 0 and ${ctx.plan.terms.length - 1}` };
      }
      const r = commit(ctx, (p) => {
        p.terms[termIndex].gap = true;
        // Coursework flows AROUND the gap rather than being dropped: the
        // student is taking a semester off, not abandoning those courses.
        reoptimize(ctx, p);
      });
      return {
        ...r,
        skipped: ctx.plan.terms[termIndex]?.label,
        note: "Coursework was re-flowed around the gap; nothing was removed and graduation moves back one term.",
      };
    }

    default:
      return null; // not a mutation; the read dispatcher handles it
  }
}
