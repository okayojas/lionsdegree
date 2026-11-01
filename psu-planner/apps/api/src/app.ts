/** Chat proxy: stateless Hono app (runs on Node for dev, portable to
 * Cloudflare Workers). Holds the OpenAI key server-side, injects the system
 * prompt + tool definitions (clients cannot override them), rate-limits, and
 * streams the completion back as SSE. Tools execute client-side against the
 * student's local plan — this server never sees or stores plan state beyond
 * the messages of the current request. */
import { Hono } from "hono";
import { rateLimit, verifyJwt, type KVLike } from "@psu-planner/identity";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { SYSTEM_PROMPT, TOOL_DEFS } from "./tools.js";

/** Minimal structural type for a Cloudflare KV namespace (avoids the
 * workers-types dependency; Node dev doesn't have KV). `get` takes the same
 * options bag Cloudflare KV does so we can force a fresh read (cacheTtl: 0). */
/* `KVLike` is imported from `@psu-planner/identity`, not declared here.
   The local copy had no `delete`, which is the same drift in miniature
   as the verifier that stopped requiring an expiry. */

export interface Env {
  OPENAI_API_KEY: string;
  /** OpenAI project id (`proj_…`). The monthly spend cap is set PER PROJECT in
   * the OpenAI dashboard, so usage must be attributed to the capped project or
   * the cap never binds. A project-scoped key (`sk-proj-…`) created inside that
   * project already attributes correctly; setting this too is belt-and-braces —
   * a mismatch between key and header errors loudly instead of silently
   * billing the wrong budget. */
  OPENAI_PROJECT?: string;
  OPENAI_MODEL?: string;
  /** Total completion budget (reasoning + output) for the reasoning model. */
  OPENAI_MAX_TOKENS?: string;
  /** minimal | low | medium | high — "minimal" keeps the advising chat fast. */
  OPENAI_REASONING_EFFORT?: string;
  FREE_DAILY_LIMIT?: string;
  /** Bound in production (Cloudflare KV); dev falls back to in-memory. */
  RATE_LIMIT?: KVLike;
  /** "development" relaxes CORS to localhost. Anything else = production. */
  NODE_ENV?: string;
  /** Comma-separated production origins allowed to call the API (S1). */
  ALLOWED_ORIGINS?: string;
  /** Supabase project JWT secret (HS256). When set, a valid `Authorization:
   * Bearer <jwt>` identifies the user and rate-limiting keys on their `sub`. */
  SUPABASE_JWT_SECRET?: string;
  /** When truthy, requests without a verified identity are REJECTED (fail
   * closed — S1). Leave unset until Supabase auth is wired into the client;
   * the API then still applies CORS + Sec-Fetch-Site + IP rate limiting and
   * logs loudly that the identity gate is inactive. */
  REQUIRE_AUTH?: string;
}

interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

function isDev(env: Env): boolean {
  return (env.NODE_ENV ?? "production") === "development";
}

