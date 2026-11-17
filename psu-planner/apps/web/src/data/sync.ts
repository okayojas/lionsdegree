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
import { STALE_REV_SQLSTATE, type PlanDoc } from "@psu-planner/engine";

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
export const STALE_REV_CODE = STALE_REV_SQLSTATE;

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

function agreementMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SYNCED_REV_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function syncedRev(planId: string): number | null {
  const all = agreementMap();
  return typeof all[planId] === "number" ? all[planId] : null;
}

/** The agreement this device had WHEN THE PAGE LOADED.
 *
 * A snapshot, and it has to be one. "A Plan the account has never seen"
 * is a fact about the student, not about this millisecond: loading a Plan
 * persists it, persisting it schedules a push 2.5 seconds later, and that
 * push records agreement. Ask the live map any later than that and a Plan
 * built while signed out looks like one the account always had — so the
 * question that should be put to the student silently stops being a
 * question, and they are left exactly where this ticket found them.
 *
 * Measured: the browser test for that question passed on every profile at
 * normal speed, and missed it on one profile under full-suite load, where
 * the planner takes longer than the debounce to render its toolbar.
 *
 * Nothing in this page can push before this module is imported, so this
 * is the earliest honest answer there is. */
const agreedAtLoad: Record<string, number> = agreementMap();

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
  const newest = await newestRemotePlan();
  if (!newest) return null;
  const { remote, remoteRev } = newest;
  return takesRemote(local, remote, remoteRev, force) ? remember(remote, remoteRev, local) : null;
}

/** The newest Plan this account holds, or null when there is none to read.
 *
 * Split out because sign-in needs the same row for a different question
 * (`findPlansAtSignIn`), and reading it twice would mean two answers from
 * two moments — the read-then-decide gap this file already paid for once. */
async function newestRemotePlan(): Promise<{ remote: PlanDoc; remoteRev: number } | null> {
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
  return { remote, remoteRev: (data.rev as number) ?? remote.rev };
}

/** Should this device take the copy the server is holding?
 *
 * AGREEMENT FIRST, CLOCKS ONLY AS A FALLBACK.
 *
 * When this device has no unsynced edits — its revision is exactly the
 * one it last agreed with the server on — a different revision over
 * there is unambiguously somebody else's change, and it must be taken
 * whatever the timestamps say. That case used to fail: since #36 the
 * other writer can be the student's assistant, whose `updated_at`
 * comes from a SERVER, so a browser clock a few minutes fast made the
 * local copy look newer than a change made after it. The student asks
 * their assistant to add a course, watches it confirmed, opens the
 * planner, and it is not there.
 *
 * ADR 0003 replaced clocks with `rev` for writes because two devices'
 * clocks disagree quietly. This is the same rule applied to reads. */
function takesRemote(local: PlanDoc | null, remote: PlanDoc, remoteRev: number, force: boolean): boolean {
  const agreed = syncedRev(remote.id);
  if (!force && local && agreed !== null) {
    // The server is exactly where we left it, so there is nothing over
    // there to take — whatever the clocks say. Falling through to the
    // timestamp comparison here was the other half of the same bug: a
    // SLOW local clock made the remote look newer and pulled, replacing
    // unsynced local edits with a copy the server already had. ADR
    // 0003: clock skew stops mattering.
    if (remoteRev === agreed) return false;
    // We have no unsynced edits and the server has moved: unambiguously
    // somebody else's change — their other device, or their assistant.
    if (local.rev === agreed) return true;
  }
  if (!force && local && new Date(local.updatedAt) >= new Date(remote.updatedAt)) {
    // Both sides moved. A pull here would replace unsynced local work
    // without saying so; the refused push is what raises that properly.
    return false;
  }
  return true;
}

/** Take the remote copy: back up what it replaces, and record that we
 * now agree with the server at this revision so the next push states it.
 *
 * Both return paths go through here. They used to be one path; when the
 * revision-based branch was added above, duplicating these three lines
 * would have been the easy way to forget the backup on one of them —
 * and the backup is the only reason a wrong pull is recoverable. */
function remember(remote: PlanDoc, rev: number, replacing: PlanDoc | null): PlanDoc {
  if (replacing) {
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify(replacing)); } catch { /* full */ }
  }
  rememberSyncedRev(remote.id, rev);
  return remote;
}

