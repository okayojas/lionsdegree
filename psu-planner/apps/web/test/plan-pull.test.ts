/** Picking up a change somebody else made.
 *
 * "Somebody else" used to mean the student's other laptop. Since #36 it
 * also means their assistant, writing through the connector while the
 * planner tab was closed — and that write carries a timestamp from a
 * SERVER, not from this browser.
 *
 * Which breaks the old gate. It compared `updated_at` strings, so a
 * device whose clock runs a few minutes fast considers its own copy
 * newer than a change made after it, and silently keeps the stale one.
 * The student asks their assistant to add a course, sees it confirmed,
 * opens the planner, and it is not there. ADR 0003 replaced clocks with
 * `rev` for writes for exactly this reason; this is the read half.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** The suite runs in node, and `syncedRev` is kept in localStorage —
 * which is the whole mechanism under test here, so it is stubbed rather
 * than mocked away. */
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
/** `Object.keys(localStorage)` does not see a stub's entries the way it
 * sees a real Storage, so the backup assertion asks the map. */
const stored = () => [...store.keys()];

vi.mock("../src/data/sync-config", () => ({
  syncConfigured: true,
  supabaseUrl: "https://project.supabase.co",
  supabaseAnonKey: "anon-key",
}));

/** What the database holds. */
let remote: { doc: unknown; rev: number; updated_at: string } | null = null;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "student-1" } } }) },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: remote, error: null }),
      };
      return chain;
    },
  }),
}));

const { pullNewerPlan, rememberSyncedRev } = await import("../src/data/sync");

const plan = (rev: number, updatedAt: string) =>
  ({ id: "p", rev, updatedAt, programs: [], terms: [], completed: {}, moves: {}, slotFills: {}, added: [] }) as never;

beforeEach(() => {
  localStorage.clear();
  remote = null;
});

describe("a change the assistant made while the planner was closed", () => {
  it("is picked up on next load", async () => {
    // The device last agreed with the server at rev 4 and has made no
    // edits since. The server is at 5 because the assistant wrote.
    rememberSyncedRev("p", 4);
    remote = { doc: plan(5, "2026-11-01T10:00:00.000Z"), rev: 5, updated_at: "2026-11-01T10:00:00.000Z" };

    const pulled = await pullNewerPlan(plan(4, "2026-11-01T09:00:00.000Z"));
    expect(pulled, "the assistant's change was not picked up").toBeTruthy();
    expect((pulled as { rev: number }).rev).toBe(5);
  });

  it("is picked up even when this device's clock runs fast", async () => {
    // THE ONE THAT MATTERS. The local copy is older in every sense that
    // counts — it is the revision the server already had — but this
    // browser's clock says otherwise. Trusting the clock here drops a
    // change the student watched their assistant make.
    rememberSyncedRev("p", 4);
    remote = { doc: plan(5, "2026-11-01T10:00:00.000Z"), rev: 5, updated_at: "2026-11-01T10:00:00.000Z" };

    const pulled = await pullNewerPlan(plan(4, "2026-11-01T23:59:00.000Z"));
    expect(pulled, "a fast clock discarded a change the assistant made").toBeTruthy();
    expect((pulled as { rev: number }).rev).toBe(5);
  });

  it("does not throw away unsynced local work to get it", async () => {
    // Both sides moved: the student edited here AND the assistant wrote
    // there. That is a conflict, not a pull — the local copy stands and
    // the refused push is what raises it, so nobody's work vanishes
    // without being mentioned.
    rememberSyncedRev("p", 4);
    remote = { doc: plan(5, "2026-11-01T10:00:00.000Z"), rev: 5, updated_at: "2026-11-01T10:00:00.000Z" };

    const pulled = await pullNewerPlan(plan(5, "2026-11-01T11:00:00.000Z"));
    expect(pulled, "unsynced local edits were replaced without a word").toBeNull();
  });

  it("keeps a backup of the local copy when it does pull", async () => {
    rememberSyncedRev("p", 4);
    remote = { doc: plan(5, "2026-11-01T10:00:00.000Z"), rev: 5, updated_at: "2026-11-01T10:00:00.000Z" };
    await pullNewerPlan(plan(4, "2026-11-01T09:00:00.000Z"));
    expect(
      stored().some((k) => k.toLowerCase().includes("backup")),
      "nothing was kept, so a wrong pull would be unrecoverable",
    ).toBe(true);
  });
});

describe("when nothing has changed", () => {
  it("pulls nothing", async () => {
    rememberSyncedRev("p", 5);
    remote = { doc: plan(5, "2026-11-01T10:00:00.000Z"), rev: 5, updated_at: "2026-11-01T10:00:00.000Z" };
    expect(await pullNewerPlan(plan(5, "2026-11-01T10:00:00.000Z"))).toBeNull();
  });

  it("pulls nothing over unsynced local work, even when this clock runs SLOW", async () => {
    // THE OTHER HALF OF THE CLOCK BUG, and the dangerous direction.
    // The server is exactly where we left it — rev 5, the revision this
    // device agreed with — so it has nothing to give. But the student
    // has edited since (rev 6, unpushed) and this machine's clock is
    // behind, so the remote timestamp looks newer. Pulling here
    // replaces work the student can still see on their screen with a
    // copy the server already had.
    rememberSyncedRev("p", 5);
    remote = { doc: plan(5, "2026-11-01T10:00:00.000Z"), rev: 5, updated_at: "2026-11-01T10:00:00.000Z" };
    const unsynced = plan(6, "2026-11-01T08:00:00.000Z");
    expect(
      await pullNewerPlan(unsynced),
      "a slow clock discarded edits the server never had",
    ).toBeNull();
  });

  it("still honours a forced pull, which is what the conflict banner asks for", async () => {
    // The student pressed "load the newer plan". They are choosing,
    // and the local copy is backed up on the way through.
    rememberSyncedRev("p", 5);
    remote = { doc: plan(7, "2026-11-01T10:00:00.000Z"), rev: 7, updated_at: "2026-11-01T10:00:00.000Z" };
    const pulled = await pullNewerPlan(plan(6, "2026-11-01T23:00:00.000Z"), true);
    expect(pulled, "the one button that exists for this did nothing").toBeTruthy();
    expect((pulled as { rev: number }).rev).toBe(7);
  });

  it("pulls nothing when there is no remote plan at all", async () => {
    remote = null;
    expect(await pullNewerPlan(plan(3, "2026-11-01T10:00:00.000Z"))).toBeNull();
  });
});
