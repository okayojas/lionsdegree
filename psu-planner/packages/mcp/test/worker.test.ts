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

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "catalog");

/** Cloudflare's asset binding, backed by the files that actually ship. */
const env: Env = {
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
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
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

  it("says something a protocol client can read when the catalog is gone", async () => {
    // A deploy that lost its assets. The failure has to arrive as JSON-RPC
    // rather than as an HTML error page the client cannot parse.
    const broken: Env = { CATALOG: { async fetch() { return new Response("nope", { status: 404 }); } } };
    const res = await worker.fetch(POST(INIT), broken);
    const body = await payload(res);
    expect(body.jsonrpc).toBe("2.0");
    expect((body.error as { message?: string })?.message).toMatch(/catalog|assets/i);
  });
});

describe("a warm isolate", () => {
  it("reuses the parsed catalog instead of refetching it", async () => {
    // The audit index is 12.5 MB of heap and ~50ms to parse. Doing that
    // per request would put it on the path of every question a student
    // asks.
    let reads = 0;
    const counting: Env = {
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

    const source = new FsCatalogSource(CATALOG);
    const all = await source.editions();
    if (all.length < 2) {
      // Reported, not silently skipped: this is the assertion the
      // criterion was added for, and "there was only one Edition" is a
      // fact about the fixture rather than a pass.
      console.warn(`only ${all.length} edition bundled — run sync-catalog for both to exercise this`);
      return;
    }
    const [older, newer] = [all[0], all[all.length - 1]];

    const a = await loadEdition(source, older);
    const b = await loadEdition(source, newer);
    await a.ensureSearchRanking();

    // A searches well; B has loaded no ranking at all and must say so by
    // scoring on code and title only — NOT by borrowing A's.
    expect(a.ranking.terms.length, "the older edition loaded no ranking").toBeGreaterThan(1000);
    expect(b.ranking.terms.length, "the newer edition borrowed another edition's dictionary").toBe(0);

    // Now B loads its own, and A's must be untouched.
    const aTermsBefore = a.ranking.terms.length;
    await b.ensureSearchRanking();
    expect(b.ranking.terms.length).toBeGreaterThan(1000);
    expect(a.ranking.terms.length, "loading one edition's ranking changed another's").toBe(aTermsBefore);
    expect(a.ranking, "both editions ended up sharing one ranking object").not.toBe(b.ranking);

    // And each still answers from its own catalog.
    for (const ed of [a, b]) {
      const hits = searchCatalog(ed.catalog, "robotics", 10, ed.ranking);
      expect(hits.length, `${ed.edition} found nothing`).toBeGreaterThan(3);
    }
  });
});

describe("catalog prose reaching a model", () => {
  it("is fenced by the engine's implementation, not a second copy", async () => {
    // DECISIONS.md 5.0/S4. The remaining prose is an adviser-defined or
    // unreadable requirement's own words; a duplicated security boundary
    // drifts from the original, so there must be exactly one.
    const { FENCE_TAG } = await import("@psu-planner/engine");
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "tools.ts"), "utf-8");
    expect(src, "the MCP package hardcodes the fence tag instead of importing it").not.toContain(`"${FENCE_TAG}"`);
    expect(src).toMatch(/fenceCatalogText/);
  });
});