/** What signing in found.
 *
 * `kept` and `collision` are the two answers `pullNewerPlan` could not
 * give, and both exist because of the same student: somebody who built a
 * Plan on this device while signed out.
 *
 * `nothing`  — nothing to do. No Plan here, or the account is already
 *              holding the copy this device has.
 * `kept`     — the account had no Plan, so the one on this device is now
 *              in it. The offer that got them here said the Plan would
 *              follow them to their phone, and this is the moment that
 *              becomes true: waiting for the next edit to push would make
 *              the promise false for anyone who signs in and closes the tab.
 * `unsaved`  — the same case, and the write did not land. Said plainly
 *              rather than reported as success (iron rule 2).
 * `adopted`  — the account's Plan is now this device's. The local copy is
 *              backed up on the way through, as it always was.
 * `collision`— a Plan on this device the account has never seen, AND a
 *              different Plan already in the account. ASKED, NOT ANSWERED.
 *              `pullNewerPlan` resolved this by comparing clocks, and the
 *              Plan that lost became unreachable: it is still in Postgres,
 *              but that read is newest-first and would never surface it
 *              again. Indistinguishable, from the student's side, from
 *              having lost it. ADR 0003 took clocks out of writes for the
 *              same reason they are wrong here. */
export type SignInFinding =
  | { kind: "nothing" }
  /** The student started over: no Plan here, one in the account, and it
   *  is NOT taken. See `startOver`. */
  | { kind: "set-aside"; remote: PlanDoc; remoteRev: number }
  | { kind: "kept" }
  | { kind: "unsaved" }
  | { kind: "adopted"; plan: PlanDoc }
  | { kind: "collision"; local: PlanDoc; remote: PlanDoc; remoteRev: number };

/** The account's Plan, set aside because the student started over. */
export type PlanSetAside = Extract<SignInFinding, { kind: "set-aside" }>;

/* ── Starting over ───────────────────────────────────────────────────
   REPORTED BY THE OWNER: "Whenever I try to start over, it loads the
   newest plan backed up." Start over removes the Plan from this device
   and says nothing to the account, so the next look at the account
   found a Plan there and none here, which is exactly the case
   `findPlansAtSignIn` adopts. Signed in, starting over undid itself.

   The owner's choice of fix, over deleting the account's Plan: remember
   that the student started over. While that is so,
     - the account's Plan is NOT pulled back (`set-aside`), though it can
       be brought back in one step;
     - the new Plan is HELD BACK from the account, so that it cannot
       become the account's newest Plan before the student has been
       asked which of the two they keep (the collision, which already
       exists for a Plan built signed out);
     - answering that question, either way, ends it.
   Nothing is deleted on one click, here or in the account.

   On this device only, and it survives a reload: it is a fact about
   what this device was told to forget. */
const STARTED_OVER = "lionsdegree-started-over";

/** The student pressed Start over. Call before the Plan is cleared. */
export function startOver(): void {
  try { localStorage.setItem(STARTED_OVER, "1"); } catch { /* private mode: it behaves as it used to */ }
}

/** Whether a Start over is still unanswered. */
export function startedOver(): boolean {
  try { return localStorage.getItem(STARTED_OVER) === "1"; } catch { return false; }
}

function startOverSettled(): void {
  try { localStorage.removeItem(STARTED_OVER); } catch { /* nothing to settle */ }
}

/** Bring back the account's Plan after all: the way out for a student who
 * started over and thought better of it. */
export function bringBackTheAccountsPlan(found: PlanSetAside): PlanDoc {
  startOverSettled();
  return remember(found.remote, found.remoteRev, null);
}

/** The collision, as the two things the student is choosing between. */
export type PlanCollision = Extract<SignInFinding, { kind: "collision" }>;

/** What to do about the Plans in play, the moment a student signs in.
 *
 * One read of the account, one answer. Every sign-in goes through here —
 * from the offer on the chart, from the account menu, or from the landing
 * page's link — so the careful path is not only the one through the
 * prompt. */
export async function findPlansAtSignIn(local: PlanDoc | null): Promise<SignInFinding> {
  // THE SNAPSHOT, not the live map — see `agreedAtLoad`. This page's own
  // debounced push must not be able to answer the question before it is
  // asked.
  const neverSynced = !!local && agreedAtLoad[local.id] === undefined;

  const newest = await newestRemotePlan();

  if (!newest) {
    if (!local) return { kind: "nothing" };
    // Nothing in the account to ask about, so a Start over is over: the
    // Plan on this device is the only one there is.
    startOverSettled();
    return (await pushNowInsteadOfLater(local)) === "pushed" ? { kind: "kept" } : { kind: "unsaved" };
  }

  const { remote, remoteRev } = newest;
  // THE COLLISION, and the narrowest definition of it that is still the
  // whole problem: a Plan this device had never got onto the server
  // (`syncedRev` is the record of ever having agreed with it) and a
  // DIFFERENT Plan already in the account. Same id is not this question —
  // that is one Plan in two places, which is what `takesRemote` is for and
  // what two long-standing bugs were fixed inside.
  // A Start over still unanswered is the same question, and is asked
  // whatever this page has pushed: the new Plan was held back for it.
  if (local && remote.id !== local.id && (neverSynced || startedOver())) {
    return { kind: "collision", local, remote, remoteRev };
  }
  // STARTED OVER, AND NOTHING BUILT YET. The account's Plan is the one
  // the student just walked away from. Taking it here is the bug.
  if (!local && startedOver()) return { kind: "set-aside", remote, remoteRev };
  if (!takesRemote(local, remote, remoteRev, false)) return { kind: "nothing" };
  return { kind: "adopted", plan: remember(remote, remoteRev, local) };
}

