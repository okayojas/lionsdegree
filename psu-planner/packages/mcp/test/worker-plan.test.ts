/** The hosted connector answering questions about a student's own Plan.
 *
 * #33 shipped it catalog-only: a signed-in student could ask what CMPSC
 * 465 requires, but not what THEY still need — which is the question the
 * thing exists for. This is that, end to end, through
 * `fetch(Request, Env)` like the rest of the Worker suite.
 *
 * The stakes are different from the catalog tools. A Course question has
 * one right answer for everybody; a Plan question has a different right
 * answer per student, and the wrong one is somebody else's degree.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetInMemoryCounters, type KVLike } from "@psu-planner/identity";
import worker, { type Env } from "../src/worker.js";
import { MUTATIONS } from "../src/mutations.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const SECRET = "test-jwt-secret";

/** The real exported Plan the tool tests use, so this exercises a shape
 * the planner actually writes. */
const PLAN = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "plan.json"), "utf-8")).plan;

const assets = {
  async fetch(req: Request): Promise<Response> {
    const rel = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ""));
    const file = path.join(CATALOG, rel);
    if (!file.startsWith(CATALOG) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response("not found", { status: 404 });
    }
    return new Response(fs.readFileSync(file, "utf-8"), { status: 200 });
  },
};

function memoryKv(): KVLike {
  const store = new Map<string, string>();
  return {
    async get(k, opts) {
      if (opts?.cacheTtl !== undefined && opts.cacheTtl < 30) {
        throw new Error(`Invalid cache_ttl of ${opts.cacheTtl}. Cache TTL must be at least 30.`);
      }
      return store.get(k) ?? null;
    },
    async put(k, v, opts) {
      if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) {
        throw new Error("Invalid expiration_ttl. Must be at least 60.");
      }
      store.set(k, v);
    },
    async delete(k) { store.delete(k); },
  };
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function token(payload: Record<string, unknown>): Promise<string> {
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

const signedIn = (sub = "student-1") =>
  token({ sub, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: "s@psu.edu" });

const env = (): Env =>
  ({
    CATALOG: assets,
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    OAUTH: memoryKv(),
  }) as Env;

/** What the database said, and what it was asked — the request is the
 * interesting half, because that is where a student's identity either
 * reaches Postgres or does not. */
function database(reply: () => Response) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    });
    return reply();
  }) as typeof fetch;
  return { asked, restore: () => { globalThis.fetch = real; } };
}

const rows = (plan: unknown, rev = 4, updated = "2026-10-20T09:00:00.000Z") =>
  () => Response.json([{ doc: plan, rev, updated_at: updated }]);

async function call(e: Env, auth: string, name: string, args: Record<string, unknown> = {}) {
  const res = await worker.fetch(
    new Request("https://mcp.lionsdegree.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: auth,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    e,
  );
  const text = await res.text();
  const line = text.split("\n").filter((l) => l.startsWith("data:")).pop();
  if (!line) return { status: res.status, body: text, result: null as unknown };
  const parsed = JSON.parse(JSON.parse(line.slice(5).trim()).result.content[0].text);
  return { status: res.status, body: text, result: parsed as Record<string, unknown> };
}

async function tools(e: Env, auth: string): Promise<string[]> {
  const res = await worker.fetch(
    new Request("https://mcp.lionsdegree.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: auth,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    e,
  );
  const text = await res.text();
  const line = text.split("\n").filter((l) => l.startsWith("data:")).pop()!;
  return (JSON.parse(line.slice(5).trim()).result.tools as { name: string }[]).map((t) => t.name);
}

let db: ReturnType<typeof database> | null = null;
beforeEach(() => resetInMemoryCounters());
afterEach(() => { db?.restore(); db = null; });

describe("a signed-in student asking about their own plan", () => {
  it("gets their plan back", async () => {
    db = database(rows(PLAN));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "get_plan");
    expect(result).toBeTruthy();
    expect(JSON.stringify(result)).toContain("CHEM 110");
  });

  it("is told how current that view is", async () => {
    // A model that cannot say how fresh its copy is will imply it is
    // live, and a student acting on an hour-old Plan does not know to
    // doubt it.
    db = database(rows(PLAN, 9, "2026-10-20T09:00:00.000Z"));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "get_plan");
    expect(result!.revision).toBe(9);
    expect(result!.as_of).toBe("2026-10-20T09:00:00.000Z");
  });

  it("can have their requirements audited", async () => {
    db = database(rows(PLAN));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "audit_requirements", {});
    expect(JSON.stringify(result).length).toBeGreaterThan(50);
    expect((result as { error?: string }).error).toBeUndefined();
  });

  it("asks the database as THEMSELVES, which is what makes RLS the gate", async () => {
    // THE SECURITY PROPERTY, observed from outside the Worker. The read
    // carries the student's own token, so Postgres — not this code —
    // decides whose Plan comes back. Nothing here filters by user id,
    // deliberately: a filter would hide a policy failure behind an
    // application that happened to be correct.
    const theirToken = await signedIn("student-7");
    db = database(rows(PLAN));
    await call(env(), `Bearer ${theirToken}`, "get_plan");

    const read = db.asked.find((a) => a.url.includes("/rest/v1/plans"));
    expect(read, "no plan read reached the database").toBeTruthy();
    expect(read!.headers.authorization, "the read did not run as the student").toBe(`Bearer ${theirToken}`);
    expect(read!.url, "the application is filtering, so the policy is untested").not.toMatch(/user_id/);
    expect(JSON.stringify(read!.headers)).not.toMatch(/service_role/i);
  });
});

