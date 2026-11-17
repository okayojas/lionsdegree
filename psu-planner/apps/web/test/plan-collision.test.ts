/** Two plans, one student, and the question that used to be answered by a
 * clock.
 *
 * THE FAILURE THIS GUARDS. A student has a plan on their account, lands on
 * a new device, builds a fresh one because that is what the page offers,
 * and then signs in. `pullNewerPlan` compared timestamps and kept the
 * newer: the older plan was never deleted — plans are keyed by plan id, so
 * the fresh one inserts as a new row — but that read is newest-first and
 * would never surface the old one again. From the student's side that is
 * indistinguishable from having lost it, at the exact moment they committed
 * to the product.
 *
 * So the choice is theirs, and both plans survive it. These tests drive the
 * real `sync` module against a stubbed Postgres that applies the same
 * compare-and-swap the database does, so "the account's row was not
 * overwritten" is observed rather than assumed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** localStorage is the mechanism under test twice over — the synced-revision
 * marker that decides what counts as a collision, and the backup that makes
 * a wrong choice recoverable — so it is stubbed, not mocked away. */
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

interface Row { id: string; user_id: string; doc: { id: string }; rev: number; updated_at: string }

/** What the account holds. One row per plan id, exactly as the real table
 * is keyed — which is the whole reason a second plan does not destroy the
 * first. */
let rows: Row[] = [];

/** Something that happens on this device while the account is being read.
 * Set by the one test about that race; null everywhere else. */
let duringRead: (() => void) | null = null;

/** PostgREST, near enough: newest-first reads, an insert that collides with
 * an existing id, and an update conditional on the revision the client last
 * agreed with (ADR 0003). A canned response could not show whether the
 * account's row survived, which is half of what this file is about. */
function table() {
  let op: "select" | "insert" | "update" = "select";
  let payload: Row | null = null;
  const filters: Record<string, unknown> = {};
  const run = () => {
    if (op === "insert") {
      if (rows.some((r) => r.id === payload!.id)) return { data: null, error: { code: "23505" } };
      rows.push({ ...payload! });
      return { data: null, error: null };
    }
    if (op === "update") {
      const i = rows.findIndex((r) => r.id === filters.id && r.rev === filters.rev);
      if (i < 0) return { data: [], error: null }; // the refusal: zero rows matched
      rows[i] = { ...payload! };
      return { data: [{ rev: rows[i].rev }], error: null };
    }
    return { data: null, error: null };
  };
  const chain = {
    select: () => chain,
    insert: (r: Row) => { op = "insert"; payload = r; return chain; },
    update: (r: Row) => { op = "update"; payload = r; return chain; },
    eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => {
      // Whatever else the device is doing while this round trip is in
      // flight. The debounced push from loading the plan is the real one.
      duringRead?.();
      const newest = [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
      return {
        data: newest ? { doc: newest.doc, rev: newest.rev, updated_at: newest.updated_at } : null,
        error: null,
      };
    },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
  };
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "student-1" } } }) },
    from: () => table(),
  }),
}));

const {
  bringBackTheAccountsPlan, findPlansAtSignIn, flushPush, keepThisDevicesPlan, rememberSyncedRev, schedulePush,
  startOver, startedOver, takeTheAccountsPlan,
} = await import("../src/data/sync");

/** A fresh page load, which is the unit the module works in: it snapshots
 * the agreement it starts from, precisely so this page's own pushes
 * cannot change the answer underneath the student. localStorage is the
 * stub above and survives, exactly as a browser's would. */
async function afterAReload(): Promise<typeof import("../src/data/sync")> {
  vi.resetModules();
  return import("../src/data/sync");
}
const { describePlan } = await import("../src/data/planSummary");

const plan = (id: string, updatedAt: string, programs: string[] = ["a-major"], rev = 1) =>
  ({ id, rev, updatedAt, programs, terms: [{ label: "Fall 2026", items: [] }], completed: {}, moves: {}, slotFills: {}, added: [] }) as never;

/** A plan already in the account, put there by another device. */
function accountHolds(id: string, updatedAt: string, rev = 4): void {
  rows.push({ id, user_id: "student-1", doc: plan(id, updatedAt, ["the-old-major"], rev), rev, updated_at: updatedAt });
}

const backup = () => JSON.parse(store.get("lionsdegree-conflict-backup") ?? "null") as { id?: string } | null;

beforeEach(() => {
  store.clear();
  rows = [];
  duringRead = null;
});

