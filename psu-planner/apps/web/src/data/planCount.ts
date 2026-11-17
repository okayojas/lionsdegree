/** Counting Plans, anonymously (#70).
 *
 * WHY. A Plan made without signing in lives only in that browser, so the
 * owner had no way to tell whether anyone was using the planner: the only
 * number was the rows in `plans`, and few students sign in.
 *
 * WHAT IS SENT: that a Plan was created, or that one which already existed
 * was opened for the first time since this shipped; and which Edition it is
 * for. That is the whole event. The day is written by the database.
 *
 * WHAT IS NOT: no Plan id, no Programs, no Courses, no account, no device
 * id, nothing that persists and could tell two events apart. Whether a Plan
 * has been counted is remembered in THIS browser, under the Plan's id, and
 * the id never leaves it. The privacy policy says exactly this, and
 * `plan-count.test.ts` holds the event to these two keys.
 *
 * WHERE: an insert-only table in the database the planner already uses for
 * sign-in, which is the one other host the Content Security Policy allows.
 * Nobody can read it through the public key; the owner reads it with SQL.
 *
 * WITH NO SIGN-IN ON THE REQUEST (#70 review). The first version sent it
 * through the planner's database client, which attaches the signed-in
 * student's session to everything it sends: the row held no identity and
 * the request did. It is a plain request now, carrying the project's public
 * key and nothing of the student's, and no cookies. Like any request it
 * reaches a host that sees an IP address and the time; the table holds
 * neither, and the privacy policy says both things.
 *
 * ONLY FROM THE SITE ITSELF. A test run, a local build, a preview deploy
 * and a self-hosted copy all carry the same code, and none of them is a
 * student. So nothing is sent unless the page is on the site's own host.
 *
 * NEVER IN THE WAY. Sent after the Plan is on screen, not awaited, and a
 * failure is silent: the Plan is marked counted only when the insert lands,
 * so the next open tries again.
 */
import { supabaseAnonKey, supabaseUrl, syncConfigured } from "./sync-config";

export type PlanEventKind = "created" | "existing";

/** One event, exactly as it is sent. Two keys, and a test that there are
 * no others. */
export interface PlanEvent {
  kind: PlanEventKind;
  edition: string | null;
}

/** The hosts the site is served from. Counting happens on these and
 * nowhere else. */
export const COUNTED_HOSTS: readonly string[] = ["lionsdegree.com", "www.lionsdegree.com"];

export const countsHere = (host: string): boolean => COUNTED_HOSTS.includes(host.toLowerCase());

export function planEvent(kind: PlanEventKind, edition: string | undefined): PlanEvent {
  // An Edition is "2026-2027". Anything else is not passed on: the field is
  // a label for a count, not somewhere for other text to travel.
  return { kind, edition: edition && /^\d{4}-\d{4}$/.test(edition) ? edition : null };
}

/** Which Plans this browser has already counted. Here only. */
const COUNTED_KEY = "lionsdegree-plans-counted";
/** A browser holds one Plan at a time, and a student who starts over a
 * few times. The lists are capped so they cannot grow without end. */
const MOST_IDS_KEPT = 20;

/** Plans setup built that have not been counted yet. Here only, and kept
 * until the count lands: a Plan built offline, behind a blocker, or before
 * the table exists is still a NEW Plan when the count finally goes, days
 * later, and not one that "already existed". */
const NEW_KEY = "lionsdegree-plans-new";

function idsIn(key: string): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function keepIds(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids.slice(-MOST_IDS_KEPT)));
  } catch {
    /* storage disabled or full: see `countedThisPage` */
  }
}

/** Counted since this page loaded. Beside the stored list, because that
 * list cannot always be written (storage disabled, or full): without this
 * a Plan would be counted again every time the planner reloaded it within
 * one page. */
const countedThisPage = new Set<string>();

export function isCounted(planId: string): boolean {
  return countedThisPage.has(planId) || idsIn(COUNTED_KEY).includes(planId);
}

function markCounted(planId: string): void {
  countedThisPage.add(planId);
  keepIds(COUNTED_KEY, [...idsIn(COUNTED_KEY).filter((id) => id !== planId), planId]);
  keepIds(NEW_KEY, idsIn(NEW_KEY).filter((id) => id !== planId));
}

/** Setup has just built this Plan: its count, whenever it lands, is of a
 * Plan `created`. */
const builtThisPage = new Set<string>();
export function noteNewPlan(planId: string): void {
  builtThisPage.add(planId);
  keepIds(NEW_KEY, [...idsIn(NEW_KEY).filter((id) => id !== planId), planId]);
}

const isNew = (planId: string): boolean => builtThisPage.has(planId) || idsIn(NEW_KEY).includes(planId);

/** Plans whose event is on its way, so that two callers in one moment send
 * one event. */
const inFlight = new Set<string>();

export interface CountDeps {
  host: string;
  /** Send the event. True when it landed. */
  insert: (event: PlanEvent) => Promise<boolean>;
}

const defaults = (): CountDeps => ({
  host: typeof location === "undefined" ? "" : location.hostname,
  insert: async (event) => {
    if (!syncConfigured || !supabaseUrl || !supabaseAnonKey) return false;
    // A PLAIN REQUEST, not the database client's: that one attaches the
    // signed-in student's session. The public key says which project;
    // nothing here says which student. No cookies either way.
    const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/plan_events`, {
      method: "POST",
      credentials: "omit",
      headers: { apikey: supabaseAnonKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(event),
    });
    return response.ok;
  },
});

export type CountOutcome = "counted" | "already" | "not-here" | "failed";

/** Count this Plan, once. Never throws, and nothing waits for it. */
export async function countPlan(
  plan: { id: string; edition?: string },
  deps: CountDeps = defaults(),
): Promise<CountOutcome> {
  if (!countsHere(deps.host)) return "not-here";
  if (isCounted(plan.id) || inFlight.has(plan.id)) return "already";
  inFlight.add(plan.id);
  try {
    const landed = await deps.insert(planEvent(isNew(plan.id) ? "created" : "existing", plan.edition));
    if (!landed) return "failed";
    markCounted(plan.id);
    return "counted";
  } catch {
    return "failed";
  } finally {
    inFlight.delete(plan.id);
  }
}
