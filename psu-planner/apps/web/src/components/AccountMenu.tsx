/** Optional sign-in for cross-device sync. Hidden entirely when Supabase
 * isn't configured — the app stays fully local-first. */
import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  bringBackTheAccountsPlan, currentUser, findPlansAtSignIn, keepThisDevicesPlan, signIn, signOut, supabase,
  syncConfigured, takeTheAccountsPlan, type PlanCollision, type PlanSetAside,
} from "../data/sync";
import { usePlanner, loadSavedPlan, recordInPlanHistory } from "../store";
import { chatConfigured } from "../chat/config";
import { PlanCollisionDialog } from "./PlanCollisionDialog";

/** Penn State accounts do not work yet.
 *
 * The Microsoft button used to read "Microsoft (PSU account)" — which
 * is the option a Penn State student will reach for first, and it
 * fails: the app is not approved in the university's tenant, so their
 * own address is refused with an error that reads like they typed it
 * wrong. A path that looks like it works and cannot is worse than one
 * that is not offered, and worse again when it is the path the whole
 * audience will pick. Offered, but plainly labelled, because "it will
 * come" is information a student can use and silence is not. */
const PSU_MICROSOFT_WORKS = false;

export function AccountMenu({
  onToast,
  openOnMount = false,
}: {
  onToast: (msg: string) => void;
  /** Arrived from the landing page's "Sign in" (`/plan/?signin=1`), so the
   * menu opens itself rather than making the student hunt for the control
   * they just asked for. Ignored once they are signed in — the same link
   * then lands them on their plan, which is what they wanted anyway. */
  openOnMount?: boolean;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [open, setOpen] = useState(openOnMount && syncConfigured);
  /** Two plans and a question. Held here because this is where sign-in is
   * noticed, and sign-in is noticed here whichever control started it —
   * the offer on the chart, this menu, or the landing page's link. One
   * listener means the safe path is not only the one through the prompt. */
  const [collision, setCollision] = useState<PlanCollision | null>(null);
  /** The account's Plan, not loaded because the student started over.
   * Said, with the way back beside it: a Plan that silently stopped
   * appearing would read as lost. */
  const [setAside, setSetAside] = useState<PlanSetAside | null>(null);
  const setPlan = usePlanner((s) => s.setPlan);
  const wrap = useRef<HTMLDivElement>(null);
  /** The account whose sign-in has already been dealt with. See the guard
   * in the listener below. */
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!syncConfigured) return;
    void currentUser().then(setUser);
    const sb = supabase();
    const { data } = sb!.auth.onAuthStateChange(async (_evt, session) => {
      const u = session?.user ?? null;
      setUser(u);
      if (!u) {
        handled.current = null;
        return;
      }
      // ONCE PER SIGN-IN, not once per event. Supabase announces an
      // existing session on load and again on every token refresh, and
      // what follows now WRITES: a second run inserts a plan the first run
      // has just inserted, which the database refuses and the student is
      // shown a conflict notice about a plan nobody else has touched. It
      // would also re-open the choice between two plans, hours later, over
      // a question they have already answered.
      if (handled.current === u.id) return;
      handled.current = u.id;
      // WHAT SIGNING IN FOUND, not what a clock thinks. This used to be
      // `pullNewerPlan`, which answered the two-plans case by timestamp and
      // left the loser unreachable through the UI for ever.
      const found = await findPlansAtSignIn(loadSavedPlan());
      if (found.kind === "adopted") {
        await setPlan(found.plan);
        onToast("Loaded your most recent plan from another device (this device's copy was backed up).");
      } else if (found.kind === "kept") {
        onToast("Saved this plan to your account — open the site on another device and it will be there.");
      } else if (found.kind === "unsaved") {
        // Said plainly. "Signed in" on its own would read as a promise we
        // have not yet kept, which is the failure this ticket exists to end.
        onToast("Signed in, but this plan has not reached your account yet. It is safe on this device, and the next change you make will try again.");
      } else if (found.kind === "collision") {
        setCollision(found);
      } else if (found.kind === "set-aside") {
        setSetAside(found);
      }
    });
    return () => data.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Act on the student's choice. BOTH PLANS SURVIVE EITHER BRANCH: the
   * one that is not adopted goes into Plan history, which is the recovery
   * door the rest of the app already points at, and the account's row is
   * never written over — this device's plan has its own id and inserts
   * beside it. */
  const keep = async (c: PlanCollision, which: "device" | "account") => {
    setCollision(null);
    if (which === "account") {
      await setPlan(takeTheAccountsPlan(c));
      onToast("Carrying on with the plan from your account. The one this device had is in Menu → Plan history.");
      return;
    }
    // The account's plan would otherwise exist only in Postgres, where
    // nothing in this interface can reach it: the sign-in read takes the
    // newest row, and this device's plan is about to become that.
    recordInPlanHistory(c.remote, "found in your account");
    const pushed = await keepThisDevicesPlan(c);
    onToast(
      pushed === "pushed"
        ? "Carrying on with the plan from this device, now saved to your account. The other one is in Menu → Plan history."
        : "Carrying on with the plan from this device. It has not reached your account yet — the next change you make will try again. The other one is in Menu → Plan history.",
    );
  };

  // Close on a click anywhere else, and on Escape. A menu that can only
  // be dismissed by choosing something from it is a trap.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (!syncConfigured) return null;

  const panel: React.CSSProperties = {
    position: "absolute",
    right: 0,
    top: 38,
    background: "var(--surface)",
    color: "var(--text)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    padding: 8,
    zIndex: 60,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 240,
    boxShadow: "var(--shadow-lg)",
  };
  const note: React.CSSProperties = { fontSize: 10.5, color: "var(--muted)", margin: "2px 4px" };

  /** Rendered from BOTH branches below. The sign-in that raises it is also
   * what flips this component from signed-out to signed-in, and a question
   * that disappeared because the button next to it changed shape would
   * leave the student with a silently chosen plan — the exact outcome this
   * dialog exists to prevent. */
  const askWhichPlan = collision && (
    <PlanCollisionDialog
      local={collision.local}
      remote={collision.remote}
      onKeep={(which) => void keep(collision, which)}
    />
  );

  if (!user) {
    return (
      <div ref={wrap} style={{ position: "relative" }}>
        {askWhichPlan}
        <button className="btn-signin" data-tour="signin" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          Sign in
        </button>
        {open && (
          <div role="menu" style={panel}>
            <button role="menuitem" onClick={() => void signIn("google")}>
              Google
            </button>
            {PSU_MICROSOFT_WORKS ? (
              <button role="menuitem" onClick={() => void signIn("azure")}>
                Microsoft (PSU account)
              </button>
            ) : (
              <>
                <button role="menuitem" disabled title="Not available yet">
                  Microsoft (PSU account)
                </button>
                <p style={note}>
                  Penn State accounts aren&rsquo;t working yet — the university has to approve the app first. Use
                  Google in the meantime; you can switch later and keep the same plan.
                </p>
              </>
            )}
            <p style={note}>
              Syncs your plan across devices{chatConfigured ? " and unlocks the AI advisor" : ""}. Planning, the
              optimizer, and the degree audit all work without an account.
            </p>
          </div>
        )}
      </div>
    );
  }

  const who = user.email?.split("@")[0] ?? "account";
  return (
    <div ref={wrap} style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {askWhichPlan}
      {/* STARTED OVER, SIGNED IN. The plan in the account is the one the
          student walked away from, so it is not loaded; this says so and
          is the way back. When their new plan is ready they are asked
          which of the two to keep. */}
      {setAside && (
        <p className="started-over" role="status">
          You started over. The plan in your account has not been changed.{" "}
          <button
            type="button"
            onClick={async () => {
              const back = bringBackTheAccountsPlan(setAside);
              setSetAside(null);
              await setPlan(back);
              onToast("Brought back the plan from your account.");
            }}
          >
            Bring it back
          </button>
        </p>
      )}
      {/* NOT "SYNCING". That read as a spinner that never finished — a
          student who had signed in successfully asked why it was stuck,
          because a present participle describes something in progress.
          This is a state, not a task: it is on, and it is done. */}
      <button aria-haspopup="menu" aria-expanded={open} title={user.email ?? "signed in"} onClick={() => setOpen(!open)}>
        ✓ {who}
      </button>
      {open && (
        <div role="menu" style={panel}>
          <p style={{ ...note, margin: "2px 4px 6px" }}>
            Signed in as <strong style={{ color: "var(--text)" }}>{user.email ?? who}</strong>
            <br />
            Your plan is saved to this account and synced to your other devices.
          </p>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onToast("Your plan is saved to your account. Open Menu → Plan history to see earlier versions.");
            }}
          >
            Where is my plan saved?
          </button>
          <a role="menuitem" href="/connect/" style={{ textAlign: "left" }}>
            Connect an AI assistant
          </a>
          <a role="menuitem" href="/privacy/" style={{ textAlign: "left" }}>
            Privacy
          </a>
          <button
            role="menuitem"
            onClick={() => {
              if (confirm("Sign out? Your plan stays on this device and in your synced account.")) void signOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
