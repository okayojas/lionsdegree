/** The hosted connector: MCP over Streamable HTTP, on a Cloudflare Worker.
 *
 * A student pastes one URL into their assistant and can ask about any
 * Penn State Course — no install, no terminal, no plan file. The local
 * stdio server in `server.ts` is unchanged and still the route for
 * questions about a student's own Plan, until sign-in lands (#34).
 *
 * WHY THIS CAN BE A WORKER AT ALL, given a 128 MB isolate:
 *
 *   - the SDK ships a transport built on `Request`/`Response` with no
 *     Node imports, so the protocol framing is the SDK's as it is over
 *     stdio;
 *   - the catalog is read through `CatalogSource`, so the same loader
 *     serves both and the hosted one reads over fetch (#31). Measured
 *     12.5 MB of heap for all 14,615 Courses, against 64 MB for the
 *     combined index this replaced.
 *
 * STATELESS. No session id, so every request stands alone and no state
 * is carried between them. A Worker isolate is not a process a client
 * can be pinned to — the next request may land on a different one, or on
 * a cold one — so a session would be a promise the runtime cannot keep.
 * The tools are reads; there is nothing a session would buy.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadEdition, type EditionCatalog } from "./catalog.js";
import { FetchCatalogSource, type Fetcher } from "./source.js";
import { executeTool, listTools, type ToolContext } from "./tools.js";

export interface Env {
  /** Cloudflare's static-asset binding, serving `catalog/`. */
  CATALOG: Fetcher;
}

/** Parsed Editions, kept for as long as the isolate lives.
 *
 * PER EDITION, and that is the point. A warm isolate reuses the parsed
 * audit index — 12.5 MB and ~50 ms, worth not repeating — and a cold one
 * simply refetches. Two Editions can be resident at once because one
 * isolate serves many students, which is exactly why the search ranking
 * had to stop being engine module state: the second Edition to load used
 * to replace the first's dictionary globally, and Edition A then scored
 * against Edition B's vocabulary (ADR 0001). The ranking now belongs to
 * the EditionCatalog, so two can coexist without touching each other.
 *
 * Keyed by Edition and memoised on the PROMISE, so two requests arriving
 * together on a cold isolate share one load rather than racing to do it
 * twice.
 */
interface Warm {
  /** Which Editions exist. Without caching this, every request re-read
   * `editions.json` to learn WHICH Edition to look up, so a warm isolate
   * still made a round trip per question. One small file, on the path of
   * everything. */
  list: Promise<string[]> | null;
  byEdition: Map<string, Promise<EditionCatalog>>;
}

/** KEYED BY THE BINDING, not module-global.
 *
 * An isolate serves one deployment, so in production this is the same
 * thing — but a cache that outlives its catalog is a cache that can
 * serve the wrong one, and keying it by the binding says that out loud.
 * It also stops the memo leaking between tests, which is how the
 * "catalog is gone" case silently started passing against a catalog that
 * was still warm from the test before it.
 *
 * Weak so a replaced binding is collectable rather than pinned. */
const warm = new WeakMap<object, Warm>();

function cacheFor(env: Env): Warm {
  let w = warm.get(env);
  if (!w) {
    w = { list: null, byEdition: new Map() };
    warm.set(env, w);
  }
  return w;
}

/** Which Edition a catalog-only question is answered against.
 *
 * The newest published, because without a Plan there is no Edition to be
 * pinned to — nobody's requirements are in play, and a prospective
 * student asking what CMPSC 465 requires wants the current Bulletin.
 * Once a Plan is in reach (#35) the Plan's own Edition governs, which is
 * not a default but a rule (ADR 0001). */
async function catalogFor(env: Env): Promise<EditionCatalog> {
  const cache = cacheFor(env);
  const source = new FetchCatalogSource(env.CATALOG);

  cache.list ??= source.editions().catch((e) => {
    cache.list = null;
    throw e;
  });
  const all = await cache.list;
  const edition = all[all.length - 1];
  if (!edition) {
    // Do not remember an empty answer: a deploy that lost its assets
    // would otherwise keep reporting the same thing after they returned.
    cache.list = null;
    throw new Error("this connector has no catalog bundled — the deploy is missing its assets");
  }

  let held = cache.byEdition.get(edition);
  if (!held) {
    held = loadEdition(source, edition);
    cache.byEdition.set(edition, held);
    // A failed load must not be remembered as the answer: drop it so the
    // next request retries rather than serving the same rejection for
    // the life of the isolate.
    held.catch(() => cache.byEdition.delete(edition));
  }
  return held;
}

/** A context with a catalog and no Plan.
 *
 * `executeTool` refuses the Plan-shaped tools by name against this, and
 * `listTools({ catalogOnly: true })` does not advertise them — a model
 * cannot usefully be offered a tool that will always say no. */
function catalogContext(data: EditionCatalog): ToolContext {
  return { plan: null, planPath: "", data, items: [], sched: {} };
}

function mcpServer(data: EditionCatalog): Server {
  const server = new Server({ name: "lionsdegree", version: "0.1.0" }, { capabilities: { tools: {} } });
  const ctx = catalogContext(data);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools({ catalogOnly: true }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await executeTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, ctx);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  return server;
}

/** What a browser sees at the root. Not the protocol endpoint — pasting
 * this host into an address bar is a thing people do, and a bare 404
 * tells them nothing about whether they have the right URL. */
const SIGNPOST =
  "LionsDegree MCP connector.\n\n" +
  "This is a Model Context Protocol endpoint, not a web page. Point your\n" +
  "assistant at /mcp — see https://lionsdegree.com/connect/ for how.\n";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(SIGNPOST, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/health") {
      // Something that fails when the catalog does, not merely when the
      // Worker is running — "the process is up" is the least useful
      // thing a health check can report.
      try {
        const data = await catalogFor(env);
        return Response.json({ ok: true, edition: data.edition, courses: Object.keys(data.catalog).length });
      } catch (e) {
        return Response.json({ ok: false, error: (e as Error).message }, { status: 503 });
      }
    }
    if (url.pathname !== "/mcp") {
      return new Response("not found — the connector is at /mcp", { status: 404 });
    }

    try {
      const data = await catalogFor(env);
      const transport = new WebStandardStreamableHTTPServerTransport({
        // Stateless: see the header. `undefined` is the SDK's way of
        // saying "no session".
        sessionIdGenerator: undefined,
      });
      await mcpServer(data).connect(transport);
      return await transport.handleRequest(request);
    } catch (e) {
      // A JSON-RPC error, never a stack trace. The caller is a protocol
      // client: an HTML error page or a raw throw is something it cannot
      // read, and the student sees their assistant fail silently.
      // `id: null` is what the spec says to send when the request could
      // not be parsed well enough to know its id.
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: `connector error: ${(e as Error).message}` },
        },
        { status: 500 },
      );
    }
  },
};
