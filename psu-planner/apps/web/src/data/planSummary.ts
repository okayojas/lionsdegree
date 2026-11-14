/** A Plan described in things a student can check.
 *
 * Written for the one screen where somebody has to tell two of their own
 * Plans apart — the choice after signing in with a Plan already in the
 * account. A plan id is the honest identifier and a useless one: it is a
 * random string, both Plans have one, and neither has ever been shown.
 * What a student can actually recognise is which Programs a Plan is for,
 * how long it runs, and when they last touched it.
 */
import type { PlanDoc } from "@psu-planner/engine";

export interface PlanSummary {
  /** The Programs, named from the catalog where it knows them. */
  programs: string;
  /** How many Terms the Plan runs for. */
  terms: number;
  /** When the Plan was last changed, in the reader's own locale — the same
   * spelling Plan history uses, so the two screens can be compared. */
  changed: string;
}

/** `nameFor` is a lookup, not a fetch, so this stays pure and the caller
 * decides how hard to try. A slug it does not know comes back as the slug:
 * two Plans can be pinned to different Editions, and a Program the current
 * catalog has dropped must still be nameable as SOMETHING. */
export function describePlan(plan: PlanDoc, nameFor: (slug: string) => string | undefined): PlanSummary {
  const programs = plan.programs.map((slug) => nameFor(slug) ?? slug);
  const when = new Date(plan.updatedAt);
  return {
    // An empty list is possible in a saved file and would otherwise render
    // as nothing at all, leaving one of the two choices blank.
    programs: programs.length ? programs.join(" + ") : "no program recorded",
    terms: plan.terms.length,
    // NaN rather than a wrong date: an unparseable timestamp says so
    // instead of being rendered as "Invalid Date", which reads like a bug
    // in the student's plan rather than a gap in what we know about it.
    changed: Number.isNaN(when.getTime()) ? "date not recorded" : when.toLocaleString(),
  };
}
