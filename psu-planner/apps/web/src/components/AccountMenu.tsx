/** Optional sign-in for cross-device sync. Hidden entirely when Supabase
 * isn't configured — the app stays fully local-first. */
import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { currentUser, pullNewerPlan, signIn, signOut, supabase, syncConfigured } from "../data/sync";
import { usePlanner, loadSavedPlan } from "../store";
import { chatConfigured } from "../chat/config";

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

export function AccountMenu({ onToast }: { onToast: (msg: string) => void }) {
  const [user, setUser] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const setPlan = usePlanner((s) => s.setPlan);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!syncConfigured) return;
    void currentUser().then(setUser);
    const sb = supabase();
    const { data } = sb!.auth.onAuthStateChange(async (_evt, session) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u) {
        // Newly signed in: adopt the newest device's plan (LWW; local backed up).
        const remote = await pullNewerPlan(loadSavedPlan());
        if (remote) {
          await setPlan(remote);
          onToast("Loaded your most recent plan from another device (this device's copy was backed up).");
        }
      }
    });
    return () => data.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  if (!user) {
    return (
      <div ref={wrap} style={{ position: "relative" }}>
        <button className="btn-signin" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
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
    <div ref={wrap} style={{ position: "relative" }}>
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
