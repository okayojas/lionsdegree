/** Getting the student's last edit to the server before they walk away
 * from the tab.
 *
 * THE CASE THIS EXISTS FOR, now that an assistant can read the stored
 * Plan (#35): a student drags a course, alt-tabs to their assistant and
 * asks "does that still work?". The push is debounced 2.5 seconds, which
 * is most of the gap between the edit and the question — so without a
 * flush the assistant answers confidently about the plan as it was
 * BEFORE the change the student is asking about.
 *
 * Driven through `schedulePush`/`flushPush` with a stub Supabase client:
 * the same seam the rest of the sync tests use, and the push either
 * reaches the database or it does not, which is the whole behaviour.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** Sync is config-gated and the tests have no project, so say it is on. */
vi.mock("../src/data/sync-config", () => ({
  syncConfigured: true,
  supabaseUrl: "https://project.supabase.co",
  supabaseAnonKey: "anon-key",
}));

/** What actually reached the database. */
const writes: { kind: "insert" | "update"; rev: number }[] = [];
let failNext = false;

vi.mock("@supabase/supabase-js", () => {
  const selected = () => (failNext
    ? { data: null, error: { code: "08006", message: "network" } }
    : { data: [{ rev: 1 }], error: null });
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: "student-1" } } }) },
      from: () => ({
        insert: async (row: { rev: number }) => {
          if (failNext) return { error: { code: "08006", message: "network" } };
          writes.push({ kind: "insert", rev: row.rev });
          return { error: null };
        },
        update: (row: { rev: number }) => {
          const chain = {
            eq: () => chain,
            select: async () => {
              if (!failNext) writes.push({ kind: "update", rev: row.rev });
              return selected();
            },
          };
          return chain;
        },
      }),
    }),
  };
});

const { schedulePush, flushPush } = await import("../src/data/sync");

const planAt = (rev: number) =>
  ({ id: "p", rev, updatedAt: `2026-10-3${rev}T00:00:00.000Z`, programs: [], terms: [] }) as never;

beforeEach(() => {
  writes.length = 0;
  failNext = false;
  vi.useFakeTimers();
});

describe("hiding the tab with an edit owed", () => {
  it("sends it immediately rather than waiting out the debounce", async () => {
    schedulePush(planAt(1));
    // No timer advanced: this is the student switching away mid-debounce.
    await flushPush();
    expect(writes, "the edit was still sitting in the debounce").toHaveLength(1);
  });

  it("sends it once, not twice", async () => {
    // The flush must cancel the timer it pre-empted. Two writes of the
    // same revision is the second one failing a compare-and-swap, which
    // the student is shown as a conflict over an edit nobody else made.
    schedulePush(planAt(1));
    await flushPush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes, "the debounced push fired after the flush had already sent it").toHaveLength(1);
  });
});

describe("hiding the tab with nothing owed", () => {
  it("sends nothing", async () => {
    // CRYING WOLF. `flushPush` used to push whatever it last held, so a
    // student who hid and showed the tab twice re-sent a revision the
    // server already had — correctly refused, and shown to them as
    // "someone else edited your plan". Nobody had.
    await flushPush();
    expect(writes).toHaveLength(0);
  });

  it("sends nothing on a second hide with no edit between", async () => {
    schedulePush(planAt(1));
    await flushPush();
    writes.length = 0;
    await flushPush();
    expect(writes, "an unchanged plan was pushed again").toHaveLength(0);
  });
});

describe("when the push does not get through", () => {
  it("keeps owing it, so the next flush retries", async () => {
    // A network blip must not silently drop the edit. The student is
    // still looking at a plan they believe is saved.
    failNext = true;
    schedulePush(planAt(1));
    await flushPush();
    expect(writes).toHaveLength(0);

    failNext = false;
    await flushPush();
    expect(writes, "the failed edit was dropped rather than retried").toHaveLength(1);
  });
});
