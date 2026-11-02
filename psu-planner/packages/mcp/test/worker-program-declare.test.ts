/** Declaring a Program through the hosted connector (#47).
 *
 * `program-declare.test.ts` drives `executeTool` directly. That is the
 * seam, but it is not the deploy: the Worker builds its own context,
 * reads the catalog over its asset binding rather than off disk, and
 * writes through PostgREST with a compare-and-swap. "The local one
 * works" has never been evidence about any of those, and this ticket
 * adds a catalog artifact — the suggested-plan grids — that the hosted
 * path reaches by HTTP and the local one by `readFileSync`. A grid that
 * ships but is not served is a connector that adds a major and places
 * none of its courses.
 *
 * THE REFUSALS MATTER AS MUCH AS THE SUCCESS, and get more of the file.
 * Dropping a Program removes a set of requirements at once, so the gate
 * in front of it is the most consequential one this server has: the
 * difference between a model asserting consent and a student giving it
 * has to hold on the deployed path, not only on the one the tests find
 * convenient.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetInMemoryCounters, type KVLike } from "@psu-planner/identity";
import worker, { type Env } from "../src/worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const SECRET = "test-jwt-secret";

const PLAN = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "plan.json"), "utf-8")).plan;

/** Requirements and no grid, which is most minors. Prescribes MATH 140,
 * which the fixture student has already passed. */
const MATH_MINOR = "eberly-science-mathematics-minor";
/** A second major, which DOES publish a grid — so this file exercises
 * the artifact the ticket added and not only the path around it. */
const STATS_MAJOR = "eberly-science-statistics-bs";
const ESC = "engineering-engineering-science-bs";

const SAID = "i want the math minor off my degree, it's too much on top of engineering";

/** The asset binding, which is how the hosted connector reaches every
 * catalog file — including the `plans/` grids this ticket added. */
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
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function signedIn(sub = "student-1"): Promise<string> {
  const payload = { sub, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: "s@psu.edu" };
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `Bearer ${body}.${b64url(sig)}`;
}

const env = (): Env =>
  ({
    CATALOG: assets,
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    OAUTH: memoryKv(),
  }) as Env;

/** A stateful stand-in for PostgREST that honours the `rev=eq.` filter,
 * BECAUSE THAT FILTER IS THE COMPARE-AND-SWAP (ADR 0003). A stub that
 * accepted every PATCH would certify a connector the real database
 * refuses — the mistake this project has now made three times. Modelled
 * the same way in `worker-plan.test.ts`: two stubs for one database must
 * not have two fidelities. */
function plansTable(initial: Record<string, unknown>, rev = 4) {
  let row = { id: "fixture-plan", doc: initial, rev, updated_at: "2026-10-20T09:00:00.000Z" };

  const reply = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET") return Response.json([row]);
    const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");
    if (eq("id") !== row.id || eq("rev") !== String(row.rev)) return Response.json([]);
    const sent = JSON.parse(String(init?.body ?? "{}")) as {
      doc: Record<string, unknown>; rev: number; updated_at: string;
    };
    // Migration 0003's trigger: a revision that does not advance is refused.
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
    stored: () => row,
    /** The student saves from the planner, which is what makes the
     * assistant's in-flight change stale. */
    editedInThePlanner: () => { row = { ...row, rev: row.rev + 1 }; },
  };
}

function withTable(table: ReturnType<typeof plansTable>) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => table.reply(input, init)) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; } };
}

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
  if (!line) return { status: res.status, result: null as Record<string, unknown> | null };
  return {
    status: res.status,
    result: JSON.parse(JSON.parse(line.slice(5).trim()).result.content[0].text) as Record<string, unknown>,
  };
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
  const line = (await res.text()).split("\n").filter((l) => l.startsWith("data:")).pop()!;
  return (JSON.parse(line.slice(5).trim()).result.tools as { name: string }[]).map((t) => t.name);
}