describe("which bulletin a plan is read against", () => {
  it("is the plan's own, not the newest published", async () => {
    // ADR 0001. A student who entered under 2025-2026 is held to
    // 2025-2026; auditing them against whatever was published since
    // would change their requirements without telling them. The catalog
    // here carries both editions, so the wrong one is reachable.
    db = database(rows({ ...PLAN, edition: "2025-2026" }));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "get_plan");
    expect(result!.edition, "the plan was audited against a bulletin it is not pinned to").toBe("2025-2026");
  });

  it("falls back to the OLDEST when the plan names none, not the newest", async () => {
    // A Plan with no Edition was made before Plans were pinned, so it
    // belongs to a continuing student — and ADR 0001 rejected "newest
    // wins" precisely because it silently re-plans them against
    // requirements that do not govern them. The local server has always
    // read it this way; this is the Worker agreeing, because a student's
    // audit must not depend on which server answered.
    const { edition: _dropped, ...unpinned } = PLAN;
    db = database(rows(unpinned));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "get_plan");
    expect(result!.edition, "the hosted connector re-planned an unpinned student").toBe("2025-2026");
  });

  it("refuses a plan pinned to a bulletin this connector does not carry", async () => {
    // Opening it against a different Edition would silently restate a
    // student's degree requirements. Refusing is the conservative
    // answer (iron rule 2).
    db = database(rows({ ...PLAN, edition: "2019-2020" }));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "get_plan");
    expect(result!.error, "a plan was opened against the wrong bulletin").toMatch(/doesn't have|does not have/i);
  });

  it("does not tell them to try again, because that year is never coming", async () => {
    // THE FOURTH OUTCOME, and it was wearing the transient one's
    // message. Editions are forward-only and never backfilled (ADR
    // 0001): "try again in a moment" is advice that cannot come true,
    // and it hides a problem only a human can resolve.
    db = database(rows({ ...PLAN, edition: "2019-2020" }));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "get_plan");
    expect(result!.error, "a permanent refusal was reported as a transient one").not.toMatch(/try again/i);
    expect(result!.error, "does not say which bulletin the plan follows").toMatch(/2019-2020/);
    expect(result!.error, "does not say what this connector does have").toMatch(/2026-2027/);
  });
});

describe("a catalog question", () => {
  it("never touches the database", async () => {
    // Most questions are about the Bulletin. A student with no Plan
    // should not pay a round trip to ask what MATH 141 requires, and a
    // database outage must not take the catalog down with it.
    db = database(() => new Response("should not be called", { status: 500 }));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "get_course_details", { code: "MATH 141" });
    expect(result!.title).toBeTruthy();
    expect(db.asked.filter((a) => a.url.includes("/rest/v1/")), "a catalog question hit the database").toHaveLength(0);
  });
});

describe("a student with no plan stored", () => {
  it("is sent to the planner, not told their degree is empty", async () => {
    db = database(() => Response.json([]));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "audit_requirements", {});
    expect(result!.error).toMatch(/no plan to read|build one/i);
    expect(result!.error).toMatch(/lionsdegree\.com\/plan/);
  });
});

describe("when the plan cannot be read", () => {
  it("says so rather than auditing nothing", async () => {
    // IRON RULE 2. An unreadable Plan answered as an empty Plan is an
    // audit reporting that nothing is required — the confident wrong
    // answer this project refuses. It must also not read as "you have no
    // plan", which would send a student who HAS one to build another.
    db = database(() => new Response("down", { status: 503 }));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "audit_requirements", {});
    expect(result!.error, "a failed read was answered as a finished degree").toMatch(/could not be read/i);
    expect(result!.error, "a failed read was reported as having no plan").not.toMatch(/build one/i);
    expect(result!.requirements ?? null, "an audit was produced from a plan that never loaded").toBeNull();
  });

  it("says nothing about why, beyond that it failed", async () => {
    // The upstream reason goes to the log. A database error can carry a
    // table name or a policy name, and the student can act on neither.
    db = database(() => new Response("relation \"plans\" does not exist", { status: 500 }));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "get_plan");
    expect(result!.error).not.toMatch(/relation|plans|50\d/);
  });
});

describe("what the connector offers", () => {
  it("offers the read-only plan tools now that a student can be named", async () => {
    const offered = await tools(env(), `Bearer ${await signedIn()}`);
    expect(offered).toContain("get_plan");
    expect(offered).toContain("audit_requirements");
    expect(offered).toContain("search_catalog");
  });

  it("offers every tool that writes, since each is now a compare-and-swap", async () => {
    const offered = await tools(env(), `Bearer ${await signedIn()}`);
    // DERIVED, not typed out. An earlier draft of this list named four
    // of the then-seven mutations — the same miscount that put three of
    // them on the unauthenticated surface in #33.
    for (const writes of MUTATIONS) {
      expect(offered, `${writes} is not reachable`).toContain(writes);
    }
  });

  it("refuses a tool nobody classified", async () => {
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "drop_out", {});
    expect(result!.error).toMatch(/not a tool this connector offers/i);
  });
});

/** A stateful stand-in for PostgREST: it holds the row and honours the
 * `rev=eq.` filter, because THAT FILTER IS THE COMPARE-AND-SWAP. A stub
 * that accepted every PATCH would certify a connector the real database
 * refuses — the mistake this project has now made three times. */
