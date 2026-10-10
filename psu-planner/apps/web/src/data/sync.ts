/** Optional account sync via Supabase — config-gated: with no
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY the app is purely local and the
 * account UI hides itself. Conflict policy: last-write-wins by updatedAt, and
 * the losing local copy is kept as a restorable backup in localStorage. */
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { PlanDoc } from "@psu-planner/engine";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** The gate used to test PRESENCE only, so a placeholder left in `.env.local`
 * (`https://<project-ref>.supabase.co`) passed it, `createClient` threw
 * "Invalid supabaseUrl", and the throw unmounted AccountMenu and SidePanel —
 * a blank planner with no error UI. Validate the shape and degrade to
 * local-only instead, which is the conservative failure (see CONTRIBUTING). */
function isUsableUrl(u: string | undefined): u is string {
  if (!u) return false;
  try {
    const { protocol } = new URL(u);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

if (url && !isUsableUrl(url)) {
  console.error(
    `[sync] VITE_SUPABASE_URL is not a valid URL (${url}). Account sync is OFF and the ` +
      `planner will run local-only. Fix or remove it in apps/web/.env.local — see .env.example.`,
  );
}

export const syncConfigured = isUsableUrl(url) && Boolean(anonKey);

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

/** Push the local plan (LWW: only overwrites an older remote). */
export async function pushPlan(plan: PlanDoc): Promise<"pushed" | "remote-newer" | "off"> {
  const sb = supabase();
  const user = await currentUser();
  if (!sb || !user) return "off";
  const { data: remote } = await sb
    .from("plans")
    .select("updated_at")
    .eq("user_id", user.id)
    .eq("id", plan.id)
    .maybeSingle();
  if (remote && new Date(remote.updated_at) > new Date(plan.updatedAt)) return "remote-newer";
  await sb.from("plans").upsert({
    id: plan.id,
    user_id: user.id,
    doc: plan,
    rev: plan.rev,
    updated_at: plan.updatedAt,
  });
  return "pushed";
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

let timer: ReturnType<typeof setTimeout> | undefined;
/** Debounced push — call on every local mutation. */
export function schedulePush(plan: PlanDoc): void {
  if (!syncConfigured) return;
  clearTimeout(timer);
  timer = setTimeout(() => { void pushPlan(plan); }, 2500);
}