function allowedOrigins(env: Env): string[] {
  if (isDev(env)) return ["http://localhost:5199", "http://localhost:5200", "http://localhost:5173"];
  return (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/* ---- Identity gate (S1) and rate limiter (S2) ----------------------------
 *
 * BOTH LIVE IN `@psu-planner/identity` NOW. They were written here and
 * then copied into the hosted MCP connector, which is how the copy here
 * quietly diverged: it accepted a token with NO `exp` at all
 * (`if (payload.exp && ...)`), so a non-expiring token could not be
 * outlived and could not be revoked by waiting. The connector's copy
 * required one.
 *
 * A second implementation of a security boundary drifts from the first.
 * The project says so about prose fencing (DECISIONS.md 5.0 S4) and it
 * was no less true here — it just took two consumers to show it.
 *
 * The shared version is stricter than what this file had: an expiry is
 * required, `aud` must be "authenticated", anonymous sessions are
 * refused, and `nbf` is honoured.
 */

/** Runtime-validate a single wire message (S3) — don't trust the TS type. */
function cleanMessage(m: unknown): ChatMessage | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  if (o.role !== "user" && o.role !== "assistant" && o.role !== "tool") return null;
  const content = typeof o.content === "string" ? o.content : o.content == null ? null : null;
  const msg: ChatMessage = { role: o.role, content };
  if (typeof o.tool_call_id === "string") msg.tool_call_id = o.tool_call_id;
  // Only forward tool_calls that look like OpenAI tool calls; drop anything else.
  if (Array.isArray(o.tool_calls)) {
    const calls = o.tool_calls.filter(
      (t) => t && typeof t === "object" && typeof (t as { id?: unknown }).id === "string" && (t as { type?: unknown }).type === "function",
    );
    if (calls.length) msg.tool_calls = calls;
  }
  return msg;
}

export function createApp(env: Env) {
  const app = new Hono();
  const origins = allowedOrigins(env);
  const authOn = !!env.SUPABASE_JWT_SECRET;
  const requireAuth = !!env.REQUIRE_AUTH && env.REQUIRE_AUTH !== "0" && env.REQUIRE_AUTH !== "false";
  // Loud startup logging so a misconfigured production is obvious (S2, S1).
  console.log(`[api] rate-limit backend: ${env.RATE_LIMIT ? "cloudflare-kv" : "in-memory-map (dev only — NOT safe in prod)"}`);
  console.log(`[api] identity gate: ${authOn ? (requireAuth ? "REQUIRED (Supabase JWT)" : "optional (verifies JWT when present)") : "INACTIVE — no SUPABASE_JWT_SECRET; falling back to IP rate limiting"}`);
  if (!isDev(env) && origins.length === 0) console.warn("[api] WARNING: no ALLOWED_ORIGINS set in production — cross-origin browser calls will be blocked");
  // The spend cap lives on a project, so unattributed usage means an uncapped bill.
  console.log(`[api] openai project: ${env.OPENAI_PROJECT ?? "UNSET — relying on the key's own project scope; confirm the capped project is the one being billed"}`);

  // S5: real CSP + framing lockdown in code, uniform across the origin
  // regardless of whether Pages applies public/_headers to Function responses.
  app.use("*", secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    xFrameOptions: "DENY",
    crossOriginResourcePolicy: "same-origin",
  }));
  // S1: explicit origin allowlist (no reflection). Same-origin Pages Function
  // calls omit Origin and are unaffected.
  app.use("*", cors({ origin: origins, allowMethods: ["POST", "GET", "OPTIONS"] }));

  app.get("/v1/health", (c) => c.json({ ok: true })); // S13: no model disclosure

  app.post("/v1/chat", async (c) => {
    if (!env.OPENAI_API_KEY) {
      return c.json({ error: "Server is missing OPENAI_API_KEY — set it and restart." }, 500);
    }
    // S1: reject cross-site browser requests defensively.
    const sfs = c.req.header("sec-fetch-site");
    if (sfs && sfs !== "same-origin" && sfs !== "none") {
      return c.json({ error: "cross-site request refused" }, 403);
    }

    // S1: identity gate. Verified JWT sub is the rate-limit key when present;
    // otherwise fall back to the trusted Cloudflare IP. NO x-forwarded-for
    // fallback (S2) — it's client-controlled.
    let identity: string | null = null;
    const auth = c.req.header("authorization");
    if (authOn && auth?.startsWith("Bearer ")) {
      identity = (await verifyJwt(auth.slice(7), { secret: env.SUPABASE_JWT_SECRET }))?.sub ?? null;
    }
    if (!identity) {
      if (requireAuth) return c.json({ error: "Sign in to use the assistant." }, 401); // fail closed
      const ip = c.req.header("cf-connecting-ip");
      identity = ip ? `ip:${ip}` : isDev(env) ? "ip:local-dev" : null;
      if (!identity) return c.json({ error: "Unable to establish a rate-limit identity." }, 400);
    } else {
      identity = `user:${identity}`;
    }

    const limit = parseInt(env.FREE_DAILY_LIMIT ?? "50", 10);
    const rl = await rateLimit(env.RATE_LIMIT, identity, limit);
    if (!rl.ok) {
      return c.json({ error: "Daily message limit reached. Try again tomorrow.", remaining: 0 }, 429);
    }

    // S3: reject oversized bodies BEFORE parsing.
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > 256_000) return c.json({ error: "Request too large" }, 413);

    let body: { messages?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const raw = Array.isArray(body.messages) ? body.messages : [];
    if (raw.length === 0) return c.json({ error: "messages must be a non-empty array" }, 400);
    if (raw.length > 200) return c.json({ error: "conversation too long — start a new chat" }, 400);
    // S3: validate each message shape; drop client system messages and junk.
    const clean = raw.map(cleanMessage).filter((m): m is ChatMessage => m !== null);
    if (clean.length === 0) return c.json({ error: "no valid messages" }, 400);
    if (JSON.stringify(clean).length > 200_000) return c.json({ error: "conversation too large" }, 413);

    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        // Attribute spend to the project the dashboard cap is set on.
        ...(env.OPENAI_PROJECT ? { "openai-project": env.OPENAI_PROJECT } : {}),
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL ?? "gpt-5-mini",
        stream: true,
        // gpt-5-mini is a REASONING model: reasoning tokens count against
        // max_completion_tokens. At 2048 with the default effort, reasoning
        // could consume the whole budget and return EMPTY content ("no
        // response"), and it was slow. "minimal" effort suits a tool-driven
        // advising chat — fast, and it leaves the budget for the actual answer.
        max_completion_tokens: parseInt(env.OPENAI_MAX_TOKENS ?? "8000", 10),
        reasoning_effort: env.OPENAI_REASONING_EFFORT ?? "minimal",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...clean],
        tools: TOOL_DEFS.map((t) => ({ type: "function", function: t })),
        tool_choice: "auto",
      }),
    });

    if (!upstream.ok || !upstream.body) {
      // S8: log the upstream detail server-side, never relay it (it can carry
      // org/project ids and quota state).
      const detail = await upstream.text().catch(() => "");
      console.error(`[api] OpenAI upstream error ${upstream.status}: ${detail.slice(0, 500)}`);
      return c.json({ error: "The assistant is temporarily unavailable." }, 502);
    }

    return new Response(upstream.body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-ratelimit-remaining": String(rl.remaining),
      },
    });
  });

  return app;
}