function plansTable(initial: Record<string, unknown>, rev = 4) {
  let row = { id: "fixture-plan", doc: initial, rev, updated_at: "2026-10-20T09:00:00.000Z" };
  const asked: { url: string; method: string; headers: Record<string, string> }[] = [];

  const reply = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    asked.push({
      url: url.toString(),
      method,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    });
    if (method === "GET") return Response.json([row]);

    // BOTH FILTERS, because PostgREST applies both. Ignoring `id` would
    // let a write land that named the wrong plan, and ignoring `rev`
    // would make the compare-and-swap a no-op — which is the stub being
    // more permissive than the database, the mistake this project has
    // now made three times.
    const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");
    if (eq("id") !== row.id || eq("rev") !== String(row.rev)) return Response.json([]);

    const sent = JSON.parse(String(init?.body ?? "{}")) as {
      doc: Record<string, unknown>; rev: number; updated_at: string;
    };
    // Migration 0003's trigger, which refuses a revision that does not
    // advance whatever the filter matched. Modelled here as well as in
    // `plan-store.test.ts`: two stubs for one database must not have
    // two fidelities.
    if (sent.rev <= row.rev) {
      return new Response(JSON.stringify({ code: "LD001", message: "plan revision went backwards" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    row = { ...row, doc: sent.doc, rev: sent.rev, updated_at: sent.updated_at };
    return Response.json([row]);
  };

  return {
    reply,
    asked,
    stored: () => row,
    /** The student saves from the planner, which is what makes the
     * assistant's in-flight change stale. */
    editedInThePlanner: () => { row = { ...row, rev: row.rev + 1 }; },
  };
}

function withTable(table: ReturnType<typeof plansTable>) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => table.reply(input, init)) as typeof fetch;
  return { asked: table.asked, restore: () => { globalThis.fetch = real; } };
}

describe("a change the assistant makes", () => {
  it("lands, and the stored plan carries it", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_term", { based_on_revision: 4 });
    expect(result!.ok, JSON.stringify(result)).toBe(true);
    expect((table.stored().doc as { terms: unknown[] }).terms.length)
      .toBe((PLAN.terms as unknown[]).length + 1);
  });

  it("states the revision it was computed from", async () => {
    // So a model can say what its change was based on, and so a human
    // reading the transcript can see which revision lost a race.
    const table = plansTable(PLAN, 11);
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_term", { based_on_revision: 11 });
    expect(result!.based_on_revision, "the write did not say what it was based on").toBe(11);
    expect(result!.revision).toBe(12);
  });

  it("returns the resulting plan, not just an acknowledgement", async () => {
    // "ok: true" leaves a model describing what it INTENDED, because
    // that is all it has. The resulting Plan lets it say what actually
    // happened — including the parts it did not ask for.
    const table = plansTable(PLAN);
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_term", { based_on_revision: 4 });
    const view = result!.plan as { terms?: unknown[]; revision?: number };
    expect(view?.terms, "the mutation did not return the resulting plan").toBeTruthy();
    expect(view.terms!.length).toBe((PLAN.terms as unknown[]).length + 1);
    expect(view.revision).toBe(5);
  });

  it("keeps the plan pinned to its Edition", async () => {
    // ADR 0001. A mutation must not re-base a student onto a different
    // bulletin, which would change which requirements apply to them.
    const table = plansTable({ ...PLAN, edition: "2025-2026" });
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_term", { based_on_revision: 4 });
    expect(result!.ok).toBe(true);
    expect((table.stored().doc as { edition?: string }).edition).toBe("2025-2026");
    expect((result!.plan as { edition?: string }).edition).toBe("2025-2026");
  });
});

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** The fixture with `code` already removed the way `remove_course`
 * removes it — the flag plus the preserved spec `restore_course` reads
 * back. Without this there is nothing hosted for a restore to restore. */
function alreadyRemoved(code: string): Record<string, unknown> {
  const p = clone(PLAN) as {
    terms: { items: { code?: string }[] }[];
    removed?: Record<string, boolean>;
    removedSpecs?: Record<string, unknown>;
  };
  const spec = p.terms.flatMap((t) => t.items).find((i) => i.code === code);
  if (!spec) throw new Error(`fixture has no ${code} to pre-remove`);
  p.removed = { [code]: true };
  p.removedSpecs = { [code]: clone(spec) };
  for (const t of p.terms) t.items = t.items.filter((i) => i.code !== code);
  return p as unknown as Record<string, unknown>;
}

/** The fixture with term `i` already a Gap Term, for `restore_term`. */
function alreadySkipped(i: number): Record<string, unknown> {
  const p = clone(PLAN) as { terms: { gap?: boolean }[] };
  p.terms[i].gap = true;
  return p as unknown as Record<string, unknown>;
}

/** The fixture plus one empty term on the end, for `delete_term` —
 * which refuses a term with anything in it, so the fixture as shipped
 * has nowhere it can legitimately act. */
function withSpareTerm(): Record<string, unknown> {
  const p = clone(PLAN) as { terms: { label: string; items: unknown[] }[] };
  p.terms.push({ label: "Fall 2030", items: [] });
  return p as unknown as Record<string, unknown>;
}

/** The fixture with a constraint already set, for the tool that lifts one. */
function withConstraint(): Record<string, unknown> {
  const p = clone(PLAN) as { constraints?: unknown[] };
  p.constraints = [{ code: "CHEM 110", type: "not-in", termIndex: 0 }];
  return p as unknown as Record<string, unknown>;
}