describe("a plan built on a new device, signed in afterwards", () => {
  it("is a question, not an answer, when this device's plan is the newer one", async () => {
    // THE CASE THE TICKET EXISTS FOR. The timestamp rule kept the fresh
    // plan and never showed the account's one again.
    accountHolds("in-the-account", "2026-11-01T09:00:00.000Z");
    const found = await findPlansAtSignIn(plan("built-here", "2026-11-01T12:00:00.000Z"));

    expect(found.kind, "the two plans were resolved silently instead of asked about").toBe("collision");
    if (found.kind !== "collision") return;
    expect(found.local.id).toBe("built-here");
    expect(found.remote.id).toBe("in-the-account");
  });

  it("is a question the other way round too, when the account's plan is newer", async () => {
    // The mirror image, and the one where the old rule quietly replaced
    // work the student could still see on their screen.
    accountHolds("in-the-account", "2026-11-01T18:00:00.000Z");
    const found = await findPlansAtSignIn(plan("built-here", "2026-11-01T12:00:00.000Z"));

    expect(found.kind, "the plan on screen was swapped out without a word").toBe("collision");
  });

  it("is still a question when this page's own push gets there first", async () => {
    // THE RACE, and it is not hypothetical: the browser suite raised this
    // question on every profile at normal speed and missed it on one under
    // full-suite load, which is how it was found.
    //
    // Loading a plan persists it, which schedules a push 2.5 seconds
    // later. That push records agreement for a plan the account had never
    // seen when the student signed in — so asking the live map any later
    // makes the collision silently stop being one, and the student is left
    // exactly where this ticket found them, with two plans in the account
    // and only the newest ever shown. Both orderings are covered: the push
    // landing before this is called, and landing while it waits on the
    // read.
    accountHolds("in-the-account", "2026-11-01T09:00:00.000Z");
    rememberSyncedRev("built-here", 1); // this page's debounced push, early
    duringRead = () => rememberSyncedRev("built-here", 2); // ...and again, mid-read

    const found = await findPlansAtSignIn(plan("built-here", "2026-11-01T12:00:00.000Z"));
    expect(found.kind, "the question was asked of a later moment than the page load").toBe("collision");
  });

  it("leaves both plans alone until the student has chosen", async () => {
    // The account's plan is the NEWER one here on purpose: that is the
    // arrangement in which the old rule acted on its own — adopting the
    // remote and standing the local copy down — so a test using the other
    // arrangement would pass whether or not anything had been fixed.
    accountHolds("in-the-account", "2026-11-01T18:00:00.000Z");
    await findPlansAtSignIn(plan("built-here", "2026-11-01T12:00:00.000Z"));

    expect(rows.map((r) => r.id), "asking the question wrote to the account").toEqual(["in-the-account"]);
    expect(backup(), "asking the question overwrote the backup").toBeNull();
  });
});

describe("whichever plan the student does not pick", () => {
  it("survives keeping the account's one: the device's plan is kept back", async () => {
    accountHolds("in-the-account", "2026-11-01T09:00:00.000Z");
    const found = await findPlansAtSignIn(plan("built-here", "2026-11-01T12:00:00.000Z"));
    if (found.kind !== "collision") throw new Error("no collision to resolve");

    const adopted = takeTheAccountsPlan(found);
    expect(adopted.id).toBe("in-the-account");
    expect(backup()?.id, "the plan this device built was not kept anywhere").toBe("built-here");
  });

  it("survives keeping the device's one: the account's row is not written over", async () => {
    // Plans are keyed by plan id, so this device's plan inserts BESIDE the
    // account's rather than over it. The assertion is on the stored row,
    // not on the absence of a request.
    accountHolds("in-the-account", "2026-11-01T09:00:00.000Z");
    const found = await findPlansAtSignIn(plan("built-here", "2026-11-01T12:00:00.000Z"));
    if (found.kind !== "collision") throw new Error("no collision to resolve");

    expect(await keepThisDevicesPlan(found)).toBe("pushed");
    const account = rows.find((r) => r.id === "in-the-account");
    expect(account, "the account's plan row is gone").toBeTruthy();
    expect(account!.doc.id, "the account's plan was overwritten by this device's").toBe("in-the-account");
    expect(rows.map((r) => r.id).sort(), "this device's plan did not reach the account").toEqual([
      "built-here",
      "in-the-account",
    ]);
  });

  it("is not asked about twice: the choice settles it", async () => {
    // Having kept this device's plan, coming back tomorrow must not
    // re-open the same question — the plan is in the account now, so it
    // is no longer a plan the account has never seen.
    accountHolds("in-the-account", "2026-11-01T09:00:00.000Z");
    const first = await findPlansAtSignIn(plan("built-here", "2026-11-01T12:00:00.000Z"));
    if (first.kind !== "collision") throw new Error("no collision to resolve");
    await keepThisDevicesPlan(first);

    const tomorrow = await afterAReload();
    const again = await tomorrow.findPlansAtSignIn(plan("built-here", "2026-11-01T12:00:00.000Z"));
    expect(again.kind, "the student is asked the same question every time they sign in").not.toBe("collision");
  });
});

