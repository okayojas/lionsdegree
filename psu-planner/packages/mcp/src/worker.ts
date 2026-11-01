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
import { rateLimit, verifyJwt, type KVLike, type VerifiedIdentity } from "@psu-planner/identity";
import { loadEdition, type EditionCatalog } from "./catalog.js";
import { FetchCatalogSource, type Fetcher } from "./source.js";
import { handleOAuth, isRevoked, type OAuthEnv } from "./oauth.js";
import { PlanUnopenable, SupabasePlanStore } from "./planStore.js";
import {
  contextFor,
  executeTool,
  HOSTED_TOOLS,
  listTools,
  needsPlan,
  NO_PLAN,
  type ToolContext,
} from "./tools.js";

export interface Env extends OAuthEnv {
  /** Cloudflare's static-asset binding, serving `catalog/`. */
  CATALOG: Fetcher;

  /** Supabase's JWT signing secret. Verifies the student's access token.
   *
   * REQUIRED. Absent, the connector refuses every request rather than
   * serving the open surface #33 shipped — a deploy that forgot a secret
   * must not quietly become a deploy with no gate. */
  SUPABASE_JWT_SECRET?: string;

  /** Where the rate-limit counters live. Without it they are per-isolate
   * and a student gets roughly one budget per isolate, which is loose
   * but never zero. */
  RATE_LIMIT?: KVLike;

  /** Questions per student per day. Generous: this exists to stop one
   * person exhausting the service, not to meter anyone. */
  RATE_LIMIT_PER_DAY?: string;
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

/** Every Edition this deploy carries, oldest first. Memoised with the
 * catalog, so asking costs nothing after the first request. */
async function editionsFor(env: Env): Promise<string[]> {
  const cache = cacheFor(env);
  const source = new FetchCatalogSource(env.CATALOG);
  cache.list ??= source.editions().catch((e) => {
    cache.list = null;
    throw e;
  });
  return cache.list;
}

/** The catalog a question is answered against.
 *
 * `want` is a Plan's own Edition, and when a Plan is in reach it
 * governs — not as a default but as a rule (ADR 0001). Without one there
 * is no Edition to be pinned to: nobody's requirements are in play, and
 * a prospective student asking what CMPSC 465 requires wants the current
 * Bulletin, so the newest published is right. */
async function catalogFor(env: Env, want?: string): Promise<EditionCatalog> {
  const cache = cacheFor(env);
  const source = new FetchCatalogSource(env.CATALOG);

  const all = await editionsFor(env);
  // A Plan's own Edition when it has one (ADR 0001): a student who
  // entered under 2024-2025 is audited against 2024-2025, not against
  // whatever was published since. `loadEdition` is what refuses an
  // Edition this deploy does not carry.
  const edition = want ?? all[all.length - 1];
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
 * Used when the student has none stored, or when their Plan could not
 * be read. `executeTool` refuses the Plan-shaped tools by name against
 * this rather than reaching into null. */
function catalogContext(data: EditionCatalog): ToolContext {
  return { plan: null, planPath: "", store: null, data, items: [], sched: {} };
}

/** The student's Plan, read under THEIR identity, or a reason it is not
 * here.
 *
 * Read lazily — on the first tool call that needs it, not at connect —
 * because most questions are about the Bulletin and a student with no
 * Plan should not pay for a database round trip to ask what CMPSC 465
 * requires.
 *
 * A FAILED READ IS NOT AN ABSENT PLAN. Returning the catalog-only
 * context on an error would answer "what do I still need?" with an
 * audit of nothing, which reads as "nothing" (iron rule 2). The reason
 * travels so the tool can say it. */
async function planContext(
  env: Env,
  accessToken: string,
): Promise<{ ctx: ToolContext } | { unavailable: string }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return { unavailable: "Plan access is not configured on this connector." };
  }
  const store = new SupabasePlanStore({
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    // THE STUDENT'S OWN TOKEN. Row-level security is what refuses a
    // cross-user read; this file never filters by user id, so a policy
    // failure cannot be masked by an application that happened to be
    // correct.
    accessToken,
  });

