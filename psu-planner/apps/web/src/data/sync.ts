/** Optional account sync via Supabase — config-gated: with no
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY the app is purely local and the
 * account UI hides itself. Conflict policy: last-write-wins by updatedAt, and
 * the losing local copy is kept as a restorable backup in localStorage. */
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { PlanDoc } from "@psu-planner/engine";

/** The config gate lives in `sync-config.ts`, which imports no Supabase code,
 * so a caller can ask "is sync on?" without downloading the client. */
import { supabaseUrl as url, supabaseAnonKey as anonKey, syncConfigured } from "./sync-config";

export { syncConfigured };

let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient | null {
  if (!syncConfigured) return null;
  if (!client) {
    try {
      client = createClient(url!, anonKey!);
    } catch (e) {
      // Belt and braces: never let a client-construction failure take the app down.
      console.error("[sync] could not create the Supabase client; running local-only.", e);
      return null;
    }
  }
  return client;
}

export async function currentUser(): Promise<User | null> {
  const sb = supabase();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data.user ?? null;
}

/** Where OAuth should drop the student back.
 *
 * The PAGE they signed in from, not the origin. `window.location.origin` was
 * correct until #6 split the build: the origin root is now the landing page,
 * so signing in from the planner bounced the student out to the marketing
 * page and they had to find their way back in.
 *
 * Pathname only -- no query or hash. Supabase appends its own parameters to
 * this URL, and carrying a stale `?` or `#` into that is how redirect URLs
 * stop matching an allow-list entry. */
export function signInRedirectTo(loc: { origin: string; pathname: string }): string {
  return `${loc.origin}${loc.pathname}`;
}

export async function signIn(provider: "google" | "azure"): Promise<void> {
  const sb = supabase();
  if (!sb) return;
  await sb.auth.signInWithOAuth({
    provider,
    options: { redirectTo: signInRedirectTo(window.location) },
  });
}

export async function signOut(): Promise<void> {
  await supabase()?.auth.signOut();
}

/** Access token (JWT) for the API's identity gate (S1), or null when signed out
 * or unconfigured. `getSession()` refreshes an expired token, so this is safe to
 * call once per request rather than caching it. */
export async function accessToken(): Promise<string | null> {
  const sb = supabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Subscribe to sign-in/sign-out. Returns an unsubscribe function (no-op when
 * Supabase isn't configured, so callers don't need to branch). */
export function onAuthChange(cb: (user: User | null) => void): () => void {
  const sb = supabase();
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange((_evt, session) => cb(session?.user ?? null));
  return () => data.subscription.unsubscribe();
}

const BACKUP_KEY = "lionsdegree-conflict-backup";

/** The SQLSTATE migration 0003's trigger raises on a stale write.
 *
 * The contract between that migration and this file. Matching on the
 * message text instead would break the first time the wording improves,
 * and matching on nothing would mean every failure looked alike. */
export const STALE_REV_CODE = "LD001";

/** Was this write refused because the stored Plan had already moved on?
 *
 * Narrow on purpose. Reading a network blip or an expired token as "someone
 * else edited this" would tell a student a specific and false story about
 * their own work, which is worse than saying nothing at all. */
export function isStaleRevError(error: { code?: string } | null | undefined): boolean {
  return !!error && error.code === STALE_REV_CODE;
}

/** What a student reads when their save was refused.
 *
 * Three things, because leaving any of them out changes what they do next:
 * the save did not happen, nothing was destroyed, and here is the one
 * action. No revision numbers — `rev` is a fact about our schema, not
 * about their degree. */
export function conflictMessage(): string {
  return (
    "Not saved — this plan was changed somewhere else, maybe another tab or device. " +
    "Your version is still safe on this device. Reload to pick up the newer one."
  );
}

/** Push the local plan.
 *
 * THE DATABASE DECIDES, not this function. It used to read the remote
 * `updated_at`, compare, and then upsert — a read followed by a write with
 * nothing holding them together, so two tabs saving at once both passed
 * their own check and the second silently erased the first. It also
 * compared clocks on two devices, which disagree quietly.
 *
 * Now the write states the `rev` it was computed from, and the trigger in
 * migration 0003 refuses it if the stored Plan has moved on. Nothing is
 * merged and nothing is overwritten on a guess (iron rule 2) — the caller
 * is told, and the student decides. */
export async function pushPlan(plan: PlanDoc): Promise<"pushed" | "stale" | "off" | "failed"> {
  const sb = supabase();
  const user = await currentUser();
  if (!sb || !user) return "off";

  const { error } = await sb.from("plans").upsert({
    id: plan.id,
    user_id: user.id,
    doc: plan,
    rev: plan.rev,
    updated_at: plan.updatedAt,
  });

  if (!error) return "pushed";
  if (isStaleRevError(error)) {
    // Keep the local copy recoverable before anyone offers to replace it.
    // The same backup slot the sign-in path uses, for the same reason.
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(plan));
    } catch {
      /* quota — the plan is still in its own key, this is the extra copy */
    }
    return "stale";
  }
  // Anything else is a transient we should not dress up as a conflict.
  // The plan is in localStorage either way; the next edit pushes again.
  console.warn("[sync] plan push failed", error);
  return "failed";
}

/** Pull the newest remote plan; if it beats local, back local up and return it. */
export async function pullNewerPlan(local: PlanDoc | null): Promise<PlanDoc | null> {
  const sb = supabase();
  const user = await currentUser();
  if (!sb || !user) return null;
  const { data } = await sb
    .from("plans")
    .select("doc, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const remote = data.doc as PlanDoc;
  if (local && new Date(local.updatedAt) >= new Date(remote.updatedAt)) return null;
  if (local) {
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify(local)); } catch { /* full */ }
  }
  return remote;
}

/** Told when a background push was refused because the Plan moved on.
 *
 * `schedulePush` is fire-and-forget by design — a student should not wait
 * on a network round trip to keep editing — and its result was being
 * dropped on the floor. That was survivable while a refusal could not
 * happen; now that one can, dropping it would mean the student kept
 * working against a copy that had quietly stopped saving, which is the
 * silent failure this whole ticket exists to end.
 *
 * A single subscriber: the planner shell. Not an event emitter, because
 * there is one listener and there is no second one coming. */
type ConflictListener = (plan: PlanDoc) => void;
let onConflict: ConflictListener | null = null;

export function setConflictListener(fn: ConflictListener | null): void {
  onConflict = fn;
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Debounced push — call on every local mutation. */
export function schedulePush(plan: PlanDoc): void {
  if (!syncConfigured) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    void pushPlan(plan).then((result) => {
      if (result === "stale") onConflict?.(plan);
    });
  }, 2500);
}

/** Flush a pending push immediately.
 *
 * The debounce is 2.5 seconds, which is most of the time a student spends
 * between an edit and switching away. Called when the tab is hidden, so
 * the copy on the server is the one they just made rather than the one
 * before it — and so the conflict, if there is one, surfaces while they
 * are still thinking about the edit that caused it. */
export async function flushPush(plan: PlanDoc): Promise<void> {
  if (!syncConfigured) return;
  clearTimeout(timer);
  const result = await pushPlan(plan);
  if (result === "stale") onConflict?.(plan);
}