describe("the ordinary cases stay silent", () => {
  it("asks nothing when the account has no plan, and saves the one on this device", async () => {
    // THE COMMON CASE BY FAR, and the promise the offer on the chart
    // makes: signing in is what keeps the plan. Waiting for the next edit
    // to push would leave the promise false for anyone who signs in and
    // closes the tab.
    const found = await findPlansAtSignIn(plan("built-here", "2026-11-01T12:00:00.000Z"));

    expect(found.kind, "signing in with an empty account raised a question or did nothing").toBe("kept");
    expect(rows.map((r) => r.id), "the plan never reached the account").toEqual(["built-here"]);
  });

  it("asks nothing when the account is holding this very plan", async () => {
    // A returning device. One plan in two places is not a collision; it
    // is what the revision rules above already answer.
    accountHolds("the-same-plan", "2026-11-01T09:00:00.000Z", 4);
    rememberSyncedRev("the-same-plan", 4);

    const found = await findPlansAtSignIn(plan("the-same-plan", "2026-11-01T12:00:00.000Z", ["a-major"], 4));
    expect(found.kind).not.toBe("collision");
  });

  it("asks nothing about a plan this device has already got onto the server", async () => {
    // Two plans, but no work at risk: this device's copy is already in the
    // account, so nothing becomes unreachable whichever one is shown. The
    // agreement was reached on an earlier visit, so the reload is what
    // makes this that visit rather than this one.
    accountHolds("another-device", "2026-11-01T18:00:00.000Z");
    rememberSyncedRev("built-here", 1);
    const today = await afterAReload();

    const found = await today.findPlansAtSignIn(plan("built-here", "2026-11-01T12:00:00.000Z"));
    expect(found.kind, "a question was raised over two plans that are both safe").not.toBe("collision");
  });

  it("asks nothing of a student signing in with no plan at all", async () => {
    accountHolds("in-the-account", "2026-11-01T09:00:00.000Z");
    const found = await findPlansAtSignIn(null);
    expect(found.kind).toBe("adopted");
  });
});

describe("what the student is choosing between", () => {
  const names: Record<string, string> = { "the-old-major": "Mathematics, B.S." };
  const nameFor = (slug: string) => names[slug];

  it("is named by its programs and when it was last touched, never by plan id", async () => {
    // A plan id is honest and useless: it is a random string, both plans
    // have one, and neither has ever been shown to the student.
    const summary = describePlan(plan("5f2c-9a11", "2026-11-01T12:00:00.000Z", ["the-old-major"]), nameFor);
    expect(summary.programs).toBe("Mathematics, B.S.");
    expect(summary.changed, "nothing says when this plan was last changed").not.toBe("");
    expect(JSON.stringify(summary), "the plan id is shown to the student").not.toMatch(/5f2c-9a11/);
  });

  it("falls back to the slug for a program the current catalog does not name", async () => {
    // The two plans can be pinned to different Editions, and a Program
    // dropped since must still be nameable as SOMETHING. A blank line is
    // not a choice a student can make.
    const summary = describePlan(plan("p", "2026-11-01T12:00:00.000Z", ["a-retired-minor"]), nameFor);
    expect(summary.programs).toBe("a-retired-minor");
  });

  it("says the date is not recorded rather than rendering a broken one", () => {
    // "Invalid Date" reads as a fault in the student's plan rather than a
    // gap in what we know about it (iron rule 2).
    const summary = describePlan(plan("p", "not-a-date"), nameFor);
    expect(summary.changed).toBe("date not recorded");
  });
});