  try {
    const held = await store.read(await editionsFor(env));
    // NO PLAN IS NOT A FAILURE, and the two must not share a message. A
    // student who has not built one needs to be sent to the planner; a
    // student whose Plan would not load needs to know their assistant is
    // answering from nothing, not to be told they have no degree plan.
    if (!held) return { unavailable: NO_PLAN };

    // The Plan's own Edition governs (ADR 0001), through the same warm
    // per-Edition cache the catalog questions use. `edition` is always
    // set and always servable by this point: the engine's reader pins an
    // unpinned Plan to the oldest Edition and REFUSES one pinned to an
    // Edition we do not carry, which is why neither rule is restated
    // here. Two servers answering "which bulletin governs you?"
    // differently is the bug; one reader is the fix.
    return { ctx: await contextFor(held, await catalogFor(env, held.plan.edition), store) };
  } catch (e) {
    if (e instanceof PlanUnopenable) {
      // Permanent, and the engine already wrote it for a student to
      // read: which bulletin their Plan follows, which ones we have, and
      // why nothing is being reported instead of the wrong thing.
      return { unavailable: e.message };
    }
    // Transient. The reason is logged; what the model gets is what the
    // student can act on. An audit must never be answered from a Plan
    // that failed to load (iron rule 2).
    console.error("[mcp] plan unavailable", e);
    return { unavailable: "Your plan could not be read right now. Please try again in a moment." };
  }
}

/** A tool result on the wire. JSON in a text block is what the protocol
 * carries; said once so three call sites cannot shape it differently. */
const rpcContent = (result: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
});

function mcpServer(env: Env, data: EditionCatalog, accessToken: string): Server {
  const server = new Server({ name: "lionsdegree", version: "0.1.0" }, { capabilities: { tools: {} } });

  // The caller is a signed-in student, so everything is answerable:
  // reads since #35, writes since #36. A write is a compare-and-swap
  // against the revision it was computed from, so the planner tab the
  // student also has open cannot be silently overwritten.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools({ offer: HOSTED_TOOLS }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    // A tool nobody classified is a tool nobody decided to expose. The
    // allowlist is checked here as well as in `listTools`, because a
    // model can name anything it likes.
    if (!HOSTED_TOOLS.has(name)) {
      return rpcContent({ error: `${name} is not a tool this connector offers.` });
    }

    // Catalog questions never touch the database. A database outage must
    // not take prerequisite lookups down with it, and a student with no
    // Plan should not pay a round trip to ask what MATH 141 requires.
    if (!needsPlan(name)) {
      return rpcContent(await executeTool(name, args, catalogContext(data)));
    }

    const got = await planContext(env, accessToken);
    if ("unavailable" in got) return rpcContent({ error: got.unavailable });
    return rpcContent(await executeTool(name, args, got.ctx));
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

/** A JSON-RPC error with the status a protocol client expects.
 *
 * Every refusal below goes through here, so none of them can
 * accidentally answer with HTML, a bare string, or a stack trace — the
 * caller is a program, and a program that cannot parse the refusal
 * reports "the server broke" to a student who would rather hear "sign
 * in". */
function rpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: status === 429 ? -32000 : -32001, message } },
    { status, headers },
  );
}

/** The one thing an unauthenticated caller is told.
 *
 * IDENTICAL for every reason a token can fail — missing, malformed,
 * expired, signed by somebody else. Explaining which part was wrong is
 * explaining how to iterate towards one that works. */
const SIGN_IN = "Sign in to LionsDegree to use this connector. See https://lionsdegree.com/connect/.";

/** Who is asking, or a Response saying why we will not say.
 *
 * Runs BEFORE anything is read or computed. An anonymous request must
 * cost this service nothing. */
/** A verified caller, WITH the token they presented.
 *
 * The raw token travels because the student's Plan is read with it: the
 * access token we issue IS their Supabase session, so handing it to
 * PostgREST is what makes row-level security — rather than a filter in
 * our code — the thing standing between two students' degrees. The
 * claims alone could not do that; a `sub` is something this service
 * could assert about anyone. */
type Caller = VerifiedIdentity & { token: string };

