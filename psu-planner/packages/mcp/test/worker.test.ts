/** The hosted connector, driven as a function.
 *
 * `fetch(Request, Env) -> Response` is the whole Worker, so the suite
 * calls it directly: no wrangler, no port, no process. That is not a
 * convenience — it is the reason the web-standard transport was chosen
 * over the Node one, and it means these run in the same vitest pass as
 * everything else.
 *
 * The catalog is served from the real bundled files through a stub
 * standing in for Cloudflare's asset binding, so what is under test is
 * this Worker against the actual artifacts rather than against fixtures
 * that might have drifted from them.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { type Env } from "../src/worker.js";
import type { CatalogSource } from "../src/source.js";

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "catalog");

const SECRET = "test-jwt-secret";

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A signed-in student.
 *
 * #34 closed the connector: every /mcp request needs one. These tests
 * are about what the connector ANSWERS, not about who may ask — that is
 * `worker-auth.test.ts` — so they carry a valid token and get on with
 * it. */
async function studentToken(sub = "test-student"): Promise<string> {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

let AUTH = "";
beforeAll(async () => { AUTH = `Bearer ${await studentToken()}`; });

/** KV, which the gate needs as well as the sign-in flow: `isRevoked`
 * fails closed without it. */
function memoryKv() {
  const store = new Map<string, string>();
  return {
    async get(k: string, opts?: { cacheTtl?: number }) {
      // Cloudflare rejects a cache TTL below 30. A stub that ignores the
      // option certifies a read the real binding throws on.
      if (opts?.cacheTtl !== undefined && opts.cacheTtl < 30) {
        throw new Error(`Invalid cache_ttl of ${opts.cacheTtl}. Cache TTL must be at least 30.`);
      }
      return store.get(k) ?? null;
    },
    async put(k: string, v: string, opts?: { expirationTtl?: number }) {
      if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) {
        throw new Error("Invalid expiration_ttl. Must be at least 60.");
      }
      store.set(k, v);
    },
    async delete(k: string) { store.delete(k); },
  };
}

/** Cloudflare's asset binding, backed by the files that actually ship. */
const env: Env = {
  SUPABASE_JWT_SECRET: SECRET,
  OAUTH: memoryKv(),
  CATALOG: {
    async fetch(req: Request): Promise<Response> {
      const rel = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ""));
      const file = path.join(CATALOG, rel);
      if (!file.startsWith(CATALOG) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return new Response("not found", { status: 404 });
      }
      return new Response(fs.readFileSync(file, "utf-8"), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
};

const POST = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://mcp.lionsdegree.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: AUTH,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const rpc = (method: string, params: unknown = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params });

const INIT = rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "1" },
});

/* Stateless means every request stands alone: a bare `tools/list` or
   `tools/call` is answered without a prior handshake, and BATCHING one
   with an initialize is rejected ("only one initialization request is
   allowed"). That is the transport being correct, not a limitation —
   there is no session for a second message to belong to. */

/** Read a response body whether it came back as JSON or as one SSE event. */
async function payload(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (text.startsWith("{")) return JSON.parse(text) as Record<string, unknown>;
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return line ? (JSON.parse(line.slice(5).trim()) as Record<string, unknown>) : {};
}

beforeAll(() => {
  if (!fs.existsSync(CATALOG)) {
    throw new Error("no bundled catalog — run `node scripts/sync-catalog.mjs` before this suite");
  }
});

