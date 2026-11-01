/** What we actually send to Supabase.
 *
 * THE GAP THIS CLOSES. The end-to-end test stubbed `globalThis.fetch`
 * and never looked at the request — so a Supabase leg that could not
 * work in production passed every time. GoTrue mints an auth code only
 * when `code_challenge` is present; without one it uses the implicit
 * flow and returns tokens in a URL FRAGMENT, which a server never
 * receives. And its PKCE grant refuses a body carrying only the code:
 * "both auth code and code verifier should be non-empty".
 *
 * Two independent reasons the first version could never have worked,
 * and a stub that asserted nothing about the call hid both.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { type Env } from "../src/worker.js";
import type { KVLike } from "@psu-planner/identity";

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "catalog");

const assets = {
  async fetch(req: Request): Promise<Response> {
    const rel = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ""));
    const file = path.join(CATALOG, rel);
    return fs.existsSync(file) && !fs.statSync(file).isDirectory()
      ? new Response(fs.readFileSync(file, "utf-8"), { status: 200 })
      : new Response("not found", { status: 404 });
  },
};

function memoryKv(): KVLike {
  const store = new Map<string, string>();
  return {
    async get(k, opts) {
      // Cloudflare rejects a cache TTL below 30. A stub that ignores the
      // option certifies a read the real binding throws on.
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

let env: Env;
beforeEach(() => {
  env = {
    CATALOG: assets,
    SUPABASE_JWT_SECRET: "test-secret",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    OAUTH: memoryKv(),
  } as Env;
});

const req = (p: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://mcp.lionsdegree.com${p}`, init), env);

async function startFlow(): Promise<{ to: URL; cookie: string; state: string }> {
  const clientId = ((await (await req("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "c", redirect_uris: ["https://a.example/cb"] }),
  })).json()) as { client_id: string }).client_id;

  const res = await req(
    `/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent("https://a.example/cb")}` +
      `&code_challenge=YWJj&code_challenge_method=S256`,
  );
  const to = new URL(res.headers.get("location")!);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const state = new URL(to.searchParams.get("redirect_to")!).searchParams.get("state")!;
  return { to, cookie, state };
}

describe("the authorize hop", () => {
  it("sends a code challenge, or Supabase mints no code at all", async () => {
    const { to } = await startFlow();
    const challenge = to.searchParams.get("code_challenge");
    expect(challenge, "no code_challenge, so GoTrue falls back to the implicit flow").toBeTruthy();
    expect(challenge!.length).toBeGreaterThan(20);
    expect(to.searchParams.get("code_challenge_method")?.toLowerCase()).toBe("s256");
  });

  it("does not send our verifier upstream, only its hash", async () => {
    // The verifier is the secret. Sending it with the challenge would
    // make PKCE a formality.
    const { to } = await startFlow();
    const challenge = to.searchParams.get("code_challenge")!;
    const raw = to.toString();
    expect(raw).not.toContain("code_verifier");
    expect(challenge).toBeTruthy();
  });

  it("asks for a provider the project actually has configured", async () => {
    const { to } = await startFlow();
    expect(["google", "azure"]).toContain(to.searchParams.get("provider"));
  });
});

describe("the token exchange", () => {
  it("sends BOTH the auth code and the verifier", async () => {
    // GoTrue: "both auth code and code verifier should be non-empty".
    const { cookie, state } = await startFlow();

    let sentTo = "";
    let sentBody: Record<string, unknown> = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sentTo = String(input instanceof Request ? input.url : input);
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({ access_token: "x", expires_in: 3600 });
    }) as typeof fetch;
    try {
      await req(`/callback?state=${encodeURIComponent(state)}&code=supabase-code`, { headers: { cookie } });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(sentTo, "the exchange did not use the pkce grant").toContain("grant_type=pkce");
    expect(sentBody.auth_code, "no auth_code was sent").toBe("supabase-code");
    expect(sentBody.code_verifier, "no code_verifier was sent, so GoTrue refuses the exchange").toBeTruthy();
  });

  it("sends the verifier matching the challenge it sent earlier", async () => {
    // The two halves of one PKCE run have to be the same run. Storing
    // the verifier in the pending record is what keeps them together
    // across the trip to Google.
    const { to, cookie, state } = await startFlow();
    const sentChallenge = to.searchParams.get("code_challenge")!;

    let verifier = "";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      verifier = String(JSON.parse(String(init?.body ?? "{}")).code_verifier ?? "");
      return Response.json({ access_token: "x", expires_in: 3600 });
    }) as typeof fetch;
    try {
      await req(`/callback?state=${encodeURIComponent(state)}&code=c`, { headers: { cookie } });
    } finally {
      globalThis.fetch = realFetch;
    }

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const recomputed = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(recomputed, "the verifier does not match the challenge we sent").toBe(sentChallenge);
  });

  it("carries the anon key, which is how Supabase knows the project", async () => {
    const { cookie, state } = await startFlow();
    let headers: Record<string, string> = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return Response.json({ access_token: "x", expires_in: 3600 });
    }) as typeof fetch;
    try {
      await req(`/callback?state=${encodeURIComponent(state)}&code=c`, { headers: { cookie } });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(headers.apikey, "no apikey header, so Supabase rejects the call").toBeTruthy();
  });
});
