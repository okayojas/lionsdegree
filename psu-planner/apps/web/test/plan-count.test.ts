/** Counting Plans, anonymously (#70).
 *
 * The promise is in two halves and both are held here. What is sent says
 * nothing about a student or a Plan: two keys, and no others. And it is
 * sent once for a Plan, from the site itself, without ever being something
 * the planner waits on or fails over.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const local = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, String(v)),
    removeItem: (k: string) => void local.delete(k),
    clear: () => local.clear(),
    key: (i: number) => [...local.keys()][i] ?? null,
    get length() { return local.size; },
  },
  configurable: true,
});

// The project the default sender would write to. Every test but the one
// about that sender hands its own.
vi.mock("../src/data/sync-config", () => ({
  syncConfigured: true,
  supabaseUrl: "https://project.supabase.co/",
  supabaseAnonKey: "anon-key",
}));

async function fresh(): Promise<typeof import("../src/data/planCount")> {
  vi.resetModules();
  return import("../src/data/planCount");
}

const SITE = "lionsdegree.com";
const PLAN = { id: "plan-1731760000000", edition: "2026-2027" };

/** A sender that records what it was handed. */
function sender(landed = true) {
  const sent: unknown[] = [];
  return { sent, deps: (host = SITE) => ({ host, insert: async (event: unknown) => { sent.push(event); return landed; } }) };
}

beforeEach(() => local.clear());

describe("what is sent", () => {
  it("is two things and no others: which kind, and which Edition", async () => {
    const { countPlan } = await fresh();
    const { sent, deps } = sender();
    await countPlan(PLAN, deps());
    // THE PRIVACY POLICY, as a test. A third key is a third thing the
    // policy would have to name.
    expect(sent).toEqual([{ kind: "existing", edition: "2026-2027" }]);
    expect(Object.keys(sent[0] as object).sort()).toEqual(["edition", "kind"]);
  });

  it("never carries the Plan's id, or anything else of the Plan", async () => {
    const { countPlan } = await fresh();
    const { sent, deps } = sender();
    await countPlan({ ...PLAN, programs: ["a-major"], completed: { "MATH 140": true } } as never, deps());
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain(PLAN.id);
    expect(wire).not.toContain("a-major");
    expect(wire).not.toContain("MATH 140");
  });

  it("passes on an Edition only where it looks like one", async () => {
    const { planEvent } = await fresh();
    expect(planEvent("created", "2026-2027").edition).toBe("2026-2027");
    // The field is a label for a count, not somewhere for other text to travel.
    expect(planEvent("created", "plan-1731760000000").edition).toBeNull();
    expect(planEvent("created", undefined).edition).toBeNull();
  });

  it("says a Plan setup has just built is new, and any other is one that already existed", async () => {
    const { countPlan, noteNewPlan } = await fresh();
    const { sent, deps } = sender();
    noteNewPlan("built-now");
    await countPlan({ id: "built-now", edition: "2026-2027" }, deps());
    await countPlan({ id: "was-here-already", edition: "2025-2026" }, deps());
    expect(sent).toEqual([
      { kind: "created", edition: "2026-2027" },
      { kind: "existing", edition: "2025-2026" },
    ]);
  });
});

describe("how it is sent", () => {
  it("is a plain request with the project's public key and nothing of the student's", async () => {
    // THE REVIEW'S FIRST FINDING. Sent through the planner's database
    // client, the request carried a signed-in student's session: the row
    // held no identity and the request did.
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    const realLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true } as Response;
    }) as typeof fetch;
    Object.defineProperty(globalThis, "location", { value: { hostname: SITE }, configurable: true });
    try {
      const { countPlan } = await fresh();
      expect(await countPlan(PLAN)).toBe("counted");
    } finally {
      globalThis.fetch = realFetch;
      if (realLocation) Object.defineProperty(globalThis, "location", realLocation);
      else delete (globalThis as { location?: unknown }).location;
    }
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://project.supabase.co/rest/v1/plan_events");
    expect(init.method).toBe("POST");
    // No cookies, and no sign-in: the headers are these three and no others.
    expect(init.credentials).toBe("omit");
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(["Content-Type", "Prefer", "apikey"]);
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|bearer/i);
    expect(JSON.parse(init.body as string)).toEqual({ kind: "existing", edition: "2026-2027" });
  });

  it("does not go through the planner's database client, which signs requests as the student", () => {
    const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "planCount.ts"), "utf-8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/from "\.\/sync"/);
    expect(code).not.toMatch(/supabase\(\)/);
  });
});

describe("a new Plan stays new until it is counted", () => {
  it("is still `created` when the count lands after a reload, days later", async () => {
    // Built offline, behind a blocker, or before the table existed: the
    // first try fails. It used to come back as one that "already existed".
    const first = await fresh();
    first.noteNewPlan(PLAN.id);
    expect(await first.countPlan(PLAN, sender(false).deps())).toBe("failed");
    const later = await fresh();
    const { sent, deps } = sender();
    expect(await later.countPlan(PLAN, deps())).toBe("counted");
    expect(sent).toEqual([{ kind: "created", edition: "2026-2027" }]);
    // Counted, so no longer waiting.
    expect(JSON.parse(local.get("lionsdegree-plans-new") ?? "[]")).toEqual([]);
  });

  it("is not counted again within a page where the browser cannot remember it was", async () => {
    const { countPlan } = await fresh();
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem: () => null, setItem() { throw new Error("full"); } },
      configurable: true,
    });
    try {
      const { sent, deps } = sender();
      await countPlan(PLAN, deps());
      await countPlan(PLAN, deps());
      await countPlan(PLAN, deps());
      expect(sent).toHaveLength(1);
    } finally {
      Object.defineProperty(globalThis, "localStorage", real);
    }
  });
});

