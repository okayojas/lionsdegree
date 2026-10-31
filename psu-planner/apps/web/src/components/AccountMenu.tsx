/** Optional sign-in for cross-device sync. Hidden entirely when Supabase
 * isn't configured — the app stays fully local-first. */
import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { currentUser, pullNewerPlan, signIn, signOut, supabase, syncConfigured } from "../data/sync";
import { usePlanner, loadSavedPlan } from "../store";
import { chatConfigured } from "../chat/config";

export function AccountMenu({ onToast }: { onToast: (msg: string) => void }) {
  const [user, setUser] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const setPlan = usePlanner((s) => s.setPlan);

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

  if (!syncConfigured) return null;

  if (!user) {
    return (
      <div style={{ position: "relative" }}>
        <button className="btn-signin" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>Sign in</button>
        {open && (
          <div role="menu" style={{ position: "absolute", right: 0, top: 38, background: "var(--surface)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 10, padding: 8, zIndex: 60, display: "flex", flexDirection: "column", gap: 6, minWidth: 220, boxShadow: "var(--shadow-lg)" }}>
            <button role="menuitem" onClick={() => void signIn("azure")}>Microsoft (PSU account)</button>
            <button role="menuitem" onClick={() => void signIn("google")}>Google</button>
            <p style={{ fontSize: 10.5, color: "var(--muted)", margin: "2px 4px" }}>
              Syncs your plan across devices{chatConfigured ? " and unlocks the AI advisor" : ""}. Planning, the
              optimizer, and the degree audit all work without an account.
            </p>
          </div>
        )}
      </div>
    );
  }
  return (
    <button
      title={user.email ?? "signed in"}
      onClick={() => {
        if (confirm("Sign out? Your plan stays on this device and in your synced account.")) void signOut();
      }}
    >
      ✓ Syncing · {user.email?.split("@")[0] ?? "account"}
    </button>
  );
}