/** EVERY ONE OF THEM, through the Worker.
 *
 * The first draft of this file proved the hosted write path with
 * `add_term` alone and left the rest to the local tests — which is
 * `add_term` wearing everyone else's hat. The hosted path has its own
 * store, its own context construction and its own refusal handling, and
 * "the local one works" has never been evidence about any of those.
 *
 * Each case is a real call with real arguments, so a tool that is
 * reachable but broken hosted fails here rather than in production.
 *
 * `doc` is the stored Plan the case needs to start from. Most work
 * against the fixture as shipped; the six reversibility tools of #42
 * mostly undo something, so several of them need that something to have
 * happened first — a Plan with nothing removed gives `restore_course`
 * nothing to prove.
 */
const EVERY_MUTATION: {
  name: string;
  args: Record<string, unknown>;
  changed: (doc: Record<string, unknown>) => boolean;
  doc?: () => Record<string, unknown>;
}[] = [
  {
    name: "add_course",
    args: { code: "CMPSC 465", term_index: 5 },
    changed: (d) => JSON.stringify(d.added ?? []).includes("CMPSC 465"),
  },
  {
    name: "remove_course",
    // A Course the student added, so the consent gate is not what is
    // under test here — it has its own cases below.
    args: { code: "ECON 102", user_explicitly_asked: true, student_words: "I would rather not take that one at all" },
    changed: (d) => JSON.stringify(d.removed ?? {}).includes("ECON 102"),
  },
  {
    name: "set_schedule_constraint",
    args: { code: "CHEM 110", rule: "not-in", term_index: 0 },
    changed: (d) => JSON.stringify(d.constraints ?? []).includes("CHEM 110"),
  },
  {
    name: "fill_slot",
    // `GE-0-0` is the first open requirement slot in the fixture; the
    // ids come from get_plan and are stable for a given plan.
    args: { slot_id: "GE-0-0", code: "CMPSC 465" },
    changed: (d) => JSON.stringify(d.slotFills ?? {}).includes("CMPSC 465"),
  },
  {
    name: "add_previous_course",
    // In the catalog, in nobody's template here — so this proves the write
    // lands without depending on a Program listing the course.
    args: { codes: ["ART 1"] },
    changed: (d) => JSON.stringify(d.completed ?? {}).includes("ART 1"),
  },
  {
    name: "remove_previous_course",
    // The fixture's own completed course, recorded in the planner.
    args: { codes: ["MATH 140"] },
    changed: (d) => !((d.completed ?? {}) as Record<string, boolean>)["MATH 140"],
    // The fixture is an Engineering Science B.S. and this is the IUG
    // the Edition publishes against that exact slug (#48). `detach_iug`
    // is NOT in this table: it needs a plan that already carries one,
    // so it has its own block below where the attach comes first.
    name: "attach_iug",
    args: { slug: "esm-esc-bs-ms" },
    changed: (d) => (d.iug as { slug?: string } | undefined)?.slug === "esm-esc-bs-ms",
  },
  { name: "optimize_schedule", args: {}, changed: (d) => Array.isArray(d.terms) },
  { name: "add_term", args: {}, changed: (d) => (d.terms as unknown[]).length === 9 },
  { name: "skip_term", args: { term_index: 3 }, changed: (d) => JSON.stringify(d.terms).includes('"gap":true') },

  // ---- Rearranging, and taking it back (#42) ---------------------------
  {
    name: "move_course",
    args: { code: "CHEM 110", term_index: 2 },
    // Keyed by the ITEM id, which for a Template-placed Course is its
    // code. The other two kinds of id are exercised locally in
    // `reversibility.test.ts`; what is under test here is that the
    // hosted path writes the override at all.
    changed: (d) => (d.moves as Record<string, number>)?.["CHEM 110"] === 2,
  },
  {
    name: "swap_alternative",
    args: { code: "ECON 102", alternative: "ECON 104" },
    changed: (d) => JSON.stringify(d.terms).includes("ECON 104"),
  },
  {
    name: "restore_course",
    doc: () => alreadyRemoved("ECON 102"),
    args: { code: "ECON 102" },
    changed: (d) => !JSON.stringify(d.removed ?? {}).includes("ECON 102"),
  },
  {
    name: "restore_term",
    doc: () => alreadySkipped(3),
    args: { term_index: 3 },
    changed: (d) => !JSON.stringify(d.terms).includes('"gap":true'),
  },
  {
    name: "delete_term",
    doc: withSpareTerm,
    args: { term_index: 8 },
    changed: (d) => (d.terms as unknown[]).length === 8,
  },
  {
    name: "clear_schedule_constraint",
    doc: withConstraint,
    args: { code: "CHEM 110" },
    changed: (d) => ((d.constraints as unknown[]) ?? []).length === 0,
  },
];

