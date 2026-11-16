/** Adopting a plan must not push it straight back.
 *
 * REPORTED FROM PRODUCTION as "the load the newer plan message keeps
 * coming up even if I load the newer plan". The button worked and then
 * undid itself.
 *
 * THE LOOP. A refused push raises the conflict banner. Pressing "Load
 * the newer plan" pulls the remote copy and records agreement at its
 * revision. Adopting it persists it, and persisting schedules a push —
 * of the plan that was just pulled, at the revision just agreed on,
 * because adopting is not an edit and does not advance `rev`. Migration
 * 0003's trigger refuses a revision that does not advance, that refusal
 * is reported as "stale", and the banner comes straight back.
 *
 * So the student presses a button that fixes nothing, forever, and the
 * one piece of UI whose job is to say "your work did not save" is
 * permanently on screen crying wolf. That is worse than the conflict it
 * reports: an alarm that always rings is one a student learns to
 * dismiss, including the time it is real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  },
  configurable: true,
});

vi.mock("../src/data/sync-config", () => ({
  syncConfigured: true,
  supabaseUrl: "https://project.supabase.co",
  supabaseAnonKey: "anon-key",
}));

/** Every write the push path attempts. */
const attempted: { rev: number }[] = [];

/** THE PUSH PATH HAS TO ACTUALLY RUN, or every assertion here passes for
 * the wrong reason.
 *
 * The first version of this file stubbed `fetch` and left
 * `@supabase/supabase-js` real. Without a session `currentUser()`
 * returned null, `pushPlan` bailed with "off" before touching the
 * network, and nothing was ever pushed — so the two "must not push"
 * tests were green against a client that COULD not push. They only
 * looked honest because the two "must still push" tests beside them
 * went red and said so, which is the entire reason both halves are
 * here. */
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "student-1" } } }) },
    from: () => {
      let sent = -1;
      const chain = {
        insert: async (row: { rev: number }) => {
          attempted.push({ rev: row.rev });
          return { error: null };
        },
        update: (row: { rev: number }) => {
          sent = row.rev;
          return chain;
        },
        eq: () => chain,
        select: async () => {
          attempted.push({ rev: sent });
          return { data: [{ rev: sent }], error: null };
        },
      };
      return chain;
    },
  }),
}));

const { schedulePush, flushPush, rememberSyncedRev } = await import("../src/data/sync");

const plan = (rev: number) =>
  ({ id: "the-plan", rev, updatedAt: "2026-01-01T00:00:00.000Z", terms: [], programs: [] }) as never;

beforeEach(() => {
  store.clear();
  attempted.length = 0;
  vi.useFakeTimers();
});

describe("a plan that was just pulled", () => {
  it("is NOT pushed back at the revision it was pulled at", async () => {
    // THE BUG. Agreement recorded at 7 by the pull; adopting then
    // persists the same document, still at 7.
    rememberSyncedRev("the-plan", 7);
    schedulePush(plan(7));

    await vi.advanceTimersByTimeAsync(5000);
    await flushPush();

    expect(
      attempted,
      "the plan was pushed back at the revision it was pulled at — the database refuses that, and the refusal re-raises the conflict banner",
    ).toEqual([]);
  });

  it("does not leave the push pending, so a later flush cannot send it either", async () => {
    // `flushPush` sends whatever is `pending`, and the tab flushes on
    // hide. Returning early without clearing it would move the same
    // doomed write to the moment the student switches away.
    rememberSyncedRev("the-plan", 7);
    schedulePush(plan(7));
    await flushPush();
    expect(attempted, "a doomed push was left waiting for the next flush").toEqual([]);
  });
});

describe("a plan the student actually changed", () => {
  it("is still pushed", async () => {
    // THE OTHER HALF, and what makes the guard safe: every edit advances
    // `rev`, so a real change never matches the agreed revision. Without
    // this the fix above could be "never push anything" and still pass.
    rememberSyncedRev("the-plan", 7);
    schedulePush(plan(8));

    await vi.advanceTimersByTimeAsync(5000);
    await flushPush();

    expect(attempted.map((a) => a.rev), "an edit was silently never saved").toContain(8);
  });

  it("is pushed when this device has never synced at all", async () => {
    // No agreement recorded: the first push of a plan the account has
    // never seen must still go.
    schedulePush(plan(1));
    await vi.advanceTimersByTimeAsync(5000);
    await flushPush();
    expect(attempted.length, "the first push of a never-synced plan was swallowed").toBeGreaterThan(0);
  });
});
