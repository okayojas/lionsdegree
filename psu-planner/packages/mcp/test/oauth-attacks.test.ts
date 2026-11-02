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
    // THE ATTACK NO LONGER HAS A HANDLE TO GRAB. `state` used to
    // travel in `redirect_to`, so an attacker could read it out of
    // their own 302 and send a victim a link carrying it. The flow is
    // keyed by the cookie now, so there is nothing in the URL to copy
    // — asserted here, because this is the step the attack starts
    // with.
    const handedToSupabase = new URL(
      new URL(started.headers.get("location")!).searchParams.get("redirect_to")!,
    );
    expect(
      handedToSupabase.search,
      "the redirect carries a query a third party could copy and replay",
    ).toBe("");

    // 3-4. The VICTIM's browser completes it. It has none of the
    //      attacker's cookies, because it is a different browser.
    const token = await victimToken();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ access_token: token, expires_in: 3600 })) as typeof fetch;
    let victimCallback: Response;
    try {
      victimCallback = await req("/callback?code=victims-code");
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
    const token = await victimToken();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ access_token: token, expires_in: 3600 })) as typeof fetch;
    try {
      const done = await req("/callback?code=c", { headers: { cookie } });
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

    const token = await victimToken();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ access_token: token, refresh_token: "a-refresh-token", expires_in: 3600 })) as typeof fetch;
    let code: string;
    try {
      const cb = await req("/callback?code=c", { headers: { cookie } });
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

describe("what a failed sign-in leaves behind", () => {
  /** THE REASON THIS EXISTS. The first report of this connector
   * refusing people was a human saying "it says you started connecting
   * but didn't finish" — and nothing anywhere recorded at which step,
   * because every refusal returns the same deliberately vague message
   * and logged nothing. `console.error` only helps somebody already
   * watching a live tail; a student's failed sign-in does not wait for
   * an audience. */
  const breadcrumbs = async () => {
    const raw = kv.store.get("oauth:recent-failures");
    return raw ? (JSON.parse(raw) as { at: string; stage: string; why: string }[]) : [];
  };

  it("records which step refused", async () => {
    await req("/callback?code=whatever");
    const [last] = await breadcrumbs();
    expect(last, "a refused sign-in left no record at all").toBeTruthy();
    expect(last.stage).toBe("callback");
    expect(last.why).toMatch(/no pending flow/);
    expect(Date.parse(last.at)).not.toBeNaN();
  });

  it("records a refused token exchange too", async () => {
    await req("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "nope", client_id: "x" }).toString(),
    });
    const [last] = await breadcrumbs();
    expect(last?.stage).toBe("token");
    expect(last.why, "the most likely cause is not named").toMatch(/propagated|spent|expired/);
  });

  it("NEVER writes down a credential", async () => {
    // The whole point of a breadcrumb is that it can be read later by
    // whoever is debugging. That is only acceptable while it holds a
    // stage and a shape — never a code, a verifier, or a token.
    const secret = "sup3r-secret-verifier-value";
    await req("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: secret,
        code_verifier: secret,
        client_id: "x",
      }).toString(),
    });
    const written = kv.store.get("oauth:recent-failures") ?? "";
    expect(written, "a credential was written into the failure log").not.toContain(secret);
    expect(written, "the code length is fine; the code is not").toMatch(/code_len=\d+/);
  });

  it("keeps the last few, not an unbounded list", async () => {
    for (let i = 0; i < 14; i++) await req(`/callback?code=c-${i}`);
    expect((await breadcrumbs()).length, "the failure log grows without limit").toBeLessThanOrEqual(10);
  });

  it("puts the newest first, because that is the one being debugged", async () => {
    await req("/callback?code=older");
    await req("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "newer", client_id: "x" }).toString(),
    });
    expect((await breadcrumbs())[0].stage).toBe("token");
  });
});