const codesIn = (doc: Record<string, unknown>): string[] =>
  (doc.terms as { items: Record<string, unknown>[] }[]).flatMap((t) =>
    t.items.flatMap((i) => ("code" in i ? [String(i.code)] : [])),
  );

let db: { restore: () => void } | null = null;
beforeEach(() => resetInMemoryCounters());
afterEach(() => { db?.restore(); db = null; });

describe("both tools are reachable hosted at all", () => {
  it("are offered to a signed-in student", async () => {
    const offered = await tools(env(), await signedIn());
    expect(offered, "add_program is not reachable hosted").toContain("add_program");
    expect(offered, "remove_program is not reachable hosted").toContain("remove_program");
  });

  it("are not offered without a token", async () => {
    // Writing to a degree is not something an anonymous caller does. The
    // catalog-only surface is what an unauthenticated session gets.
    const res = await worker.fetch(
      new Request("https://mcp.lionsdegree.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      env(),
    );
    const line = (await res.text()).split("\n").filter((l) => l.startsWith("data:")).pop();
    const offered = line
      ? (JSON.parse(line.slice(5).trim()).result?.tools as { name: string }[] | undefined)?.map((t) => t.name) ?? []
      : [];
    expect(offered, "an unauthenticated caller is offered a tool that rewrites a degree").not.toContain("add_program");
    expect(offered, "an unauthenticated caller is offered a tool that drops a program").not.toContain("remove_program");
  });
});

describe("a signed-in student declaring a program, hosted", () => {
  it("lands, and the stored plan carries it", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    const { result } = await call(env(), await signedIn(), "add_program", {
      slug: MATH_MINOR,
      based_on_revision: 4,
    });
    expect(result!.ok, `the hosted connector refused a real minor: ${JSON.stringify(result).slice(0, 300)}`).toBe(true);
    expect(
      (table.stored().doc as { programs: string[] }).programs,
      "the program is not on the row the database holds",
    ).toContain(MATH_MINOR);
    expect(result!.revision, "the write did not advance the revision").toBe(5);
  });

  it("reads the suggested-plan grid over the asset binding", async () => {
    // THE ARTIFACT THIS TICKET ADDED. A second major's courses only reach
    // the plan if `plans/<slug>.json` is actually served; the local tests
    // would pass on a tree where it ships and the Worker cannot fetch it.
    const table = plansTable(PLAN);
    db = withTable(table);
    const { result } = await call(env(), await signedIn(), "add_program", {
      slug: STATS_MAJOR,
      based_on_revision: 4,
    });
    expect(result!.ok, `the hosted connector refused a real major: ${JSON.stringify(result).slice(0, 300)}`).toBe(true);
    expect(
      (result!.courses_added as string[]).length,
      "a second major with a published grid added no courses — the grid did not reach the Worker",
    ).toBeGreaterThan(0);
    expect(result!.placement, "a program WITH a grid was described as having none").toBeUndefined();
  });

  it("keeps the student's completed courses and their major", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    await call(env(), await signedIn(), "add_program", { slug: MATH_MINOR, based_on_revision: 4 });
    const doc = table.stored().doc as { completed: Record<string, boolean>; programs: string[] };
    expect(doc.completed["MATH 140"], "a completed course was reset by declaring a minor, hosted").toBe(true);
    expect(doc.programs, "declaring a minor dropped the student's major, hosted").toContain(ESC);
  });

  it("stays pinned to the plan's own Edition", async () => {
    // ADR 0001, checked on the path that picks the Edition for itself.
    const table = plansTable({ ...PLAN, edition: "2025-2026" });
    db = withTable(table);
    const { result } = await call(env(), await signedIn(), "add_program", {
      slug: MATH_MINOR,
      based_on_revision: 4,
    });
    expect(result!.ok, JSON.stringify(result).slice(0, 300)).toBe(true);
    expect(
      (table.stored().doc as { edition: string }).edition,
      "the hosted connector re-based a continuing student onto another bulletin",
    ).toBe("2025-2026");
  });

  it("is refused on a stale revision, and the row is untouched", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    table.editedInThePlanner();
    const { result } = await call(env(), await signedIn(), "add_program", {
      slug: MATH_MINOR,
      based_on_revision: 4,
    });
    expect(result!.stale_read, "a change computed from a revision the planner has moved past was applied").toBe(true);
    expect(
      (table.stored().doc as { programs: string[] }).programs,
      "a refused declaration still changed the stored plan",
    ).not.toContain(MATH_MINOR);
  });

  it("is refused for a program this edition does not publish", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    const { result } = await call(env(), await signedIn(), "add_program", {
      slug: "quantum-sorcery-minor",
      based_on_revision: 4,
    });
    expect(result!.ok, "a program that does not exist was added, hosted").not.toBe(true);
    expect(result!.editions_this_connector_carries, "the refusal does not say which editions are held").toBeTruthy();
    expect(table.stored().rev, "a refused declaration advanced the revision").toBe(4);
  });
});