async function identify(request: Request, env: Env, resourceUrl: URL): Promise<Caller | Response> {
  // BOTH, stated at the door. The secret verifies a token; the KV
  // namespace is how a student's revocation is honoured, and
  // `isRevoked` fails closed without it — so a deploy missing KV would
  // otherwise refuse every request with a 401 that reads like the
  // student's fault. Logged loudly, said quietly: the operator needs to
  // know which piece is missing, the caller must not be told anything
  // about our configuration.
  if (!env.SUPABASE_JWT_SECRET || !env.OAUTH) {
    console.error(
      `[mcp] refusing every request — missing ${!env.SUPABASE_JWT_SECRET ? "SUPABASE_JWT_SECRET" : "the OAUTH KV binding"}`,
    );
    return rpcError(503, "This connector is not accepting requests right now.");
  }

  // `WWW-Authenticate` with `resource_metadata` is how an MCP client
  // discovers where to authenticate. A bare 401 leaves it guessing.
  const challenge = {
    "www-authenticate":
      `Bearer realm="LionsDegree", resource_metadata="${new URL("/.well-known/oauth-protected-resource", resourceUrl).toString()}"`,
  };

  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  if (!bearer) return rpcError(401, SIGN_IN, challenge);

  const identity = await verifyJwt(bearer, { secret: env.SUPABASE_JWT_SECRET });
  if (!identity) return rpcError(401, SIGN_IN, challenge);

  // A signature says the token was issued; it cannot say the student
  // still wants it honoured. Checked after the signature so a forged
  // token costs a KV read of nothing.
  if (await isRevoked(env, bearer)) return rpcError(401, SIGN_IN, challenge);

  return { ...identity, token: bearer };
}

/** Questions per student per day, if nothing says otherwise. Generous on
 * purpose: a student working through a degree audit with their
 * assistant asks a lot of questions, and the limit exists to stop one
 * person exhausting the service rather than to ration anybody. */
const DEFAULT_DAILY_LIMIT = 1000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Discovery, registration and the sign-in flow. Before the gate,
    // obviously: these are how a caller GETS a token.
    const auth = await handleOAuth(request, env);
    if (auth) return auth;

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(SIGNPOST, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/health") {
      // Something that fails when the catalog does, not merely when the
      // Worker is running — "the process is up" is the least useful
      // thing a health check can report.
      try {
        const data = await catalogFor(env);

        // WHAT THE TIMER LAST FOUND, alongside the live check. The two
        // answer different questions: this request proves the service
        // is answering NOW, the stored report proves it has been. An
        // outage that started and ended while nobody was watching is
        // invisible to a liveness probe and visible here.
        const last = await lastSelfCheck(env);

        // The Edition and the course count are already stated on the
        // public site, so this adds nothing a reader could not already
        // have — and both are what makes this check mean "the catalog
        // answers" rather than "the process is up".
        return Response.json({
          ok: true,
          edition: data.edition,
          courses: Object.keys(data.catalog).length,
          // `detail` is stripped: it carries an upstream message, which
          // is for the log and not for an anonymous caller
          // (DECISIONS.md 5.0 S5/S8/S13).
          last_self_check: last
            ? { ok: last.ok, at: last.at }
            : "none recorded in the last hour — the scheduled check may not be running",
        });
      } catch (e) {
        // The reason is LOGGED, not returned. An internal message can
        // carry a file layout or a build command, and an anonymous
        // caller has no use for either (DECISIONS.md 5.0 S5/S8/S13:
        // upstream errors logged server-side, replaced with a generic
        // message).
        console.error("[mcp] health check failed", e);
        return Response.json({ ok: false }, { status: 503 });
      }
    }
    if (url.pathname !== "/mcp") {
      return new Response("not found — the connector is at /mcp", { status: 404 });
    }

    // THE GATE, before the catalog is touched. An anonymous or
    // over-budget request must cost this service nothing: no asset read,
    // no parse, no tool.
    const who = await identify(request, env, url);
    if (who instanceof Response) return who;

    const limit = Number(env.RATE_LIMIT_PER_DAY) || DEFAULT_DAILY_LIMIT;
    const budget = await rateLimit(env.RATE_LIMIT, `user:${who.sub}`, limit);
    if (!budget.ok) {
      return rpcError(
        429,
        "You have reached today's limit for this connector. It resets at midnight UTC.",
        { "retry-after": String(budget.resetInSeconds) },
      );
    }

    try {
      const data = await catalogFor(env);
      const transport = new WebStandardStreamableHTTPServerTransport({
        // Stateless: see the header. `undefined` is the SDK's way of
        // saying "no session".
        sessionIdGenerator: undefined,
      });
      await mcpServer(env, data, who.token).connect(transport);
      return await transport.handleRequest(request);
    } catch (e) {
      // A JSON-RPC error, never a stack trace. The caller is a protocol
      // client: an HTML error page or a raw throw is something it cannot
      // read, and the student just sees their assistant fail silently.
      // `id: null` is what the spec says to send when the request could
      // not be parsed well enough to know its id.
      //
      // GENERIC. The detail goes to the log, not to an unauthenticated
      // caller — an internal message here would carry our file layout
      // and a build command. What the model gets back is enough to tell
      // the student something useful and nothing else.
      console.error("[mcp] request failed", e);
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "The LionsDegree connector could not answer that. Try again shortly." },
        },
        { status: 500 },
      );
    }
  },

  /** A SELF-CHECK ON A TIMER, so the first person to notice the
   * connector is broken is not a student mid-question.
   *
   * It does the thing the connector does — reads the catalog and
   * answers a real Course question — rather than returning 200 to prove
   * the isolate booted. Every outage this service has had so far was a
   * dependency refusing something ("expiration_ttl must be at least
   * 60", "cache_ttl must be at least 30"): the process was fine and the
   * answers were not, which is exactly what a liveness ping cannot see.
   *
   * The result is both LOGGED at error level, where Cloudflare's alert
   * on Worker errors can reach a human, and recorded in KV so /health
   * can say when the last check ran and what it found. An outage that
   * started while nobody was looking should still be discoverable
   * afterwards. */
  async scheduled(_event: unknown, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const run = selfCheck(env);
    ctx?.waitUntil(run);
    await run;
  },
};