describe("once for a Plan", () => {
  it("is not sent again for a Plan already counted, after a reload either", async () => {
    const first = await fresh();
    const { sent, deps } = sender();
    expect(await first.countPlan(PLAN, deps())).toBe("counted");
    expect(await first.countPlan(PLAN, deps())).toBe("already");
    const later = await fresh();
    expect(await later.countPlan(PLAN, deps())).toBe("already");
    expect(sent).toHaveLength(1);
  });

  it("is sent once where two callers ask in the same moment", async () => {
    const { countPlan } = await fresh();
    const { sent, deps } = sender();
    await Promise.all([countPlan(PLAN, deps()), countPlan(PLAN, deps())]);
    expect(sent).toHaveLength(1);
  });

  it("counts a second Plan in the same browser as a Plan of its own", async () => {
    const { countPlan } = await fresh();
    const { sent, deps } = sender();
    await countPlan(PLAN, deps());
    await countPlan({ id: "plan-after-starting-over", edition: "2026-2027" }, deps());
    expect(sent).toHaveLength(2);
  });

  it("remembers which Plans it counted in this browser only, and does not let the list grow without end", async () => {
    const { countPlan, isCounted } = await fresh();
    const { deps } = sender();
    for (let n = 0; n < 30; n++) await countPlan({ id: `plan-${n}`, edition: "2026-2027" }, deps());
    const kept = JSON.parse(local.get("lionsdegree-plans-counted")!) as string[];
    expect(kept.length).toBeLessThanOrEqual(20);
    expect(isCounted("plan-29")).toBe(true);
  });
});

describe("only from the site itself", () => {
  it.each(["127.0.0.1", "localhost", "abc123.lionsdegree.pages.dev", "plan.example.edu", "evil-lionsdegree.com", ""])(
    "sends nothing from %s",
    async (host) => {
      const { countPlan } = await fresh();
      const { sent, deps } = sender();
      expect(await countPlan(PLAN, deps(host))).toBe("not-here");
      expect(sent).toEqual([]);
      // And does not pretend it counted: the site itself still will.
      expect(local.has("lionsdegree-plans-counted")).toBe(false);
    },
  );

  it.each(["lionsdegree.com", "www.lionsdegree.com", "LionsDegree.com"])("sends from %s", async (host) => {
    const { countPlan } = await fresh();
    const { sent, deps } = sender();
    expect(await countPlan(PLAN, deps(host))).toBe("counted");
    expect(sent).toHaveLength(1);
  });
});

describe("never in the way", () => {
  it("tries again next time where the event did not land", async () => {
    const { countPlan } = await fresh();
    const failing = sender(false);
    expect(await countPlan(PLAN, failing.deps())).toBe("failed");
    const working = sender();
    expect(await countPlan(PLAN, working.deps())).toBe("counted");
    expect(working.sent).toHaveLength(1);
  });

  it("does not throw where the sender does, or where storage is disabled", async () => {
    const { countPlan } = await fresh();
    const thrown = { host: SITE, insert: async () => { throw new Error("offline"); } };
    await expect(countPlan(PLAN, thrown)).resolves.toBe("failed");

    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem() { throw new Error("disabled"); }, setItem() { throw new Error("disabled"); } },
      configurable: true,
    });
    try {
      const { sent, deps } = sender();
      await expect(countPlan(PLAN, deps())).resolves.toBe("counted");
      expect(sent).toHaveLength(1);
    } finally {
      Object.defineProperty(globalThis, "localStorage", real);
    }
  });

  it("is called without being waited for, after the plan is on screen", () => {
    // Source-level: there is no DOM here. The planner must never hold a
    // Plan back for a count.
    const app = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "App.tsx"), "utf-8");
    expect(app).toMatch(/void countPlan\(/);
    // And not where the plan failed to load: the student is looking at an error.
    expect(app).toMatch(/if \(!planId \|\| loading \|\| loadError\) return;/);
    expect(app, "the count is awaited somewhere in the shell").not.toMatch(/await countPlan\(/);
  });
});

describe("the table it goes to", () => {
  const sql = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "supabase", "migrations", "0004_plan_events.sql"),
    "utf-8",
  );
  const statements = sql.replace(/--.*$/gm, "");

  it("has no column that says whose Plan it was, or which", () => {
    expect(statements).not.toMatch(/user_id|plan_id|device|ip\b|uuid|timestamptz|timestamp/i);
    // The day, and nothing finer.
    expect(statements).toMatch(/day date not null default current_date/);
  });

  it("can be added to through the API and never read, changed or deleted", () => {
    expect(statements).toMatch(/enable row level security/);
    expect(statements.match(/create policy/gi)).toHaveLength(1);
    expect(statements).toMatch(/for insert to anon, authenticated/);
    expect(statements).not.toMatch(/for (select|update|delete|all)\b/i);
    expect(statements).toMatch(/grant insert \(kind, edition\)/);
    // Said on the table itself, where whoever reads it will see it.
    expect(statements).toMatch(/comment on table public\.plan_events is/);
  });
});
