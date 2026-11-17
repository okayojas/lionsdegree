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
 * ONLY FROM THE SITE ITSELF. A test run, a local build, a preview deploy
 * and a self-hosted copy all carry the same code, and none of them is a
 * student. So nothing is sent unless the page is on the site's own host.
 *
 * NEVER IN THE WAY. Sent after the Plan is on screen, not awaited, and a
 * failure is silent: the Plan is marked counted only when the insert lands,
 * so the next open tries again.
 */
import { supabase } from "./sync";

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
 * few times. The list is capped so it cannot grow without end. */
const REMEMBERED = 20;

function countedIds(): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(COUNTED_KEY) ?? "[]") as unknown;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function isCounted(planId: string): boolean {
  return countedIds().includes(planId);
}

function markCounted(planId: string): void {
  try {
    const ids = countedIds().filter((id) => id !== planId);
    localStorage.setItem(COUNTED_KEY, JSON.stringify([...ids, planId].slice(-REMEMBERED)));
  } catch {
    /* storage disabled: it will be counted again next time, which is the
       cost of not being able to remember anything */
  }
}

/** Plans built by setup in this sitting, so that the first sight of one is
 * counted as `created` and not as `existing`. In memory only. */
const justBuilt = new Set<string>();
export function noteNewPlan(planId: string): void {
  justBuilt.add(planId);
}

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
    const sb = supabase();
    if (!sb) return false;
    const { error } = await sb.from("plan_events").insert(event);
    return !error;
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
    const landed = await deps.insert(planEvent(justBuilt.has(plan.id) ? "created" : "existing", plan.edition));
    if (!landed) return "failed";
    markCounted(plan.id);
    return "counted";
  } catch {
    return "failed";
  } finally {
    inFlight.delete(plan.id);
  }
}