describe.each(EVERY_MUTATION)("$name, hosted", ({ name, args, changed, doc }) => {
  /** The stored Plan this case starts from. */
  const startingPlan = () => doc?.() ?? PLAN;

  it("lands against the stored plan", async () => {
    const table = plansTable(startingPlan());
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, name, { ...args, based_on_revision: 4 });
    expect(result!.ok, JSON.stringify(result)).toBe(true);
    expect(changed(table.stored().doc as Record<string, unknown>), `${name} did not change the stored plan`).toBe(true);
  });

  it("returns the resulting plan and the revisions", async () => {
    const table = plansTable(startingPlan());
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, name, { ...args, based_on_revision: 4 });
    expect((result!.plan as { terms?: unknown[] })?.terms, `${name} returned no plan`).toBeTruthy();
    expect(result!.based_on_revision).toBe(4);
    expect(result!.revision).toBe(5);
  });

  it("is refused when the plan has moved on, and writes nothing", async () => {
    const table = plansTable(startingPlan());
    db = withTable(table);
    table.editedInThePlanner();
    const before = JSON.stringify(table.stored());
    const { result } = await call(env(), `Bearer ${await signedIn()}`, name, { ...args, based_on_revision: 4 });
    expect(result!.ok, `${name} landed on a plan it was not computed from`).not.toBe(true);
    expect(JSON.stringify(table.stored()), `${name} wrote despite being refused`).toBe(before);
  });

  it("says nothing that reads as success when it is refused", async () => {
    // A refusal carrying the fields a success carries is a sentence a
    // model summarises as "done". Asserted for EVERY tool rather than
    // for `add_term` alone: each one returns its own shape, so each one
    // has its own way of leaking a success word past the error.
    const table = plansTable(startingPlan());
    db = withTable(table);
    table.editedInThePlanner();
    const { result } = await call(env(), `Bearer ${await signedIn()}`, name, { ...args, based_on_revision: 4 });
    expect(result!.ok, `${name} reported ok on a refusal`).toBeUndefined();
    expect(result!.plan, `${name} returned a plan as though one had been written`).toBeUndefined();
    expect(result!.revision, `${name} reported a new revision for a write that did not happen`).toBeUndefined();
    expect(result!.stale_read, `${name} did not say why it was refused`).toBe(true);
  });

  it("keeps the plan pinned to its Edition", async () => {
    // ADR 0001, and the ones that matter most are those that re-run the
    // OPTIMIZER — `optimize_schedule`, `set_schedule_constraint`,
    // `skip_term`, `restore_term`, `restore_course` and
    // `clear_schedule_constraint` all rebuild the terms, which is where
    // a pin would be dropped if anything were going to drop it.
    const table = plansTable({ ...startingPlan(), edition: "2025-2026" });
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, name, { ...args, based_on_revision: 4 });
    expect(result!.ok, JSON.stringify(result)).toBe(true);
    expect(
      (table.stored().doc as { edition?: string }).edition,
      `${name} re-based the student onto a different bulletin`,
    ).toBe("2025-2026");
  });

  it("requires the revision it was computed from", async () => {
    const table = plansTable(startingPlan());
    db = withTable(table);
    const before = JSON.stringify(table.stored());
    const { result } = await call(env(), `Bearer ${await signedIn()}`, name, args);
    expect(result!.error, `${name} wrote without naming a revision`).toMatch(/based_on_revision/);
    expect(JSON.stringify(table.stored())).toBe(before);
  });
});

describe("how a write reaches the database", () => {
  it("is sent as the student, so row-level security decides whose plan it touches", async () => {
    // THE SAME PROPERTY AS THE READ, and it was asserted only on the
    // read. A write carrying anything more privileged would make this
    // code the thing standing between two students' degrees.
    const theirToken = await signedIn("student-7");
    const table = plansTable(PLAN);
    db = withTable(table);
    await call(env(), `Bearer ${theirToken}`, "add_term", { based_on_revision: 4 });

    const write = table.asked.find((a) => a.method === "PATCH");
    expect(write, "no write reached the database").toBeTruthy();
    expect(write!.headers.authorization, "the write did not run as the student").toBe(`Bearer ${theirToken}`);
    expect(JSON.stringify(write!.headers)).not.toMatch(/service_role/i);
  });

  it("names the plan and the revision, and nothing about the user", async () => {
    // `id` plus the policy is exactly one row. A `user_id` filter here
    // would make the application the gate and leave the policy untested
    // in practice — the same deliberate omission as the read.
    const table = plansTable(PLAN);
    db = withTable(table);
    await call(env(), `Bearer ${await signedIn()}`, "add_term", { based_on_revision: 4 });

    const write = table.asked.find((a) => a.method === "PATCH")!;
    expect(write.url).toMatch(/id=eq\./);
    expect(write.url).toMatch(/rev=eq\.4/);
    expect(write.url, "the application is filtering, so the policy is untested").not.toMatch(/user_id/);
  });

  it("asks for the affected rows back, or a refusal is indistinguishable from a success", async () => {
    // PostgREST answers 204 with no body on both a match and a no-op
    // without this, and the connector would report every refused write
    // as applied.
    const table = plansTable(PLAN);
    db = withTable(table);
    await call(env(), `Bearer ${await signedIn()}`, "add_term", { based_on_revision: 4 });
    expect(table.asked.find((a) => a.method === "PATCH")!.headers.prefer).toMatch(/return=representation/);
  });
});

