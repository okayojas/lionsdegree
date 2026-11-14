/** When to offer to keep the Plan, and how long "not now" lasts.
 *
 * A Plan lives in this browser's localStorage until the student signs in,
 * and nothing in the product ever said so. Clear the browser, switch
 * laptops, open the site on a phone — it is gone, and the first they hear
 * of it is its absence.
 *
 * The rule is three conditions and no cleverness, which is why it is here
 * rather than inline in the component: the component cannot be rendered in
 * the fast suite, and "appears on exactly one screen under exactly three
 * conditions" is the whole of what this feature promises.
 */

/** sessionStorage, NOT localStorage, and that is the decision.
 *
 * A student who says "not now" on their first Plan and comes back a week
 * later is asking a different question from one who said it ten seconds
 * ago. A permanent dismissal would answer the second question for ever on
 * the strength of the first. The account control in the toolbar stays
 * available either way, so nothing here is the only way in. */
const DISMISSED_KEY = "lionsdegree-keep-plan-dismissed";

/** Has the student already waved this away in this sitting? */
export function keepPlanOfferDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // Storage disabled (private browsing, or a locked-down profile). The
    // write below cannot have landed either, so there is no dismissal to
    // honour — and an offer with a "Not now" beside it is the harmless
    // failure. Never the reverse: hiding it would silently remove the one
    // place the student is told their Plan is only on this device.
    return false;
  }
}

export function dismissKeepPlanOffer(): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    /* storage disabled — the offer reappears on the next load, which is
       the cost of not being able to remember anything at all */
  }
}

/** Every condition the offer depends on, named rather than read from the
 * world, so each one can be asked about on its own. */
export interface KeepPlanConditions {
  /** `syncConfigured`. A self-hosted build with no Supabase has no account
   * to offer, and this gate is the one every other account surface uses. */
  configured: boolean;
  /** A Plan exists on this device. There is nothing to keep before one
   * does, and the build itself is not the moment either: measured at
   * 968-1008ms, it is over before a prompt could be read. */
  hasPlan: boolean;
  /** Already signed in — in which case the Plan is already being kept and
   * the chart should not carry a message about something already true. */
  signedIn: boolean;
  dismissed: boolean;
}

export function shouldOfferToKeepPlan(c: KeepPlanConditions): boolean {
  return c.configured && c.hasPlan && !c.signedIn && !c.dismissed;
}
