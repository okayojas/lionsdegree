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
    // DERIVED, not typed out. There are seven mutations and an earlier
    // draft of this list named four — the same miscount that put three
    // of them on the unauthenticated surface in #33.
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
  let row = { doc: initial, rev, updated_at: "2026-10-20T09:00:00.000Z" };
  const reply = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") === "GET") return Response.json([row]);

    const want = url.searchParams.get("rev")?.replace(/^eq\./, "");
    if (String(row.rev) !== want) return Response.json([]); // the refusal
    const sent = JSON.parse(String(init?.body ?? "{}")) as {
      doc: Record<string, unknown>; rev: number; updated_at: string;
    };
    row = { doc: sent.doc, rev: sent.rev, updated_at: sent.updated_at };
    return Response.json([row]);
  };
  return {
    reply,
    stored: () => row,
    /** The student saves from the planner, which is what makes the
     * assistant's in-flight change stale. */
    editedInThePlanner: () => { row = { ...row, rev: row.rev + 1 }; },
  };
}

function withTable(table: ReturnType<typeof plansTable>) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => table.reply(input, init)) as typeof fetch;
  return {
    asked: [] as { url: string; headers: Record<string, string> }[],
    restore: () => { globalThis.fetch = real; },
  };
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
