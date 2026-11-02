/** Declaring and withdrawing a Program, whole (#47).
 *
 * `addProgram` and `removeProgram` do the merge. They do NOT leave a Plan
 * a student could follow: the new Program's courses sit where the merge
 * put them, its General Education Slots have not been reconciled against
 * the ones the Plan already had, and a Scholar's honors sections have not
 * been applied to anything new. Three more steps have to run, in order,
 * and until this file they ran in TWO PLACES -- `addProgramNow` in the
 * planner's store and `add_program` in the connector.
 *
 * TWO COPIES OF A SEQUENCE IS THE DIVERGENCE #39 EXISTS TO PREVENT, and
 * this project has now paid for it three times in one ticket set (#53,
 * #54, and the half of #50 that was the planner and the connector
 * answering the same question differently). The failure mode is not that
 * one copy is wrong on the day it is written; it is that six months
 * later somebody improves one of them. A student would then get a
 * different plan depending on whether they clicked the menu or asked
 * their assistant -- and neither answer would be wrong enough to look
 * like a bug.
 *
 * WHY THE ORDER IS THE WAY IT IS, since that is the part a second
 * implementation gets subtly wrong:
 *
 *   1. MERGE. Fold the Template in, keeping everything the student has
 *      done: completed Courses, their own additions, filled Slots,
 *      Constraints, and the Origin that makes a shared requirement count
 *      once.
 *   2. REFINE GEN EDS, against the WHOLE merged Plan rather than the new
 *      Program alone. A second Program's own courses can cover a bucket
 *      the first Program had an open Slot for, and refining before the
 *      merge would never see that. Doing it after means the student is
 *      not shown two Slots for one university requirement.
 *   3. OPTIMIZE, LAST (iron rule 5). The cap-aware optimizer is the final
 *      word on where everything sits; anything that moves cards after it
 *      has run can put a Plan back over its credit ceiling.
 *   4. HONORS, which is a no-op for the 95% of students who are not
 *      Scholars and a swap of specific sections for the rest. It runs
 *      after the optimizer because it substitutes one Course for another
 *      in place -- MATH 140 for MATH 140H -- without moving anything.
 *
 * WHAT IS DELIBERATELY NOT HERE. Loading the Template, loading the
 * subjects it brings, and writing the result are the CALLER's: the
 * planner fetches over HTTP and persists to localStorage, the connector
 * reads an asset binding and does a compare-and-swap against Postgres.
 * Those have nothing in common and pretending otherwise would put a
 * transport decision in the engine.
 */
import { addProgram, removeProgram } from "./programMerge.js";
import type { AddProgramResult, ProgramMergeOptions, RemoveProgramPreview } from "./programMerge.js";
import { refineGenEdSlots } from "./genEd.js";
import { applyHonorsUpgrades } from "./honors.js";
import { optimizeSchedule } from "./optimize.js";
import type { FlowchartPatterns } from "./flowchartPatterns.js";
import type { ProgramTemplate } from "./planGen.js";
import type { Catalog, PlanDoc } from "./types.js";

export interface DeclareProgramOptions extends ProgramMergeOptions {
  /** Courses the resulting Plan will be read against. The CALLER is
   * responsible for having loaded the subjects the Template names: an
   * unloaded Course has no prerequisite structure, and the Plan would
   * report "cannot be checked" against every course the Program brought. */
  catalog: Catalog;
  /** The credit ceiling the optimizer packs to. Both surfaces use 19,
   * which is Penn State's own limit without a dean's permission; it is an
   * option because the number belongs to the caller's policy, not to the
   * act of declaring a Program. */
  maxCredits?: number;
  /** Term-shape hints the planner reads from the catalog. The Worker has
   * no copy of them, which is why this is optional rather than required
   * -- and why `optimizeSchedule` has a default. */
  patterns?: FlowchartPatterns;
}

/** Every Course code a Template names, so a caller can make sure their
 * catalog covers them before the merge runs.
 *
 * WIDER THAN `programMerge`'s own `definiteCourses`, and deliberately.
 * That one answers "what does this Program actually require", so it
 * excludes choice groups — an option is not a requirement. This one
 * answers "whose prerequisites will the resulting Plan be read against",
 * and a Course offered as an alternative or named in a choice group can
 * end up in the Plan or be ranked as a candidate for a Slot. Over-reading
 * costs one subject file; under-reading makes the Plan answer "cannot be
 * checked" about a Course the catalog holds.
 *
 * HERE RATHER THAN IN EACH CALLER because the two surfaces were about to
 * each have their own: the planner derived the list by merging first and
 * reading the result, the connector by walking the Template. Same
 * question, two answers, and the planner's needed a throwaway merge to
 * get it. */
export function templateCourseCodes(t: ProgramTemplate): string[] {
  const out = new Set<string>();
  for (const sem of t.semesters) {
    for (const e of sem.entries) {
      if (e.type === "course" && e.code) {
        out.add(e.code);
        for (const a of e.alternatives ?? []) out.add(a);
      }
    }
  }
  for (const section of t.requirements ?? []) {
    for (const rule of section.rules) {
      if (rule.type === "course") out.add(rule.code);
      if (rule.type === "oneOf" || rule.type === "chooseN") {
        for (const code of rule.options) out.add(code);
      }
    }
  }
  return [...out];
}

/** Add a Program to a Plan and leave a schedule a student could follow.
 *
 * Mutates `plan` in place, like the rest of the engine. Both surfaces
 * hand it a COPY, because a merge that throws halfway must not leave the
 * live Plan half-written. */
export function declareProgram(
  plan: PlanDoc,
  template: ProgramTemplate,
  opts: DeclareProgramOptions,
): AddProgramResult {
  const { catalog, maxCredits = 19, patterns, ...merge } = opts;
  const result = addProgram(plan, template, merge);
  // ALREADY THEIRS IS NOT A CHANGE. Re-flowing a Plan nobody altered
  // would move cards for no reason and hand back a revision bump the
  // student never asked for.
  if (result.alreadyPresent) return result;

  refineGenEdSlots(plan, catalog);
  optimizeSchedule(plan, catalog, { maxCredits, patterns });
  if (plan.honors) applyHonorsUpgrades(plan, catalog);
  return result;
}

/** Withdraw a Program and re-flow what is left.
 *
 * NO HONORS STEP, and that is not an omission. `applyHonorsUpgrades`
 * substitutes honors sections INTO a Plan; withdrawing a Program removes
 * cards, and running it here would re-apply upgrades to courses that are
 * still there and already upgraded. The Plan a student is left with is
 * their remaining Programs' Plan, honors and all, because nothing
 * touched it.
 *
 * Returns the preview describing exactly what it did, so a caller can
 * tell the student rather than guess. A refusal is returned unapplied:
 * `removeProgram` runs `previewRemoveProgram` itself and stops on one,
 * and nothing below runs either. */
export function withdrawProgram(
  plan: PlanDoc,
  slug: string,
  opts: DeclareProgramOptions & { remaining?: ProgramTemplate[] },
): RemoveProgramPreview {
  const { catalog, maxCredits = 19, patterns, remaining } = opts;
  const result = removeProgram(plan, slug, { remaining, catalog });
  if (result.refusal) return result;

  refineGenEdSlots(plan, catalog);
  optimizeSchedule(plan, catalog, { maxCredits, patterns });
  return result;
}
