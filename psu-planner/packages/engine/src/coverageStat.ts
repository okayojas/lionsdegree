/** How much of a catalog edition resolves to named courses.
 *
 * Published on the site, so it is computed from the data rather than claimed,
 * and it is explicit about what it leaves out.
 *
 * Adviser-Defined Requirements sit in NEITHER half of the fraction. Counting
 * them as failures would cap the figure below 100% forever for requirements
 * that have no list by design; counting them as successes would inflate it,
 * because nothing resolved. They are reported separately so the exclusion is
 * visible rather than buried -- which is what makes the rest of the number
 * worth believing.
 *
 * A row we could not PARSE is the opposite case. It stays in the denominator,
 * because otherwise the figure improves every time the parser gets worse: the
 * one way a computed number can still lie. `poolIsAdviserDefined` exists to
 * keep those two apart (see requirements.ts).
 */
import { poolFromRule, poolIsAdviserDefined } from "./requirements.js";
import type { ReqSection } from "./requirements.js";

export interface RequirementCoverage {
  /** Requirements the planner can check: `named` + `patterned`. */
  resolved: number;
  /** Resolve to an explicit list of course codes. */
  named: number;
  /** Resolve to a subject and a level ("any 400-level HIST") rather than a
   * list. Checkable, but NOT a named list -- kept separate so the published
   * wording can be true of each part rather than true on average. */
  patterned: number;
  /** General Education categories. These parse fine; they are answered by the
   * gen-ed audit, which tests a designation rather than a course code, so
   * they are not counted as resolved. Counting them as failures understates
   * the figure, which is the direction to err. */
  genEd: number;
  /** Requirements we could not read. In the denominator, deliberately. */
  unreadable: number;
  /** The denominator: everything except adviser-defined requirements. */
  total: number;
  /** Stated separately. Not a failure, not a success -- no list exists. */
  adviserDefined: number;
  /** Every requirement looked at, including the adviser-defined ones. */
  considered: number;
  /** `resolved / total`, rounded. 0 when there is nothing to count. */
  percent: number;
}

export function requirementCoverage(
  programs: readonly { requirementSections?: ReqSection[] }[],
): RequirementCoverage {
  let named = 0;
  let patterned = 0;
  let genEd = 0;
  let unreadable = 0;
  let adviserDefined = 0;
  let considered = 0;

  for (const program of programs) {
    for (const section of program.requirementSections ?? []) {
      for (const rule of section.rules ?? []) {
        // A null Pool means the row states no requirement -- `note`, which is
        // prose between requirements. Asking poolFromRule rather than
        // re-listing the rule types here keeps ONE place that decides it; a
        // copy would need editing in step with that switch forever.
        const pool = poolFromRule(rule);
        if (pool === null) continue;
        considered++;
        if (poolIsAdviserDefined(pool)) {
          adviserDefined++;
          continue;
        }
        if (pool?.kind === "listed" || pool?.kind === "registry") named++;
        else if (pool?.kind === "patterned") patterned++;
        else if (pool?.kind === "genEd") genEd++;
        else unreadable++;
      }
    }
  }

  const total = considered - adviserDefined;
  const resolved = named + patterned;
  return {
    resolved,
    named,
    patterned,
    genEd,
    unreadable,
    total,
    adviserDefined,
    considered,
    percent: total > 0 ? Math.round((resolved / total) * 100) : 0,
  };
}