/** Keep the account's Plan. The one on this device is backed up on the way
 * through, exactly as an ordinary pull does it. */
export function takeTheAccountsPlan(c: PlanCollision): PlanDoc {
  // Answered: if this was a Start over, it ends here. The Plan built
  // since is backed up by `remember`, and was never sent.
  startOverSettled();
  pending = null;
  clearTimeout(timer);
  return remember(c.remote, c.remoteRev, c.local);
}

/** Keep the Plan on this device, and leave the account's where it is.
 *
 * BOTH SURVIVE. The account's row is never written here — this device's
 * Plan has its own id, so the push below inserts beside it rather than
 * over it. What it does record is AGREEMENT with the account's Plan at
 * the revision just read, so that a student who restores it later (the
 * caller puts it in Plan history) writes a clean compare-and-swap instead
 * of an insert the database correctly refuses. */
export async function keepThisDevicesPlan(c: PlanCollision): Promise<"pushed" | "stale" | "off" | "failed"> {
  // Answered: if this was a Start over, the new Plan is no longer held back.
  startOverSettled();
  rememberSyncedRev(c.remote.id, c.remoteRev);
  return pushNowInsteadOfLater(c.local);
}

/** Push this Plan now, TAKING OVER the push that was already waiting.
 *
 * Both callers above are reached a moment after the app has loaded a Plan,
 * and loading a Plan persists it, and persisting it schedules a debounced
 * push. So pushing again from here is two writes of a Plan the server has
 * never seen — two INSERTs, and the second one collides. The database is
 * right to refuse it, and the student would be shown a conflict notice
 * about a Plan nobody else has touched. Crying wolf about data loss is its
 * own kind of harm; it is why `pending` exists at all.
 *
 * So the waiting push is cancelled and its Plan is the one sent, because
 * `pending` is this same Plan or a newer edit of it — never an older one. */
async function pushNowInsteadOfLater(plan: PlanDoc): Promise<"pushed" | "stale" | "off" | "failed"> {
  const owed = pending ?? plan;
  clearTimeout(timer);
  pending = null;
  return pushPlan(owed);
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
  // NOTHING TO SEND WHEN WE ALREADY AGREE AT THIS EXACT REVISION, and
  // this is not an optimisation — without it the conflict banner never
  // goes away.
  //
  // THE LOOP. A refused push raises the banner. The student presses
  // "Load the newer plan", which pulls the remote copy and records
  // agreement at its revision. Adopting it calls `persist`, which calls
  // this, which schedules a push of the plan that was just pulled — at
  // the revision we just agreed on, because adopting is not an edit and
  // does not advance it. Migration 0003's trigger refuses a revision
  // that does not advance, that refusal reads as "stale", and the banner
  // comes straight back. Press it again and the same thing happens.
  //
  // Reported from production as "the load the newer plan message keeps
  // coming up even if I load the newer plan", which is exactly the shape
  // of it: the button works, and then undoes itself.
  //
  // The guard is the honest statement rather than a special case for the
  // banner: a Plan whose revision is the one the server last confirmed
  // is a Plan the server already has. Any edit advances `rev`, so a real
  // change is never swallowed here.
  if (plan.rev === syncedRev(plan.id)) {
    pending = null;
    clearTimeout(timer);
    return;
  }
  // HELD BACK AFTER A START OVER, until the student has said which Plan
  // they keep. Sent, it would become the account's newest Plan, and the
  // one they started over from would be unreachable without having been
  // asked about. It stays owed: answering sends it (`keepThisDevicesPlan`).
  if (startedOver()) {
    pending = plan;
    clearTimeout(timer);
    return;
  }
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
  // Not while a Start over is unanswered: see `schedulePush`.
  if (startedOver()) return;
  clearTimeout(timer);
  await send(pending);
}
