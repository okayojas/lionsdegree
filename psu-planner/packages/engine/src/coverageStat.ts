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
import { poolFromRule, poolHasMembership, poolIsAdviserDefined } from "./requirements.js";
import type { ReqRule, ReqSection } from "./requirements.js";

export interface RequirementCoverage {
  /** Requirements that resolve to a testable list of courses. */
  resolved: number;
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

/** A rule that states a requirement. `note` is prose between requirements and
 * carries none, so it is not counted either way. */
function isRequirement(rule: ReqRule): boolean {
  return rule.type !== "note";
}

/** Generic so a caller can pass whole program objects -- they carry a slug
 * and much else -- without TypeScript's excess-property check rejecting the
 * literal. The function reads only `requirementSections`. */
export function requirementCoverage<T extends { requirementSections?: ReqSection[] }>(
  programs: readonly T[],
): RequirementCoverage {
  let resolved = 0;
  let unreadable = 0;
  let adviserDefined = 0;
  let considered = 0;

  for (const program of programs) {
    for (const section of program.requirementSections ?? []) {
      for (const rule of section.rules ?? []) {
        if (!isRequirement(rule)) continue;
        considered++;
        const pool = poolFromRule(rule);
        if (poolIsAdviserDefined(pool)) {
          adviserDefined++;
          continue;
        }
        if (poolHasMembership(pool)) resolved++;
        else unreadable++;
      }
    }
  }

  const total = considered - adviserDefined;
  return {
    resolved,
    unreadable,
    total,
    adviserDefined,
    considered,
    percent: total > 0 ? Math.round((resolved / total) * 100) : 0,
  };
}
