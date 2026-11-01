/** Attacks on the sign-in flow.
 *
 * Found by a security review of #34, and the first one is an account
 * takeover: an attacker who never touches the student's device ends up
 * holding the student's token. Every case here failed when it was
 * written.
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

function memoryKv(): KVLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
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
        throw new Error(`Invalid expiration_ttl of ${opts.expirationTtl}. Must be at least 60.`);
      }
      store.set(k, v);
    },
    async delete(k) { store.delete(k); },
  };
}

let kv: ReturnType<typeof memoryKv>;
let env: Env;
beforeEach(() => {
  kv = memoryKv();
  env = {
    CATALOG: assets,
    SUPABASE_JWT_SECRET: "test-secret",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    OAUTH: kv,
  } as Env;
});

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function victimToken(): Promise<string> {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({
    sub: "the-victim", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

const req = (p: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://mcp.lionsdegree.com${p}`, init), env);

const registerClient = async (redirect: string) =>
  ((await (await req("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "c", redirect_uris: [redirect] }),
  })).json()) as { client_id: string }).client_id;

describe("authorization code injection", () => {
  /** THE ACCOUNT TAKEOVER.
   *
   * `state` is minted by us and was used only as a KV lookup key, with
   * nothing tying the pending flow to the browser that started it. So:
   *
   *   1. the attacker starts a flow with THEIR client and redirect, and
   *      reads `state` out of the 302 they get back;
   *   2. they send the victim a Supabase sign-in link whose `redirect_to`
   *      carries that same `state`;
   *   3. the victim signs in — at Google, on their own machine, with
   *      nothing visibly wrong;
   *   4. our /callback exchanges the VICTIM's code and sends the
   *      resulting authorization code to the ATTACKER's redirect;
   *   5. the attacker spends it with their own PKCE verifier and holds
   *      the victim's token.
   *
   * The attacker never touches the victim's device. The fix is a cookie
   * set when the flow starts: the browser that finishes must be the
   * browser that began.
   */
  it("cannot hand a victim's sign-in to an attacker's client", async () => {
    const attackerClient = await registerClient("https://attacker.example/cb");

    // 1-2. The attacker starts the flow and takes the state.
    const started = await req(
      `/authorize?response_type=code&client_id=${attackerClient}` +
        `&redirect_uri=${encodeURIComponent("https://attacker.example/cb")}` +
        `&code_challenge=YWJj&code_challenge_method=S256`,
    );
    const state = new URL(new URL(started.headers.get("location")!).searchParams.get("redirect_to")!)
      .searchParams.get("state")!;
    expect(state).toBeTruthy();

    // 3-4. The VICTIM's browser completes it. It has none of the
    //      attacker's cookies, because it is a different browser.
    const token = await victimToken();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ access_token: token, expires_in: 3600 })) as typeof fetch;
    let victimCallback: Response;
    try {
      victimCallback = await req(`/callback?state=${encodeURIComponent(state)}&code=victims-code`);
    } finally {
      globalThis.fetch = realFetch;
    }

    // THE ASSERTION. Nothing may be sent to the attacker.
    expect(
      victimCallback.status,
      "the victim's sign-in was completed into a flow they did not start",
    ).not.toBe(302);
    const location = victimCallback.headers.get("location") ?? "";
    expect(location, "a code was delivered to the attacker").not.toContain("attacker.example");
  });

  it("completes normally for the browser that started it", async () => {
    // The fix must not break the ordinary case: same browser, cookie
    // carried back, flow finishes.
    const client = await registerClient("https://assistant.example/cb");
    const started = await req(
      `/authorize?response_type=code&client_id=${client}` +
        `&redirect_uri=${encodeURIComponent("https://assistant.example/cb")}` +
        `&code_challenge=YWJj&code_challenge_method=S256`,
    );
    const setCookie = started.headers.get("set-cookie");
    expect(setCookie, "no cookie was set to bind the flow to this browser").toBeTruthy();
    const cookie = setCookie!.split(";")[0];
    const state = new URL(new URL(started.headers.get("location")!).searchParams.get("redirect_to")!)
      .searchParams.get("state")!;

    const token = await victimToken();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ access_token: token, expires_in: 3600 })) as typeof fetch;
    try {
      const done = await req(`/callback?state=${encodeURIComponent(state)}&code=c`, { headers: { cookie } });
      expect(done.status, "the browser that started the flow could not finish it").toBe(302);
      expect(done.headers.get("location")).toContain("assistant.example");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("sets that cookie so a script cannot read it and a third party cannot send it", async () => {
    const client = await registerClient("https://assistant.example/cb");
    const started = await req(
      `/authorize?response_type=code&client_id=${client}` +
        `&redirect_uri=${encodeURIComponent("https://assistant.example/cb")}` +
        `&code_challenge=YWJj&code_challenge_method=S256`,
    );
    const c = (started.headers.get("set-cookie") ?? "").toLowerCase();
    expect(c, "readable by script").toContain("httponly");
    expect(c, "sent over plain http").toContain("secure");
    // `Lax`, not `None`: the cookie must come back on the top-level
    // redirect from Supabase, and on nothing a third-party page does.
    expect(c).toMatch(/samesite=lax/);
  });
});

