/** The contract every Plan store must satisfy.
 *
 * Same shape as the catalog's: the assertions live in a function over a
 * factory, so the Supabase store inherits every one of them rather than
 * getting its own lookalike suite. A student's assistant must get the
 * same answer about their degree whether the Plan came off a disk or
 * out of a database.
 *
 * The contract is small on purpose — read a Plan, say what revision it
 * was — because everything else about a Plan is the engine's job, and
 * the whole point of this seam is that the tools above it cannot tell
 * which store they have.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FilePlanStore, SupabasePlanStore, type PlanStore } from "../src/planStore.js";

/** A Plan as the planner exports one. Minimal but real: the store
 * parses it, so a shape it cannot read is a failing test rather than a
 * confusing one. */
const EDITIONS = ["2025-2026", "2026-2027"];

const A_PLAN = {
  id: "plan-1",
  rev: 7,
  updatedAt: "2026-10-01T12:00:00.000Z",
  edition: "2026-2027",
  programs: ["engineering-engineering-science-bs"],
  terms: [{ label: "Fall 2026", items: [{ kind: "course", code: "MATH 140" }] }],
  completed: {},
  moves: {},
  slotFills: {},
  added: [],
};

export function describePlanStore(name: string, make: (plan: unknown | null) => PlanStore): void {
  describe(name, () => {
    it("reads the student's Plan", async () => {
      const held = await make(A_PLAN).read(EDITIONS);
      expect(held?.plan.id).toBe("plan-1");
      expect(held?.plan.programs).toEqual(["engineering-engineering-science-bs"]);
    });

    it("says which revision it read", async () => {
      // FRESHNESS IS REPORTED, NOT ASSUMED. A model that cannot say how
      // current its view is will imply it is live, and a student acting
      // on an hour-old plan does not know to doubt it.
      const held = await make(A_PLAN).read(EDITIONS);
      expect(held?.rev).toBe(7);
      expect(held?.updatedAt).toBe("2026-10-01T12:00:00.000Z");
    });

    it("returns null when the student has no Plan", async () => {
      // Not an error and not an empty Plan: either would be answered
      // with an audit of nothing, which reads as "you need nothing".
      expect(await make(null).read(EDITIONS)).toBeNull();
    });

    it("keeps the Edition the Plan was pinned to", async () => {
      // ADR 0001. A Plan is governed by the bulletin in force when the
      // student entered their major; a store that dropped this would
      // send the whole audit to the newest one.
      const held = await make({ ...A_PLAN, edition: "2025-2026" }).read(EDITIONS);
      expect(held?.plan.edition).toBe("2025-2026");
    });

    it("refuses a Plan it cannot read rather than inventing an empty one", async () => {
      // An unreadable Plan answered as an empty Plan is an audit saying
      // nothing is required (iron rule 2).
      await expect(make("not a plan at all").read(EDITIONS)).rejects.toThrow();
    });
  });
}

/** The local server's store: the file the student exported. */
describePlanStore("the file plan store", (plan) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-plan-"));
  const file = path.join(dir, "plan.json");
  if (plan === null) return new FilePlanStore(path.join(dir, "absent.json"));
  // The envelope the planner writes, so this exercises the real reader
  // rather than a shape invented for the test.
  fs.writeFileSync(
    file,
    typeof plan === "string" ? plan : JSON.stringify({ format: "lionsdegree.plan", formatVersion: 1, plan }),
  );
  return new FilePlanStore(file);
});

/** The hosted store, against a stub standing in for PostgREST. ONE
 * LINE, and it inherits every assertion above. */
describePlanStore("the supabase plan store", (plan) => {
  const rows =
    plan === null
      ? []
      : [{ doc: typeof plan === "string" ? plan : plan, rev: (plan as { rev?: number })?.rev ?? 1, updated_at: (plan as { updatedAt?: string })?.updatedAt ?? "" }];
  return new SupabasePlanStore({
    url: "https://project.supabase.co",
    anonKey: "anon",
    accessToken: "student-token",
    fetch: async () => Response.json(rows),
  });
});

describe("the supabase plan store, specifically", () => {
  /** Captures what was actually sent, which is where the security
   * property lives. */
  function spying(rows: unknown[], status = 200) {
    const seen: { url: string; headers: Record<string, string> } = { url: "", headers: {} };
    const store = new SupabasePlanStore({
      url: "https://project.supabase.co",
      anonKey: "anon-key",
      accessToken: "the-students-token",
      fetch: async (input, init) => {
        seen.url = String(input);
        seen.headers = Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
        );
        return status === 200 ? Response.json(rows) : new Response("no", { status });
      },
    });
    return { store, seen };
  }

  it("asks as the student, which is what makes row-level security the gate", async () => {
    // THE SECURITY PROPERTY. The query carries the STUDENT's token, not
    // a service key — so Postgres refuses a cross-user read regardless
    // of what this code does with the result. An application that
    // filtered correctly but queried as a privileged role would pass
    // every test here and leak on the first bug.
    const { store, seen } = spying([{ doc: A_PLAN, rev: 7, updated_at: A_PLAN.updatedAt }]);
    await store.read(EDITIONS);
    expect(seen.headers.authorization, "the query did not run as the student").toBe("Bearer the-students-token");
    expect(seen.headers.apikey).toBe("anon-key");
    // And it must NOT be carrying anything more privileged.
    expect(JSON.stringify(seen.headers)).not.toMatch(/service_role/i);
  });

  it("does not filter by user id itself", async () => {
    // Deliberate. Adding `user_id=eq.<sub>` would make the application
    // the thing standing between two students, and the policy merely a
    // backstop nobody tests. The token says who is asking; Postgres
    // decides what they may see.
    const { store, seen } = spying([{ doc: A_PLAN, rev: 7, updated_at: A_PLAN.updatedAt }]);
    await store.read(EDITIONS);
    expect(seen.url, "the application is filtering, so the policy is untested in practice").not.toMatch(/user_id/);
  });

  it("asks for the most recently updated Plan", async () => {
    const { store, seen } = spying([{ doc: A_PLAN, rev: 7, updated_at: A_PLAN.updatedAt }]);
    await store.read(EDITIONS);
    expect(seen.url).toMatch(/order=updated_at\.desc/);
    expect(seen.url).toMatch(/limit=1/);
  });

  it("treats an empty result as no Plan, not as an error", async () => {
    const { store } = spying([]);
    expect(await store.read(EDITIONS)).toBeNull();
  });

  it("refuses rather than guessing when the database will not answer", async () => {
    // A failed read must not look like "this student has no Plan" —
    // that answers an audit with "nothing is required" (iron rule 2).
    const { store } = spying([], 500);
    await expect(store.read(EDITIONS)).rejects.toThrow(/could not|unavailable/i);
  });

  it("refuses when the student's session is rejected", async () => {
    const { store } = spying([], 401);
    await expect(store.read(EDITIONS)).rejects.toThrow();
  });
});