/** Where the last self-check is kept. Short-lived: a report older than
 * this is not evidence that anything is working, and `/health` says so
 * rather than showing a stale green. */
const HEALTH_KEY = "health:last";
const HEALTH_TTL = 3600;

export interface HealthReport {
  ok: boolean;
  at: string;
  /** What failed, for the operator. Never returned to a caller. */
  detail?: string;
  edition?: string;
  courses?: number;
}

async function selfCheck(env: Env): Promise<HealthReport> {
  const at = new Date().toISOString();
  let report: HealthReport;
  try {
    const data = await catalogFor(env);
    // A REAL ANSWER, not a count. The catalog can load and still answer
    // nothing — the subject files are fetched lazily, and the bug that
    // shipped in #31 was exactly this: 0 of 367 subjects resolved while
    // the index loaded perfectly.
    const result = (await executeTool(
      "get_course_details",
      { code: SELF_CHECK_COURSE },
      catalogContext(data),
    )) as { title?: string; error?: string };

    if (!result?.title) {
      throw new Error(`the connector could not answer for ${SELF_CHECK_COURSE}: ${result?.error ?? "no title"}`);
    }
    report = { ok: true, at, edition: data.edition, courses: Object.keys(data.catalog).length };
  } catch (e) {
    // LOUD, because this is the whole point of the check. Cloudflare's
    // alerting watches for exactly this.
    console.error("[mcp] SELF-CHECK FAILED — the connector is not answering", e);
    report = { ok: false, at, detail: (e as Error).message };
  }

  try {
    await env.OAUTH?.put(HEALTH_KEY, JSON.stringify(report), { expirationTtl: HEALTH_TTL });
  } catch (e) {
    // The check itself must not fail because its bookkeeping did.
    console.error("[mcp] could not record the self-check result", e);
  }
  return report;
}

async function lastSelfCheck(env: Env): Promise<HealthReport | null> {
  try {
    const raw = await env.OAUTH?.get(HEALTH_KEY, { cacheTtl: 60 });
    return raw ? (JSON.parse(raw) as HealthReport) : null;
  } catch (e) {
    // Never let the bookkeeping take down the check it reports on.
    console.error("[mcp] could not read the last self-check", e);
    return null;
  }
}

/** A Course that has existed in every Edition and has prerequisites, so
 * a self-check that passes means the catalog answered rather than
 * merely loaded. */
const SELF_CHECK_COURSE = "MATH 141";