describe("filling our storage for free", () => {
  /** Every OAuth route writes to KV and runs BEFORE the gate — it has
   * to, since they are how a caller gets a token. That makes them the
   * one unauthenticated write path in the service, and an unmetered
   * write path is somebody else's bill. */
  const flood = async (p: string, init: RequestInit, n: number) => {
    const seen: number[] = [];
    for (let i = 0; i < n; i++) seen.push((await req(p, init)).status);
    return seen;
  };

  it("stops an unauthenticated flood of registrations", async () => {
    const statuses = await flood(
      "/register",
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({ client_name: "x", redirect_uris: ["https://a.example/cb"] }),
      },
      40,
    );
    expect(statuses.includes(429), "forty registrations from one address were all accepted").toBe(true);
  });

  it("stops an unauthenticated flood of revocations", async () => {
    // The nastiest of the three: the key is whatever the caller sends,
    // so every request writes a NEW entry that lives for 25 hours.
    const statuses = await flood(
      "/revoke",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9" },
        body: "token=anything-different-each-time",
      },
      40,
    );
    expect(statuses.includes(429), "forty revocations from one address were all accepted").toBe(true);
  });

  it("still lets a normal client register", async () => {
    const res = await req("/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.4" },
      body: JSON.stringify({ client_name: "normal", redirect_uris: ["https://a.example/cb"] }),
    });
    expect(res.status).toBe(201);
  });
});

describe("what a revoked connection can still do", () => {
  it("cannot mint itself a fresh token", async () => {
    // A refresh token outlives the access token the denylist holds, so
    // handing one out made revocation advisory: the holder exchanges it
    // with Supabase directly and comes back with something we have
    // never seen. We do not issue them.
    const client = await registerClient("https://assistant.example/cb");
    const started = await req(
      `/authorize?response_type=code&client_id=${client}` +
        `&redirect_uri=${encodeURIComponent("https://assistant.example/cb")}` +
        `&code_challenge=${b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("v".repeat(43)))))}` +
        `&code_challenge_method=S256`,
    );
    const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0];
    const state = new URL(new URL(started.headers.get("location")!).searchParams.get("redirect_to")!)
      .searchParams.get("state")!;

    const token = await victimToken();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ access_token: token, refresh_token: "a-refresh-token", expires_in: 3600 })) as typeof fetch;
    let code: string;
    try {
      const cb = await req(`/callback?state=${encodeURIComponent(state)}&code=c`, { headers: { cookie } });
      code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
    } finally {
      globalThis.fetch = realFetch;
    }

    const granted = await (await req("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, code_verifier: "v".repeat(43),
        client_id: client, redirect_uri: "https://assistant.example/cb",
      }).toString(),
    })).json() as { access_token?: string; refresh_token?: string };

    expect(granted.access_token).toBeTruthy();
    expect(granted.refresh_token, "a refresh token was issued, so revocation is only advisory").toBeUndefined();
  });
});
