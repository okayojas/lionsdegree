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
 *
 * AFTER "NOT NOW", ONE LINE STAYS (#70). The owner expects few students to
 * sign in, and "Not now" used to be the last a student heard of it for the
 * rest of the sitting. The full bar gives way to a single line that says
 * the plan is only on this device and offers the way in. It is a line and
 * not a label in the toolbar, where the spec first put it: the toolbar has
 * no room on a phone, and on a phone a row costs the chart its height.
 * After ten real edits the full offer returns, once.
 */
import { useEffect, useRef, useState } from "react";
import { contentsOf, type PlanDoc } from "@psu-planner/engine";
import { currentUser, onAuthChange, signIn, syncConfigured } from "../data/sync";
import { dismissKeepPlanOffer, keepPlanOfferDismissed, noteEditSinceNotNow, whatToShow } from "../data/keepPlanOffer";
import { usePlanner } from "../store";

/** What an edit changes, for THIS purpose: the plan's contents. Not where
 * the student has panned to (panning advances the Revision, and ten pans
 * are not ten things worth keeping), and not the what-ifs beside it. */
function whatAnEditChanges(plan: PlanDoc): string {
  const { view: _view, ...contents } = contentsOf(plan);
  return JSON.stringify(contents);
}

export function KeepPlanBar({ plan }: { plan: PlanDoc | null }) {
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
    // plan that is, as of a moment ago, already kept.
    return onAuthChange((u) => setSignedIn(!!u));
  }, []);

  const shows = signedIn === null
    ? "nothing"
    : whatToShow({ configured: syncConfigured, hasPlan: !!plan, signedIn, dismissed });

  // Edits made after "Not now" bring the offer back, once (keepPlanOffer.ts).
  // ONLY WHILE THE REMINDER IS SHOWING: for a student who is signed in, or
  // has not said "Not now", there is nothing to count and no reason to
  // read the plan on every Revision.
  const tab = usePlanner((s) => s.candidateId);
  const watched = useRef<{ tab: string | null; contents: string } | null>(null);
  const [cameBack, setCameBack] = useState(false);
  const rev = plan?.rev;
  useEffect(() => {
    if (!plan || shows !== "reminder") { watched.current = null; return; }
    const now = { tab, contents: whatAnEditChanges(plan) };
    const before = watched.current;
    watched.current = now;
    // Nothing to compare with yet, or ANOTHER TAB: opening a what-if puts
    // a different plan in view without anything having been edited, and
    // comparing across it counted looking around as work.
    if (!before || before.tab !== now.tab || before.contents === now.contents) return;
    if (noteEditSinceNotNow()) {
      setCameBack(true);
      setDismissed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, tab, shows]);

  if (shows === "nothing") return null;

  if (shows === "reminder") {
    return (
      <aside className="keep-plan-note" aria-label="Where this plan is saved">
        <p>
          <strong>Only on this device.</strong> This plan is saved in this browser and nowhere else.
        </p>
        <button type="button" onClick={() => void signIn("google")}>Sign in to keep it</button>
      </aside>
    );
  }

  return (
    // Not `role="alert"`. Nothing has gone wrong and nothing is waiting on
    // the student; an assertive announcement would interrupt a screen
    // reader mid-plan to deliver an offer.
    // When it has COME BACK after "Not now" it is a polite status, so a
    // screen reader hears that the offer is there again; the first time
    // it is simply part of the page the student has just been given.
    <aside className="keep-plan-bar" aria-label="Keep this plan" role={cameBack ? "status" : undefined}>
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