describe("the connector endpoint", () => {
  it("completes an initialize handshake", async () => {
    const res = await worker.fetch(POST(INIT), env);
    expect(res.status).toBe(200);
    const body = await payload(res);
    const result = body.result as { serverInfo?: { name?: string }; capabilities?: unknown };
    expect(result?.serverInfo?.name).toBe("lionsdegree");
    expect(result?.capabilities).toBeTruthy();
  });

  it("is at /mcp, and says so anywhere else", async () => {
    // `/sse` was published for months and is the older transport. A 404
    // that names the right path is the difference between a student
    // fixing their config and giving up.
    for (const p of ["/sse", "/mcp/", "/anything"]) {
      const res = await worker.fetch(new Request(`https://mcp.lionsdegree.com${p}`), env);
      expect(res.status, `${p} should not be the endpoint`).toBe(404);
      expect(await res.text()).toMatch(/\/mcp/);
    }
  });

  it("answers a browser at the root rather than a bare 404", async () => {
    const res = await worker.fetch(new Request("https://mcp.lionsdegree.com/"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/connect/i);
  });
});

describe("what the connector offers", () => {
  it("lists the catalog tools", async () => {
    const res = await worker.fetch(POST(rpc("tools/list")), env);
    const text = await res.text();
    expect(text).toMatch(/search_catalog/);
    expect(text).toMatch(/get_prereq_chain/);
  });

  it("does not advertise a tool that would always refuse", async () => {
    // Nothing here has a Plan until sign-in exists (#34). Offering
    // `get_plan` to a model that cannot use it wastes a turn and teaches
    // it that this connector is unreliable.
    const res = await worker.fetch(POST(rpc("tools/list")), env);
    const text = await res.text();
    for (const planShaped of ["get_plan", "audit_requirements", "remove_course", "optimize_schedule"]) {
      expect(text, `${planShaped} was offered without an account`).not.toMatch(new RegExp(`"${planShaped}"`));
    }
  });
});

describe("answering a question about the Bulletin", () => {
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const res = await worker.fetch(POST(rpc("tools/call", { name, arguments: args })), env);
    const text = await res.text();
    const line = text.split("\n").filter((l) => l.startsWith("data:")).pop();
    const body = line ? JSON.parse(line.slice(5).trim()) : JSON.parse(text);
    const content = (body.result as { content?: { text?: string }[] })?.content;
    return content?.[0]?.text ? JSON.parse(content[0].text) : body;
  };

  it("finds a Course by what it is about, not just by its code", async () => {
    // Needs the postings, which are fetched on demand. If that path were
    // broken search would still return results — just worse ones — so
    // this asks for a term that lives in descriptions.
    const hits = (await callTool("search_catalog", { query: "robotics", limit: 10 })) as { code: string }[];
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThan(3);
    expect(
      hits.some((h) => !h.code.toLowerCase().includes("rob")),
      "every hit matched the code, so the description signal never loaded",
    ).toBe(true);
  });

  it("gives a Course its keywords and bulletin link", async () => {
    // Both live in the subject file, fetched on demand over the asset
    // binding. Empty here would mean the hosted path silently answers
    // with less than the local one.
    const d = (await callTool("get_course_details", { code: "MATH 141" })) as {
      title?: string;
      keywords?: string[];
      bulletin_url?: string;
    };
    expect(d.title).toBeTruthy();
    expect(d.keywords?.length, "no keywords").toBeGreaterThan(0);
    expect(d.bulletin_url ?? "", "no bulletin link").toMatch(/^https?:\/\//);
  });

  it("walks a prerequisite chain deeper than one hop", async () => {
    const chain = (await callTool("get_prereq_chain", { code: "MATH 230", max_depth: 3 })) as Record<string, unknown>;
    const depth = (n: Record<string, unknown>, d = 0): number => {
      const kids = (n.prerequisites as Record<string, unknown>[] | undefined) ?? [];
      return kids.length ? Math.max(...kids.map((k) => depth(k, d + 1))) : d;
    };
    expect(depth(chain)).toBeGreaterThan(1);
  });

  it("refuses a Plan-shaped question in words, not a crash", async () => {
    // A model can still name an unlisted tool. It gets an explanation it
    // can relay, which is the difference between "I can't see your
    // schedule" and the assistant reporting a server error.
    const r = (await callTool("get_plan", {})) as { error?: string };
    expect(String(r.error ?? ""), "get_plan did not explain itself").toMatch(/not signed in|needs your plan/i);
  });
});

describe("when the request is wrong", () => {
  it("answers a malformed body with a JSON-RPC error, not a stack trace", async () => {
    const res = await worker.fetch(POST("{ this is not json"), env);
    const text = await res.text();
    expect(text, "a stack trace reached the client").not.toMatch(/\bat .+:\d+:\d+/);
    expect(text).toMatch(/jsonrpc|error/i);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("fails as JSON-RPC when the catalog is gone, and says nothing internal", async () => {
    // A deploy that lost its assets. Two properties, and they pull
    // against each other: the failure must arrive as JSON-RPC rather
    // than an HTML page the client cannot parse, AND it must not hand an
    // anonymous caller our file layout or build commands. The reason
    // goes to the log.
    const broken: Env = {
      SUPABASE_JWT_SECRET: SECRET,
      OAUTH: memoryKv(),
      CATALOG: { async fetch() { return new Response("nope", { status: 404 }); } },
    } as Env;
    const res = await worker.fetch(POST(INIT), broken);
    const body = await payload(res);
    expect(body.jsonrpc).toBe("2.0");
    const message = String((body.error as { message?: string })?.message ?? "");
    expect(message, "no readable error reached the client").toBeTruthy();
    for (const internal of ["sync-catalog", ".json", "audit-index", "/", "node "]) {
      expect(message, `the error leaked "${internal}" to an unauthenticated caller`).not.toContain(internal);
    }
    // `includes`, not a regex. A `\b` written through a heredoc becomes a
    // literal backspace byte -- this is the eighth time in this project --
    // and a substring check needs no escaping at all.
    expect(message.includes(".ts:"), "a stack trace reached the client").toBe(false);
    expect(message.includes("    at "), "a stack trace reached the client").toBe(false);
  });
});

describe("a warm isolate", () => {
  it("reuses the parsed catalog instead of refetching it", async () => {
    // The audit index is 12.5 MB of heap and ~50ms to parse. Doing that
    // per request would put it on the path of every question a student
    // asks.
    let reads = 0;
    const counting: Env = {
      SUPABASE_JWT_SECRET: SECRET,
      OAUTH: memoryKv(),
      CATALOG: {
        async fetch(req: Request): Promise<Response> {
          reads++;
          return env.CATALOG.fetch(req);
        },
      },
    };
    await worker.fetch(POST(INIT), counting);
    const afterFirst = reads;
    expect(afterFirst, "the first request read nothing").toBeGreaterThan(0);

    await worker.fetch(POST(INIT), counting);
    await worker.fetch(POST(INIT), counting);
    expect(reads, "the catalog was refetched on a warm isolate").toBe(afterFirst);
  });
});

describe("two Editions in one isolate", () => {
  /** THE EXTRA CRITERION, added to #33 after #31's review found it.
   *
   * The search ranking used to be engine MODULE state, so the second
   * Edition to load replaced the first's dictionary globally — and term
   * ids index a SPECIFIC dictionary, so Edition A then scored against
   * Edition B's vocabulary. Permanently, because the loader's memo
   * recorded the work as done. A stale index across an Edition change is
   * a correctness bug (ADR 0001).
   *
   * Unreachable on the local server, which loads exactly one Edition.
   * The normal case here: one isolate, many students.
   */
  it("keeps each Edition's search ranking to itself", async () => {
    const { FsCatalogSource } = await import("../src/source.js");
    const { loadEdition } = await import("../src/catalog.js");
    const { searchCatalog } = await import("@psu-planner/engine");

    // SYNTHETIC, so it always runs. The bundled catalog is gitignored
    // and a fresh checkout may have one Edition or none — the first
    // version of this bailed with a `console.warn` and a bare `return`,
    // which is a green pass asserting nothing, on exactly the criterion
    // it was written for.
    const real = new FsCatalogSource(CATALOG);
    const bundled = (await real.editions())[0];
    expect(bundled, "no catalog bundled — run sync-catalog").toBeTruthy();

    /** Two Editions over one set of files, with DIFFERENT vocabularies
     * so a crossed dictionary is visible rather than merely possible. */
    const twoEditions = (vocabularyOf: (ed: string) => string[]): CatalogSource => ({
      async read<T>(p: string): Promise<T | null> {
        const ed = p.split("/")[0];
        const rest = p.slice(ed.length + 1);
        if (rest === "search-postings.json") {
          return { terms: vocabularyOf(ed), postings: { "MATH 140": [0, 1] } } as T;
        }
        return real.read<T>(`${bundled}/${rest}`);
      },
      async editions() { return ["2024-2025", "2025-2026"]; },
    });

    const source = twoEditions((ed) => (ed === "2024-2025" ? ["alpha", "older"] : ["newer", "zeta"]));
    const [older, newer] = ["2024-2025", "2025-2026"];

    const a = await loadEdition(source, older);
    const b = await loadEdition(source, newer);
    await a.ensureSearchRanking();

    // A has a vocabulary; B has loaded nothing and must say so by
    // scoring on code and title alone — NOT by borrowing A's.
    expect([...a.ranking.terms], "the older edition loaded no ranking").toEqual(["alpha", "older"]);
    expect(b.ranking.terms.length, "the newer edition borrowed another edition's dictionary").toBe(0);

    // Now B loads its own, and A's must be untouched.
    const aTerms = [...a.ranking.terms];
    await b.ensureSearchRanking();

    // THE ASSERTION. Each Edition kept its OWN vocabulary. Term ids
    // index a specific dictionary, so a crossed one is not a worse
    // answer, it is an answer about different words.
    expect([...a.ranking.terms], "loading one edition's ranking changed another's").toEqual(aTerms);
    expect([...a.ranking.terms]).toEqual(["alpha", "older"]);
    expect([...b.ranking.terms]).toEqual(["newer", "zeta"]);
    expect(a.ranking, "both editions share one ranking object").not.toBe(b.ranking);
  });
});

describe("catalog prose reaching a model", () => {
  /** DECISIONS.md 5.0/S4 and 5.1. The first version of this grepped the
   * source for `fenceCatalogText` — which would have passed just as
   * happily if the hosted surface emitted raw Bulletin prose, because
   * the one call site is in `suggest_slot_courses` and that tool is not
   * offered here at all.
   *
   * The property is what matters: nothing the anonymous surface returns
   * carries unfenced Bulletin prose. Today it holds for a stronger
   * reason than fencing — descriptions are not published at all — and
   * this asserts that outcome against every catalog tool's real output
   * rather than against an import. */
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await worker.fetch(POST(rpc("tools/call", { name, arguments: args })), env);
    const text = await res.text();
    const line = text.split("\n").filter((l) => l.startsWith("data:")).pop();
    const body = line ? JSON.parse(line.slice(5).trim()) : JSON.parse(text);
    return ((body.result as { content?: { text?: string }[] })?.content?.[0]?.text) ?? "";
  };

  it("returns no description prose from any tool on the anonymous surface", async () => {
    const { FENCE_TAG } = await import("@psu-planner/engine");
    const outputs = await Promise.all([
      call("search_catalog", { query: "robotics", limit: 10 }),
      call("get_course_details", { code: "MATH 141" }),
      call("get_course_details", { code: "CMPSC 465" }),
      call("get_prereq_chain", { code: "MATH 230", max_depth: 3 }),
      call("search_programs", { query: "computer science" }),
    ]);
    for (const out of outputs) {
      expect(out.length, "a tool returned nothing, so this asserted nothing").toBeGreaterThan(10);
      // The shipped catalog carries no `description` field at all
      // (sync-catalog refuses to build otherwise), so none should ever
      // appear in a response.
      expect(out, "a tool emitted a description field").not.toMatch(/"description"\s*:\s*"[^"]/);
    }
    // And if prose ever does reach a model from here, it must arrive
    // fenced — so the tag existing in output is fine; unfenced prose is
    // not. Stated as a reminder of which way round this goes.
    expect(typeof FENCE_TAG).toBe("string");
  });

  it("fences through the engine rather than a second implementation", async () => {
    // A duplicated security boundary drifts from the original. This is
    // the import check, kept — but it is now the SECOND assertion, not
    // the only one.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "tools.ts"),
      "utf-8",
    );
    const { FENCE_TAG } = await import("@psu-planner/engine");
    expect(src, "the MCP package hardcodes the fence tag instead of importing it").not.toContain(`"${FENCE_TAG}"`);
    expect(src).toMatch(/fenceCatalogText/);
  });
});