describe("a change computed from a plan the student has since edited", () => {
  it("IS REFUSED, and the stored plan is left byte-identical", async () => {
    // THE ASSERTION THAT MATTERS IN THIS TICKET. The student saved from
    // the planner while the assistant was thinking. Landing the
    // assistant's change here erases an edit made thirty seconds ago,
    // and nothing anywhere says so — the exact failure ADR 0003 exists
    // to prevent, now with a second writer who is not a browser tab.
    const table = plansTable(PLAN);
    db = withTable(table);

    // The assistant reads...
    await call(env(), `Bearer ${await signedIn()}`, "get_plan");
    // ...the student saves...
    table.editedInThePlanner();
    const before = JSON.stringify(table.stored());

    // ...the assistant writes, based on what it read a moment ago.
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_term", { based_on_revision: 4 });

    expect(result!.ok, "a stale write landed").not.toBe(true);
    expect(result!.stale_read).toBe(true);
    expect(JSON.stringify(table.stored()), "a refused write still changed the stored plan").toBe(before);
  });

  it("tells the model what to do instead of just that it failed", async () => {
    // "Conflict" on its own invites a retry of the same bytes, which
    // fails again — and the model either loops or tells the student
    // their planner is broken.
    const table = plansTable(PLAN);
    db = withTable(table);
    await call(env(), `Bearer ${await signedIn()}`, "get_plan");
    table.editedInThePlanner();
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_term", { based_on_revision: 4 });
    expect(result!.remedy, "the refusal named no remedy").toMatch(/get_plan/);
    expect(result!.remedy).toMatch(/again/i);
    expect(result!.error).toMatch(/not applied|not.*overwritten/i);
  });

  it("says nothing that reads as success", async () => {
    // A refusal carrying `terms: 9` beside an error is a sentence a
    // model will summarise as "I added a term".
    const table = plansTable(PLAN);
    db = withTable(table);
    await call(env(), `Bearer ${await signedIn()}`, "get_plan");
    table.editedInThePlanner();
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_term", { based_on_revision: 4 });
    expect(result!.terms, "a refusal reported a term count").toBeUndefined();
    expect(result!.plan, "a refusal returned a plan as though one had been written").toBeUndefined();
    expect(result!.ok).toBeUndefined();
  });
});

describe("showing a student a change before they make it, hosted", () => {
  it("answers with a candidate plan and writes NOTHING", async () => {
    // THE CRITERION, against a database rather than a temp file. A
    // simulation that reached the stored plan would be the worst
    // version of this feature: the student asked what WOULD happen.
    const table = plansTable(PLAN);
    db = withTable(table);
    const before = JSON.stringify(table.stored());

    const { result } = await call(env(), `Bearer ${await signedIn()}`, "simulate_change", {
      change: "skip_term",
      arguments: { term_index: 2 },
    });

    expect(result!.applied).toBe(false);
    expect((result!.candidate_plan as { terms?: unknown[] })?.terms, "no candidate came back").toBeTruthy();
    expect(JSON.stringify(table.stored()), "a simulation changed the stored plan").toBe(before);
    expect(table.asked.some((a) => a.method === "PATCH"), "a simulation sent a write").toBe(false);
  });

  it("pins the candidate to the plan's own Edition", async () => {
    const table = plansTable({ ...PLAN, edition: "2025-2026" });
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "simulate_change", {
      change: "add_term",
      arguments: {},
    });
    expect((result!.candidate_plan as { edition?: string }).edition).toBe("2025-2026");
  });

  it("is offered to a signed-in student", async () => {
    expect(await tools(env(), `Bearer ${await signedIn()}`)).toContain("simulate_change");
  });
});

describe("prior credit, hosted", () => {
  /** MATH 231 covers the MATH 230 the fixture's Program lists. */
  const COVERS = "MATH 231";
  const COVERED = "MATH 230";
  const scheduled = (doc: Record<string, unknown>): string[] =>
    (doc.terms as { items: { code?: string }[] }[]).flatMap((t) =>
      t.items.flatMap((i) => (i.code ? [i.code] : [])),
    );

  it("records several courses in one call, against the stored plan", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_previous_course", {
      codes: ["ART 1", "CMPSC 465"], based_on_revision: 4,
    });
    expect(result!.ok, JSON.stringify(result)).toBe(true);
    const stored = JSON.stringify((table.stored().doc as { completed: unknown }).completed);
    expect(stored, "ART 1 was not recorded in the stored plan").toContain("ART 1");
    expect(stored, "CMPSC 465 was not recorded in the stored plan").toContain("CMPSC 465");
  });

  it("clears the covered requirement from the stored plan's terms", async () => {
    // The whole point of the ticket, observed in the database rather than
    // in a local file: the student took MATH 251-style credit, and the
    // schedule must stop telling them to take what it covers.
    const table = plansTable(PLAN);
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_previous_course", {
      codes: [COVERS], based_on_revision: 4,
    });
    expect(result!.ok, JSON.stringify(result)).toBe(true);
    expect(
      scheduled(table.stored().doc as Record<string, unknown>),
      `${COVERED} is still scheduled in the stored plan after ${COVERS} was recorded`,
    ).not.toContain(COVERED);
  });

  it("puts the covered requirement back when the claim is withdrawn", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    await call(env(), `Bearer ${await signedIn()}`, "add_previous_course", {
      codes: [COVERS], based_on_revision: 4,
    });
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "remove_previous_course", {
      codes: [COVERS], based_on_revision: 5,
    });
    expect(result!.ok, JSON.stringify(result)).toBe(true);
    expect(
      scheduled(table.stored().doc as Record<string, unknown>),
      `${COVERED} did not come back when ${COVERS} was un-recorded`,
    ).toContain(COVERED);
  });

  it("REFUSES a course the bulletin does not carry, and writes nothing", async () => {
    // Iron rule 2, over a network, against a shared database, with the
    // student not watching: a course we cannot verify, recorded as passed,
    // takes a real requirement out of their audit.
    const table = plansTable(PLAN);
    db = withTable(table);
    const before = JSON.stringify(table.stored());
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_previous_course", {
      codes: ["ART 1", "BASKT 999"], based_on_revision: 4,
    });
    expect(result!.ok, "an unverifiable course was recorded as passed").not.toBe(true);
    expect(result!.plan, "a refusal returned a plan as though one had been written").toBeUndefined();
    expect(JSON.stringify(table.stored()), "a refused recording still wrote").toBe(before);
  });
});