describe("a sign-in that dies before the callback", () => {
  /** THE BLIND SPOT THIS CLOSES. The first real failure report left no
   * breadcrumb at all, which ruled out /callback and /token and left
   * /authorize — the one stage that recorded nothing. An assistant
   * registers from its own servers and sends the student's browser
   * here seconds later from somewhere else, and KV writes take time to
   * cross regions. */
  const breadcrumbs = async () => {
    const raw = kv.store.get("oauth:recent-failures");
    return raw ? (JSON.parse(raw) as { stage: string; why: string }[]) : [];
  };

  it("records an unknown client, naming propagation as a cause", async () => {
    await req(
      "/authorize?response_type=code&client_id=never-registered" +
        "&redirect_uri=https%3A%2F%2Fa.example%2Fcb&code_challenge=YWJj&code_challenge_method=S256",
    );
    const [last] = await breadcrumbs();
    expect(last?.stage, "the stage that refused was not recorded").toBe("authorize");
    expect(last.why).toMatch(/unknown client/);
    // THE ID ITSELF, because "present=true" is what cost a whole
    // deploy-and-retry round: the only question was whether the id
    // matched anything we issued, and the record could not say.
    expect(last.why, "the breadcrumb does not name the id that was refused").toContain("never-registered");
  });

  it("records a redirect_uri the client never registered", async () => {
    const client = await registerClient("https://assistant.example/cb");
    await req(
      `/authorize?response_type=code&client_id=${client}` +
        "&redirect_uri=https%3A%2F%2Fsomewhere-else.example%2Fcb&code_challenge=YWJj&code_challenge_method=S256",
    );
    const [last] = await breadcrumbs();
    expect(last?.stage).toBe("authorize");
    expect(last.why).toMatch(/not registered/);
  });

  it("records a client that skipped PKCE", async () => {
    const client = await registerClient("https://assistant.example/cb");
    await req(`/authorize?response_type=code&client_id=${client}&redirect_uri=https%3A%2F%2Fassistant.example%2Fcb`);
    const [last] = await breadcrumbs();
    expect(last?.stage).toBe("authorize");
    expect(last.why).toMatch(/PKCE/);
  });

  it("leaves no breadcrumb when the flow starts cleanly", async () => {
    // A log that fills up on success tells you nothing on failure.
    const client = await registerClient("https://assistant.example/cb");
    const res = await req(
      `/authorize?response_type=code&client_id=${client}` +
        "&redirect_uri=https%3A%2F%2Fassistant.example%2Fcb&code_challenge=YWJj&code_challenge_method=S256",
    );
    expect(res.status).toBe(302);
    expect(await breadcrumbs(), "a successful sign-in was recorded as a failure").toHaveLength(0);
  });
});

describe("a client_id that carries its own registration", () => {
  const authorize = (clientId: string, redirect: string) =>
    req(
      `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=YWJj&code_challenge_method=S256`,
    );

  it("WORKS WITH NOTHING IN STORAGE, which is the whole point", async () => {
    // THE FAILURE THIS REPLACES. A real connection attempt died at
    // /authorize with "unknown client" against a registration that
    // provably existed — an assistant registers from its own servers
    // and sends the student's browser here, and anything that makes
    // that second read miss ends the sign-in with a message the
    // student can do nothing about.
    //
    // Emptying the store between the two requests is the strongest
    // available statement that the lookup is gone.
    const client = await registerClient("https://assistant.example/cb");
    kv.store.clear();

    const res = await authorize(client, "https://assistant.example/cb");
    expect(res.status, "/authorize still depends on stored state").toBe(302);
    expect(res.headers.get("location")).toContain("supabase.co");
  });

  it("still honours the redirect URIs it was registered with", async () => {
    const client = await registerClient("https://assistant.example/cb");
    kv.store.clear();
    const res = await authorize(client, "https://somewhere-else.example/cb");
    expect(res.status, "a client_id was accepted for a redirect it never registered").toBe(400);
  });

  it("REFUSES ONE NOBODY SIGNED", async () => {
    // THE RISK THE SIGNATURE EXISTS FOR. Without it, anyone could mint
    // a client_id naming any redirect they like and turn this endpoint
    // into an open redirector for authorization codes — the exact
    // thing PKCE and redirect registration are there to prevent.
    const forged =
      btoa(JSON.stringify({ client_name: "mine", redirect_uris: ["https://attacker.example/cb"] }))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "") + ".not-a-real-signature";

    const res = await authorize(forged, "https://attacker.example/cb");
    expect(res.status, "a forged client_id was accepted").toBe(400);
    expect(res.headers.get("location"), "a code was sent to an unregistered redirect").toBeNull();
  });

  it("refuses one signed with the wrong key", async () => {
    // Same payload, a signature from a different secret. If this
    // passed, the key would not be doing anything.
    const client = await registerClient("https://assistant.example/cb");
    const [payload] = client.split(".");
    const other = `${payload}.YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh`;
    expect((await authorize(other, "https://assistant.example/cb")).status).toBe(400);
  });

  it("still accepts an assistant that registered the old way", async () => {
    // Claude holds one client_id per connector and does not
    // re-register. Dropping the stored lookup would strand every
    // connection made before this change, permanently, with no way for
    // a student to fix it from their side.
    kv.store.set(
      "client:legacy-id-from-before",
      JSON.stringify({
        client_id: "legacy-id-from-before",
        client_name: "an older assistant",
        redirect_uris: ["https://assistant.example/cb"],
      }),
    );
    const res = await authorize("legacy-id-from-before", "https://assistant.example/cb");
    expect(res.status, "existing connections were broken by the change").toBe(302);
  });
});