describe("the connector's public surface", () => {
  it("answers only its own routes, not whatever is in the catalog tree", async () => {
    // FOUND AGAINST THE LIVE DEPLOY. Cloudflare serves a matching asset
    // BEFORE the handler unless told otherwise, so
    // `/2026-2027/courses/math.json` came back 200 from the bucket and
    // this handler's 404 was never reached — the endpoint's public
    // surface was whatever the catalog happened to contain rather than a
    // decision. `run_worker_first` in wrangler.toml is what fixes it;
    // this asserts the handler's half.
    //
    // Nothing was leaking: the shipped files carry no Bulletin prose
    // (DECISIONS.md 5.1, enforced by sync-catalog) and the same files
    // are already public on lionsdegree.com.
    for (const p of ["/2026-2027/courses/math.json", "/editions.json", "/2026-2027/audit-index.json"]) {
      const res = await worker.fetch(new Request(`https://mcp.lionsdegree.com${p}`), env);
      expect(res.status, `${p} was answered by the connector`).toBe(404);
    }
  });

  it("keeps wrangler configured so the handler actually runs first", () => {
    // The assertion above is about this file; without the config the
    // request never reaches it. Checked together, because either alone
    // passes while the endpoint is wrong.
    const toml = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "wrangler.toml"),
      "utf-8",
    );
    expect(toml, "assets would be served before the Worker").toMatch(/run_worker_first\s*=\s*true/);
  });
});