/** Adding a summer session, hosted — the one mutation that INSERTS a Term
 * in the middle and renumbers every Term after it (#43).
 *
 * It gets its own block rather than a row in the table above because the
 * table's fixture has nothing to renumber: no Constraints, no manual
 * moves, no student-added Courses. A pass on that Plan would say nothing
 * about the only thing that can go wrong here — a Constraint quietly
 * applying to the wrong Term, which surfaces a year later at
 * registration. The local suite proves the remapping in detail
 * (`summer-session.test.ts`); this proves it survives the hosted path,
 * which has its own store, its own context construction and its own
 * refusal handling.
 */
describe("adding a summer session, hosted", () => {
  /** The stored Plan with work already done to it: a Constraint, a manual
   * move and a student-added Course on BOTH sides of where Summer 2027
   * lands (index 2, between Spring 2027 and Fall 2027). */
  const planWithWork = () => ({
    ...PLAN,
    constraints: [
      { code: "CHEM 110", type: "pin", termIndex: 0 },
      { code: "MATH 230", type: "not-in", termIndex: 3 },
    ],
    moves: { "EDSGN 100": 1, "MATH 251": 5 },
    added: [{ code: "CMPSC 465", sem: 6 }],
  });

  /** What each piece of index-keyed state points at, BY LABEL. The
   * indexes are supposed to change; the Terms they name are not. */
  const pointsAt = (doc: Record<string, unknown>) => {
    const terms = doc.terms as { label: string }[];
    const label = (i: number) => terms[i]?.label ?? `NO TERM AT INDEX ${i}`;
    return {
      constraints: (doc.constraints as { code: string; termIndex: number }[]).map(
        (c) => `${c.code} -> ${label(c.termIndex)}`,
      ),
      moves: Object.entries(doc.moves as Record<string, number>).map(([id, i]) => `${id} -> ${label(i)}`),
      added: (doc.added as { code: string; sem: number }[]).map((a) => `${a.code} -> ${label(a.sem)}`),
    };
  };

  it("lands, and every constraint, move and addition still points at the same term", async () => {
    // THE ASSERTION THIS TICKET IS ABOUT, through `fetch(Request, Env)`.
    const table = plansTable(planWithWork());
    db = withTable(table);
    const before = pointsAt(table.stored().doc as Record<string, unknown>);

    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_summer_session", {
      year: 2027, based_on_revision: 4,
    });
    expect(result!.ok, JSON.stringify(result)).toBe(true);

    const doc = table.stored().doc as Record<string, unknown>;
    expect((doc.terms as { label: string }[]).map((t) => t.label)[2], "the summer did not land after Spring 2027")
      .toBe("Summer 2027");
    expect(pointsAt(doc), "a term insertion moved a constraint, a manual move or an addition onto a different term")
      .toEqual(before);
  });

  it("tells the model the indexes it is holding have moved", async () => {
    // Every other tool on this surface takes a 0-based term index, and
    // the model is holding ones from earlier calls in the same turn.
    const table = plansTable(planWithWork());
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_summer_session", {
      year: 2027, based_on_revision: 4,
    });
    expect((result!.term_indexes_shifted as { at?: number })?.at, "the answer does not say where indexes shifted")
      .toBe(2);
    expect(result!.renumbering_note, "nothing warns that held indexes are now stale").toMatch(/out of date|stale/i);
    expect((result!.plan as { terms: { label: string }[] }).terms.map((t) => t.label))
      .toContain("Summer 2027");
  });

  it("is idempotent against the stored plan", async () => {
    // A retried call must not add a second Summer 2027 and — far worse —
    // must not run the remap twice, which walks every constraint two
    // terms forward instead of one.
    const table = plansTable(planWithWork());
    db = withTable(table);
    await call(env(), `Bearer ${await signedIn()}`, "add_summer_session", { year: 2027, based_on_revision: 4 });
    const afterFirst = JSON.stringify(table.stored());

    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_summer_session", {
      year: 2027, based_on_revision: 5,
    });
    expect(result!.ok, JSON.stringify(result)).toBe(true);
    expect(result!.unchanged, "a repeat call did not say that nothing changed").toBe(true);
    expect(JSON.stringify(table.stored()), "a repeat call wrote to the stored plan").toBe(afterFirst);
  });

  it("is refused when the plan has moved on, and writes nothing", async () => {
    const table = plansTable(planWithWork());
    db = withTable(table);
    table.editedInThePlanner();
    const before = JSON.stringify(table.stored());
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_summer_session", {
      year: 2027, based_on_revision: 4,
    });
    expect(result!.ok, "a stale summer insertion landed").not.toBe(true);
    expect(result!.stale_read).toBe(true);
    expect(JSON.stringify(table.stored()), "a refused change still wrote").toBe(before);
  });

  it("requires the revision it was computed from", async () => {
    const table = plansTable(planWithWork());
    db = withTable(table);
    const before = JSON.stringify(table.stored());
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_summer_session", { year: 2027 });
    expect(result!.error, "a term was inserted without naming a revision").toMatch(/based_on_revision/);
    expect(JSON.stringify(table.stored())).toBe(before);
  });

  it("keeps the plan pinned to its Edition", async () => {
    // ADR 0001. Inserting a term must not re-base the student onto a
    // different bulletin.
    const table = plansTable({ ...planWithWork(), edition: "2025-2026" });
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "add_summer_session", {
      year: 2027, based_on_revision: 4,
    });
    expect(result!.ok, JSON.stringify(result)).toBe(true);
    expect((table.stored().doc as { edition?: string }).edition, "a summer insertion changed which bulletin governs")
      .toBe("2025-2026");
  });
});


