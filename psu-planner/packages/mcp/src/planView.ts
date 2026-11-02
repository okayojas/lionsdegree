/** The Plan as a model sees it.
 *
 * One builder, because `get_plan` and every mutation return the same
 * thing and a second copy would drift — a student asking "what did that
 * change?" would get a differently-shaped answer from the tool that made
 * the change than from the one that reads it.
 *
 * Mutations return it for a specific reason (#36): a model that is told
 * only "ok: true" describes what it INTENDED, because that is all it
 * has. Handing back the resulting Plan lets it state what actually
 * happened — including the parts it did not ask for, like the optimizer
 * re-flowing three terms around a new constraint.
 */
import { checkCourse, credOf, progress, type PlanDoc } from "@psu-planner/engine";
// TYPE ONLY, so there is no runtime import back into `tools.ts` — which
// imports this module. A value import here would be a cycle.
import type { ToolContext } from "./tools.js";

export interface PlanView {
  as_of?: string;
  revision?: number;
  freshness_note?: string;
  edition: string;
  edition_note: string;
  programs: string[];
  credits: { completed: number; planned_total: number };
  completed_courses: string[];
  terms: unknown[];
}

/** What a student is told about one Course's prerequisites.
 *
 * Shared so the wording cannot drift between the Plan view and
 * `check_prerequisites`, and so the `known` rule is applied once. */
export function prereqWord(chk: { value: number; known?: boolean }): string {
  if (chk.known === false) return "cannot be checked — this course is not in the edition's catalog";
  return chk.value === 2 ? "satisfied" : "check";
}

export function planView(ctx: ToolContext, plan: PlanDoc): PlanView {
  const { items, sched } = ctx;
  const cat = ctx.data.catalog;
  const prog = progress(plan, items, cat);
  return {
    // HOW CURRENT THIS IS, said rather than implied. A model with no
    // way to express staleness will answer as though the view were
    // live, and a student acting on an hour-old plan has no reason
    // to doubt it.
    as_of: ctx.updatedAt || undefined,
    revision: ctx.rev,
    freshness_note: ctx.updatedAt
      ? `This is the plan as it was last saved (${ctx.updatedAt}). If the student has edited it since in another window, say so rather than assuming this is current.`
      : undefined,
    edition: ctx.data.edition,
    edition_note:
      "Requirements come from the bulletin edition in force when the student entered their major. This plan follows " +
      `${ctx.data.edition}.`,
    programs: plan.programs,
    credits: { completed: prog.done, planned_total: prog.total },
    completed_courses: Object.keys(plan.completed).filter((c) => plan.completed[c]),
    terms: plan.terms.map((t, i) => ({
      index: i,
      label: t.label,
      credits: items.filter((it) => it.sem === i).reduce((sum, it) => sum + credOf(it, cat), 0),
      courses: items
        .filter((it) => it.sem === i && it.kind === "course")
        .map((it) => ({
          code: it.code,
          title: cat[it.code!]?.title ?? "(not in this edition's catalog — unverified)",
          // THREE STATES, NOT TWO (#49). `value === 2` alone reported
          // "satisfied" for a Course the catalog does not have at all,
          // right beside a title saying it is not in this edition — one
          // answer contradicting itself. An absence is the least
          // knowable case there is and must never read better than an
          // unparseable one.
          prerequisites: prereqWord(checkCourse(cat, it.code!, it.sem, sched)),
        })),
      open_slots: items
        .filter((it) => it.sem === i && it.kind === "slot")
        .map((it) => ({ slot_id: it.id, kind: it.slot, label: it.slotLabel, credits: it.credits })),
    })),
  };
}
