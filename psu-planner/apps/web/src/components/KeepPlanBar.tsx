/** The offer to keep a Plan that currently exists nowhere but here.
 *
 * A BAR ON THE CHART, NOT A MODAL. The student just asked for this plan;
 * covering it to talk about accounts spends the very moment the offer
 * exists to use. It sits in the layout beside the plan rather than over
 * it, and the plan stays fully usable while it is there.
 *
 * AFTER THE BUILD, NOT DURING IT. Putting a sign-in step inside the build
 * was considered and measured: 857ms desktop and 820ms phone on the
 * deployed app, and 968-1008ms across the four browser profiles here,
 * timed from the press of "Build my flowchart" to the first course card on
 * screen. There is no wait to fill — the overlay is gone before a prompt
 * could be read, let alone before a Google round trip could finish — so a
 * step there would mean slowing the build down on purpose to manufacture
 * an interruption. The beat after is stronger anyway: the student has just
 * been handed the thing they came for, and "keep this" is self-evidently
 * worth something.
 */
import { useEffect, useState } from "react";
import { currentUser, onAuthChange, signIn, syncConfigured } from "../data/sync";
import { dismissKeepPlanOffer, keepPlanOfferDismissed, shouldOfferToKeepPlan } from "../data/keepPlanOffer";

export function KeepPlanBar({ hasPlan }: { hasPlan: boolean }) {
  /** null while we do not yet know. `currentUser()` is a promise, and
   * defaulting to "signed out" would flash a warning about losing a plan
   * at the one student for whom it is already false. */
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(() => keepPlanOfferDismissed());

  useEffect(() => {
    if (!syncConfigured) return;
    void currentUser().then((u) => setSignedIn(!!u));
    // Signing in from this very bar is the common case, so the bar has to
    // hear about it: without this it would sit there promising to keep a
    // plan that is already being kept.
    return onAuthChange((u) => setSignedIn(!!u));
  }, []);

  if (signedIn === null) return null;
  if (!shouldOfferToKeepPlan({ configured: syncConfigured, hasPlan, signedIn, dismissed })) return null;

  return (
    // Not `role="alert"`. Nothing has gone wrong and nothing is waiting on
    // the student; an assertive announcement would interrupt a screen
    // reader mid-plan to deliver an offer.
    <aside className="keep-plan-bar" aria-label="Keep this plan">
      <p>
        <strong>This plan is only in this browser.</strong> Sign in with Google and it follows you to your
        phone — the same plan, nothing to build again.
      </p>
      <span className="kp-actions">
        <button type="button" className="primary" onClick={() => void signIn("google")}>
          Keep this plan
        </button>
        <button
          type="button"
          onClick={() => {
            dismissKeepPlanOffer();
            setDismissed(true);
          }}
        >
          Not now
        </button>
      </span>
    </aside>
  );
}