describe("starting over, signed in", () => {
  /* REPORTED BY THE OWNER: "Whenever I try to start over, it loads the
     newest plan backed up." Start over removed the Plan from this device
     and told the account nothing, so the next look at the account found a
     Plan there and none here, and took it. The owner's choice of fix: the
     account's Plan is left alone and NOT pulled back; the new Plan is held
     back from the account until the student has been asked which of the
     two they keep. Nothing is deleted on one click. */
  const OLD = "in-the-account";
  const NEW = "built-after-starting-over";
  const newPlan = () => plan(NEW, "2026-11-16T12:00:00.000Z");

  it("does not bring the account's plan back while there is no plan here", async () => {
    accountHolds(OLD, "2026-11-01T09:00:00.000Z");
    startOver();
    const found = await findPlansAtSignIn(null);
    expect(found.kind, "the plan the student started over from was loaded straight back").toBe("set-aside");
    // Not adopted, so nothing was backed up as "replaced" either.
    expect(backup()).toBeNull();
    expect(rows.map((r) => r.id), "starting over wrote to the account").toEqual([OLD]);
  });

  it("still does not, after a reload: starting over is not forgotten by closing the tab", async () => {
    accountHolds(OLD, "2026-11-01T09:00:00.000Z");
    startOver();
    const later = await afterAReload();
    expect((await later.findPlansAtSignIn(null)).kind).toBe("set-aside");
  });

  it("can be undone in one step: the account's plan is still there to bring back", async () => {
    accountHolds(OLD, "2026-11-01T09:00:00.000Z");
    startOver();
    const found = await findPlansAtSignIn(null);
    if (found.kind !== "set-aside") throw new Error(`expected the plan to be set aside, got ${found.kind}`);
    const back = bringBackTheAccountsPlan(found);
    expect(back.id).toBe(OLD);
    expect(startedOver(), "bringing it back did not end the starting over").toBe(false);
    // And from here it is an ordinary plan this device agrees with the account about.
    expect((await findPlansAtSignIn(back)).kind).toBe("nothing");
  });

  it("holds the new plan back from the account until the student has been asked", async () => {
    vi.useFakeTimers();
    try {
      accountHolds(OLD, "2026-11-01T09:00:00.000Z");
      startOver();
      // Building the new Plan saves it, and saving schedules a push.
      schedulePush(newPlan());
      await vi.advanceTimersByTimeAsync(10_000);
      // Switching away flushes whatever is waiting.
      await flushPush();
      expect(rows.map((r) => r.id), "the new plan reached the account before the question was asked").toEqual([OLD]);
    } finally {
      vi.useRealTimers();
    }
    // ASKED. Both Plans, and the student chooses.
    const found = await findPlansAtSignIn(newPlan());
    expect(found.kind).toBe("collision");
  });

  it("is asked again after a reload, until it is answered", async () => {
    accountHolds(OLD, "2026-11-01T09:00:00.000Z");
    startOver();
    const later = await afterAReload();
    expect((await later.findPlansAtSignIn(newPlan())).kind).toBe("collision");
  });

  it("keeping the new plan sends it, leaves the old one in the account, and ends the holding back", async () => {
    accountHolds(OLD, "2026-11-01T09:00:00.000Z");
    startOver();
    const found = await findPlansAtSignIn(newPlan());
    if (found.kind !== "collision") throw new Error(`expected to be asked, got ${found.kind}`);
    expect(await keepThisDevicesPlan(found)).toBe("pushed");
    // BOTH SURVIVE. The old row is not written over; the new one is beside it.
    expect(rows.map((r) => r.id).sort()).toEqual([NEW, OLD].sort());
    expect(startedOver()).toBe(false);
    // The next edit goes to the account like any other.
    vi.useFakeTimers();
    try {
      schedulePush(plan(NEW, "2026-11-16T12:05:00.000Z", ["a-major"], 2));
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }
    expect(rows.find((r) => r.id === NEW)!.rev).toBe(2);
  });

  it("keeping the account's plan ends it too, and the new one is kept back on this device", async () => {
    accountHolds(OLD, "2026-11-01T09:00:00.000Z");
    startOver();
    const found = await findPlansAtSignIn(newPlan());
    if (found.kind !== "collision") throw new Error(`expected to be asked, got ${found.kind}`);
    expect(takeTheAccountsPlan(found).id).toBe(OLD);
    expect(startedOver()).toBe(false);
    expect(backup()?.id, "the new plan was not kept back").toBe(NEW);
    expect(rows.map((r) => r.id)).toEqual([OLD]);
  });

  it("asks nothing where the account holds no plan: the new one is saved", async () => {
    startOver();
    expect((await findPlansAtSignIn(newPlan())).kind).toBe("kept");
    expect(rows.map((r) => r.id)).toEqual([NEW]);
    expect(startedOver()).toBe(false);
  });

  it("changes nothing for a student who has not started over: no plan here means the account's is taken", async () => {
    accountHolds(OLD, "2026-11-01T09:00:00.000Z");
    expect((await findPlansAtSignIn(null)).kind).toBe("adopted");
  });
});
