/** Optional account sync via Supabase — config-gated: with no
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY the app is purely local and the
 * account UI hides itself.
 *
 * Conflict policy: COMPARE-AND-SWAP on `rev` (ADR 0003). A write names the
 * revision it last saw on the server and lands only if the server is still
 * at it; otherwise it is refused and the student is told. This replaced
 * last-write-wins, under which two tabs editing the same Plan silently
 * destroyed one another's work. The losing local copy stays on the device
 * and in Plan history. */
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

/** Postgres' unique_violation. An insert that collides is a Plan the
 * server already has, which is a conflict, not a failure to retry. */
const UNIQUE_VIOLATION = "23505";

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
  // Names Plan history on purpose. "Your version is safe" has to point at
  // something the student can actually open, or it is a reassurance with
  // no door attached — and the conflict backup this file writes has no
  // reader, so Plan history (Menu) is the honest answer.
  return (
    "Not saved — this plan was changed somewhere else, maybe another tab or device. " +
    "Your version is still safe on this device and in Menu → Plan history. " +
    "Load the newer one to carry on from it."
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
/** The revision this device last saw the server holding, per Plan.
 *
 * THE PIECE A COUNTER CANNOT REPLACE. `plan.rev` is the local revision,
 * and it advances on every edit — including edits the server has never
 * seen, because the push is debounced and two quick edits coalesce into
 * one. So `plan.rev` says where this device IS, never what it was working
 * from, and a rule written against it is monotonicity, not agreement.
 *
 * Measured concretely: two tabs at rev 5, tab A edits once and pushes 6,
 * tab B edits TWICE and pushes 7. Against a "must increase" rule, 7 beats
 * 6 and tab A's work is gone — the exact failure this file exists to end.
 *
 * This is the other half: what the server said last time we agreed. A
 * write lands only if the server is still there. */
const SYNCED_REV_KEY = "lionsdegree-synced-rev";

function syncedRev(planId: string): number | null {
  try {
    const all = JSON.parse(localStorage.getItem(SYNCED_REV_KEY) ?? "{}") as Record<string, number>;
    return typeof all[planId] === "number" ? all[planId] : null;
  } catch {
    return null;
  }
}

export function rememberSyncedRev(planId: string, rev: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(SYNCED_REV_KEY) ?? "{}") as Record<string, number>;
    all[planId] = rev;
    localStorage.setItem(SYNCED_REV_KEY, JSON.stringify(all));
  } catch {
    /* quota — a lost marker costs one spurious conflict, never data */
  }
}

/** Push the local Plan, and refuse to overwrite work this device never saw.
 *
 * COMPARE-AND-SWAP, not last-write-wins and not a counter. The update is
 * conditional on the server still being at the revision we last agreed on;
 * if somebody else has written since, it matches no row, and no bytes move.
 *
 * It used to read the remote `updated_at`, compare, then upsert — a read
 * and a write with nothing holding them together, so two tabs saving at
 * once both passed their own check and the second erased the first. It
 * also compared clocks on two devices, which disagree quietly.
 *
 * Nothing is merged and nothing is overwritten on a guess (iron rule 2):
 * the caller is told, and the student decides. */
export async function pushPlan(plan: PlanDoc): Promise<"pushed" | "stale" | "off" | "failed"> {
  const sb = supabase();
  const user = await currentUser();
  if (!sb || !user) return "off";

  const base = syncedRev(plan.id);
  const row = { id: plan.id, user_id: user.id, doc: plan, rev: plan.rev, updated_at: plan.updatedAt };

  if (base === null) {
    // Never synced from here. An INSERT that collides means the row was
    // created elsewhere, which is the same conflict wearing a different
    // hat — not an error to retry.
    const { error } = await sb.from("plans").insert(row);
    if (!error) {
      rememberSyncedRev(plan.id, plan.rev);
      return "pushed";
    }
    if (error.code === UNIQUE_VIOLATION) return "stale";
    console.warn("[sync] plan insert failed", error);
    return "failed";
  }

  // `select()` so PostgREST returns the affected rows: zero means the
  // condition matched nothing, which is the refusal. Without it the
  // response is empty on both success and no-op and the two are
  // indistinguishable.
  const { data, error } = await sb
    .from("plans")
    .update(row)
    .eq("user_id", user.id)
    .eq("id", plan.id)
    .eq("rev", base)
    .select("rev");

  if (error) {
    if (isStaleRevError(error)) return "stale";
    console.warn("[sync] plan push failed", error);
    return "failed";
  }
  if (!data || data.length === 0) return "stale";

  rememberSyncedRev(plan.id, plan.rev);
  return "pushed";
}

/** Pull the remote Plan when it is one this device has not seen.
 *
 * `force` is what the conflict banner passes. WITHOUT IT THIS RETURNED
 * NULL IN THE ONE CASE IT EXISTS FOR: the gate below compares timestamps,
 * and the tab whose write was just refused is by definition the one that
 * edited LAST, so its local copy always looked newer and "Load the newer
 * plan" answered "nothing newer". Which contradicts the whole reason
 * `rev` replaced clocks — two devices' clocks disagree quietly.
 *
 * On sign-in the timestamp gate still earns its place: there is no
 * conflict to resolve, just two copies, and the most recently edited one
 * is the right default.
 *
 * Either way the local copy is backed up first and `rev` agreement is
 * recorded, so the next push is a clean compare-and-swap rather than an
 * immediate second refusal. */
export async function pullNewerPlan(local: PlanDoc | null, force = false): Promise<PlanDoc | null> {
  const sb = supabase();
  const user = await currentUser();
  if (!sb || !user) return null;
  const { data } = await sb
    .from("plans")
    .select("doc, rev, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const remote = data.doc as PlanDoc;
  if (!force && local && new Date(local.updatedAt) >= new Date(remote.updatedAt)) return null;
  if (local) {
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify(local)); } catch { /* full */ }
  }
  // We now agree with the server at this revision; the next push states it.
  rememberSyncedRev(remote.id, (data.rev as number) ?? remote.rev);
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
/** The Plan waiting to be pushed, or null when there is nothing owed.
 *
 * A DIRTY FLAG, and it is load-bearing. `flushPush` used to push whatever
 * it was handed, so hiding the tab twice with no edit between re-sent a
 * revision the server already held — which a compare-and-swap correctly
 * refuses, and the student was shown a conflict over a Plan nobody else
 * had touched. Crying wolf about data loss is its own kind of harm. */
let pending: PlanDoc | null = null;

async function send(plan: PlanDoc): Promise<void> {
  pending = null;
  const result = await pushPlan(plan);
  if (result === "stale") onConflict?.(plan);
  // A transient failure leaves the Plan owed, so the next flush retries it
  // rather than dropping it on the floor.
  else if (result === "failed") pending = plan;
}

/** Debounced push — call on every local mutation. */
export function schedulePush(plan: PlanDoc): void {
  if (!syncConfigured) return;
  pending = plan;
  clearTimeout(timer);
  timer = setTimeout(() => { void send(plan); }, 2500);
}

/** Flush a pending push immediately.
 *
 * The debounce is 2.5 seconds, which is most of the time a student spends
 * between an edit and switching away. Called when the tab is hidden, so
 * the copy on the server is the one they just made rather than the one
 * before it — and so the conflict, if there is one, surfaces while they
 * are still thinking about the edit that caused it. */
export async function flushPush(): Promise<void> {
  if (!syncConfigured || !pending) return;
  clearTimeout(timer);
  await send(pending);
}