describe("a signed-in student dropping a program, hosted", () => {
  /** The fixture with the minor already declared, so the drop has
   * something to drop without depending on another tool call landing
   * first. */
  const withMinor = () => ({ ...PLAN, programs: [...(PLAN.programs as string[]), MATH_MINOR] });

  it("is refused without the student's own words, and writes nothing", async () => {
    // THE GATE, on the deployed path. A boolean is the easiest thing in
    // the world for a model to assert.
    const table = plansTable(withMinor());
    db = withTable(table);
    const { result } = await call(env(), await signedIn(), "remove_program", {
      slug: MATH_MINOR,
      user_explicitly_asked: true,
      based_on_revision: 4,
    });
    expect(result!.ok, "a program was dropped on a model's say-so, hosted").not.toBe(true);
    expect(result!.error, "the refusal does not ask for the student's words").toMatch(/student_words/i);
    expect(result!.needs_confirmation).toBe(true);
    expect(table.stored().rev, "a refused drop advanced the revision").toBe(4);
    expect(
      (table.stored().doc as { programs: string[] }).programs,
      "a refused drop removed the program anyway",
    ).toContain(MATH_MINOR);
  });

  it("is refused when the words are the model narrating its own authority", async () => {
    const table = plansTable(withMinor());
    db = withTable(table);
    const { result } = await call(env(), await signedIn(), "remove_program", {
      slug: MATH_MINOR,
      user_explicitly_asked: true,
      student_words: "the user confirmed they want this dropped",
      based_on_revision: 4,
    });
    expect(result!.ok, "a model's description of the student was accepted as the student, hosted").not.toBe(true);
    expect(
      (table.stored().doc as { programs: string[] }).programs,
      "a refused drop removed the program anyway",
    ).toContain(MATH_MINOR);
  });

  it("drops it when the student has asked, and echoes what they said", async () => {
    const table = plansTable(withMinor());
    db = withTable(table);
    const { result } = await call(env(), await signedIn(), "remove_program", {
      slug: MATH_MINOR,
      user_explicitly_asked: true,
      student_words: SAID,
      based_on_revision: 4,
    });
    expect(result!.ok, `the hosted drop was refused: ${JSON.stringify(result).slice(0, 300)}`).toBe(true);
    expect(
      (table.stored().doc as { programs: string[] }).programs,
      "the program is still on the row the database holds",
    ).not.toContain(MATH_MINOR);
    // Nothing here can verify the student said this. What is real is that
    // a fabricated sentence now sits in the transcript beside a dropped
    // degree, where the student can find it.
    expect(result!.on_the_strength_of, "the sentence the drop was justified by is not in the answer").toBe(SAID);
  });

  it("names what it removed and what another program still needs", async () => {
    // DECLARED THROUGH THE CONNECTOR FIRST, not injected into the row.
    // `coursesKept` means "this Program placed it and another still
    // requires it", which is read off the Origin the merge wrote — so a
    // hand-edited `programs` array produces an empty list and would have
    // this test asserting against a state neither surface can reach.
    // Declaring and then dropping is also the round trip a student
    // actually makes.
    const table = plansTable(PLAN);
    db = withTable(table);
    const added = await call(env(), await signedIn(), "add_program", {
      slug: MATH_MINOR,
      based_on_revision: 4,
    });
    expect(added.result!.ok, `the hosted declaration failed: ${JSON.stringify(added.result).slice(0, 300)}`).toBe(true);

    const { result } = await call(env(), await signedIn(), "remove_program", {
      slug: MATH_MINOR,
      user_explicitly_asked: true,
      student_words: SAID,
      based_on_revision: 5,
    });
    expect(result!.ok, `the hosted drop was refused: ${JSON.stringify(result).slice(0, 300)}`).toBe(true);
    expect(result!.courses_kept, "a course the student's major still requires was not reported as kept").toContain(
      "MATH 141",
    );
    expect(codesIn(table.stored().doc), "a course the major still requires was removed with the minor").toContain(
      "MATH 141",
    );
    expect(
      result!.remaining_programs_checked,
      "the answer does not say which programs the unfilled check actually covered",
    ).toContain(ESC);
    expect(Array.isArray(result!.leaves_unfilled), "the answer does not report unfilled requirements").toBe(true);
  });

  it("is refused on a stale revision before the consent gate is reached", async () => {
    // Order matters: a stale drop that passed the consent gate first
    // would echo the student's words into a refusal, which reads like
    // something happened.
    const table = plansTable(withMinor());
    db = withTable(table);
    table.editedInThePlanner();
    const { result } = await call(env(), await signedIn(), "remove_program", {
      slug: MATH_MINOR,
      user_explicitly_asked: true,
      student_words: SAID,
      based_on_revision: 4,
    });
    expect(result!.stale_read, "a drop computed from a stale revision was applied, hosted").toBe(true);
    expect(
      (table.stored().doc as { programs: string[] }).programs,
      "a refused drop removed the program anyway",
    ).toContain(MATH_MINOR);
  });

  it("is refused for a program the plan does not have", async () => {
    const table = plansTable(PLAN);
    db = withTable(table);
    const { result } = await call(env(), await signedIn(), "remove_program", {
      slug: STATS_MAJOR,
      user_explicitly_asked: true,
      student_words: SAID,
      based_on_revision: 4,
    });
    expect(result!.ok).not.toBe(true);
    expect(result!.error, "the refusal does not say the plan does not have that program").toMatch(
      /not one of this plan's programs/i,
    );
    expect(table.stored().rev, "a refused drop advanced the revision").toBe(4);
  });
});

describe("previewing a program change, hosted", () => {
  it("shows what dropping a program would do without demanding consent, and writes nothing", async () => {
    const table = plansTable({ ...PLAN, programs: [...(PLAN.programs as string[]), MATH_MINOR] });
    db = withTable(table);
    const { result } = await call(env(), await signedIn(), "simulate_changes", {
      changes: [{ tool: "remove_program", arguments: { slug: MATH_MINOR, based_on_revision: 4 } }],
    });
    expect(result!.possible, `the hosted preview failed: ${JSON.stringify(result).slice(0, 400)}`).toBe(true);
    expect(result!.applied, "a preview reported itself as applied").toBe(false);
    expect(result!.requires_consent, "the preview did not say the real change needs the student's consent").toBe(true);
    expect(table.stored().rev, "a simulation wrote to the student's row").toBe(4);
    expect(
      (table.stored().doc as { programs: string[] }).programs,
      "a simulated drop changed the stored plan",
    ).toContain(MATH_MINOR);
  });
});