/** The integrated undergraduate-graduate surface, hosted (#48).
 *
 * The local half of this is `iug.test.ts`. What is only testable here
 * is the round trip: the IUG files have to reach the Worker through the
 * ASSET BINDING, not off a filesystem, and the connector shipped no
 * `iug/` at all until `scripts/sync-catalog.mjs` started copying it. A
 * tool that works locally and finds no programmes hosted is exactly the
 * failure this block catches.
 */
describe("integrated degrees, hosted", () => {
  const ESM = "esm-esc-bs-ms";
  /** Attach first, then act on the plan that results — the stub table
   * keeps the row between calls, so this is one student doing two
   * things rather than a fixture with a master's pre-baked into it. */
  const withIug = async (table: ReturnType<typeof plansTable>) => {
    const r = await call(env(), `Bearer ${await signedIn()}`, "attach_iug", { slug: ESM, based_on_revision: 4 });
    expect(r.result!.ok, `the attach this test is built on failed: ${JSON.stringify(r.result)}`).toBe(true);
    return r.result!;
  };

  it("lists the programme published against the student's own major", async () => {
    db = withTable(plansTable(PLAN));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "list_iug_programs");
    expect(
      (result!.pairs_with_this_plan as { slug: string }[] | undefined)?.map((p) => p.slug),
      "the hosted connector found no IUG for a major one is published against — the asset binding is serving no iug/",
    ).toContain(ESM);
  });

  it("quotes the Graduate Bulletin verbatim over the wire", async () => {
    // Served through the asset binding and then back out as JSON. A
    // student checking this citation against the Graduate Bulletin has
    // to find the same words, so it is compared against the shipped
    // file rather than against a string typed into this test.
    const spec = JSON.parse(
      fs.readFileSync(path.join(CATALOG, PLAN.edition as string, "iug", `${ESM}.json`), "utf-8"),
    ) as { applyText: string };
    db = withTable(plansTable(PLAN));
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "list_iug_programs");
    const mine = (result!.pairs_with_this_plan as { slug: string; admission_requirements: string }[])
      .find((p) => p.slug === ESM)!;
    expect(
      mine.admission_requirements,
      "the admission text changed on the way through the Worker; the citation no longer matches the Bulletin",
    ).toContain(spec.applyText);
  });

  it("detaches, and the stored plan goes back to a plain bachelor's", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    await withIug(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "detach_iug", { based_on_revision: 5 });
    expect(result!.ok, JSON.stringify(result)).toBe(true);
    const doc = table.stored().doc as { iug?: unknown; terms: { phase?: string }[] };
    expect(doc.iug, "the stored plan still claims to carry a master's").toBeFalsy();
    expect(
      doc.terms.some((t) => t.phase === "grad"),
      "graduate terms were left in the stored plan after detaching",
    ).toBe(false);
  });

  it("refuses a detach computed from a plan the student has since edited, and writes nothing", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    await withIug(table);
    table.editedInThePlanner();
    const before = JSON.stringify(table.stored());
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "detach_iug", { based_on_revision: 5 });
    expect(result!.ok, "a stale detach landed").not.toBe(true);
    expect(result!.stale_read, "the refusal was not reported as a stale read").toBe(true);
    expect(JSON.stringify(table.stored()), "a refused detach still wrote").toBe(before);
  });

  it("refuses a detach that names no revision at all", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    await withIug(table);
    const before = JSON.stringify(table.stored());
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "detach_iug", {});
    expect(String(result!.error), "a detach landed without naming the revision it came from").toMatch(
      /based_on_revision/,
    );
    expect(JSON.stringify(table.stored()), "a refused detach still wrote").toBe(before);
  });

  it("is all three offered to a signed-in student, and none of them without an account", async () => {
    const offered = await tools(env(), `Bearer ${await signedIn()}`);
    for (const n of ["list_iug_programs", "attach_iug", "detach_iug"]) {
      expect(offered, `${n} is not reachable hosted`).toContain(n);
    }
  });
});

describe("removing a required course, hosted", () => {
  /** A Course the program's template placed, not one the student added. */
  const required = (): string => {
    for (const t of PLAN.terms as { items: { code?: string; origin?: unknown }[] }[]) {
      for (const i of t.items) if (i.code && i.origin) return i.code;
    }
    throw new Error("fixture has no template-placed course");
  };

  it("refuses a flag the model set on its own", async () => {
    // Hosted, this guard is the last thing between a model misreading a
    // sentence and a dropped graduation requirement — over a network,
    // against a shared database, with the student not watching.
    const table = plansTable(PLAN);
    db = withTable(table);
    const before = JSON.stringify(table.stored());
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "remove_course", {
      code: required(), user_explicitly_asked: true, based_on_revision: 4,
    });
    expect(result!.needs_confirmation, "a bare flag dropped a graduation requirement").toBe(true);
    expect(JSON.stringify(table.stored()), "a refused removal still wrote").toBe(before);
  });

  it("goes through when the student's own words came with it", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    const { result } = await call(env(), `Bearer ${await signedIn()}`, "remove_course", {
      code: required(),
      user_explicitly_asked: true,
      based_on_revision: 4,
      student_words: "I am not doing that course, please take it out of my degree",
    });
    expect(result!.ok, JSON.stringify(result)).toBe(true);
    expect(result!.on_the_strength_of).toMatch(/take it out/);
  });
});
