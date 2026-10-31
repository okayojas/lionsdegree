/** The whole flow, end to end.
 *
 * Everything an assistant does between "I have never heard of this
 * server" and "I can ask it about a Course". The only step stubbed is
 * the hop to Supabase, because a human clicking Allow at Google is the
 * one part a test cannot be.
 *
 * Separate from `oauth.test.ts` because these are long and sequential
 * where those are each one refusal; mixing them makes both harder to
 * read when one fails.
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
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
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

const get = (p: string) => worker.fetch(new Request(`https://mcp.lionsdegree.com${p}`), env);
const postForm = (p: string, form: Record<string, string>) =>
  worker.fetch(
    new Request(`https://mcp.lionsdegree.com${p}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    }),
    env,
  );
const postJson = (p: string, body: unknown) =>
  worker.fetch(
    new Request(`https://mcp.lionsdegree.com${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase access token, signed the way the real one is. */
async function supabaseToken(sub: string): Promise<string> {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({
    sub,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "student@psu.edu",
  })}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

const challengeFor = async (verifier: string) =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

/** Register, start the flow, and walk back through the callback with
 * Supabase stubbed. Returns the authorization code the assistant gets. */
async function throughSignIn(verifier: string, sub = "student-42"): Promise<{ clientId: string; code: string; back: URL }> {
  const reg = (await (await postJson("/register", {
    client_name: "Claude",
    redirect_uris: ["https://assistant.example/cb"],
  })).json()) as { client_id: string };

  const authRes = await get(
    `/authorize?response_type=code&client_id=${reg.client_id}` +
      `&redirect_uri=${encodeURIComponent("https://assistant.example/cb")}` +
      `&code_challenge=${await challengeFor(verifier)}&code_challenge_method=S256&state=client-state`,
  );
  expect(authRes.status, "the student was not sent anywhere to sign in").toBe(302);
  const toSupabase = new URL(authRes.headers.get("location")!);
  const ourState = new URL(toSupabase.searchParams.get("redirect_to")!).searchParams.get("state")!;
  expect(ourState, "no state was carried into the Supabase hop").toBeTruthy();

  // Supabase's token endpoint is the one thing stubbed; everything else
  // here is the real code.
  const token = await supabaseToken(sub);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u.includes("project.supabase.co")) {
      return Response.json({ access_token: token, refresh_token: "r", expires_in: 3600 });
    }
    return realFetch(input as RequestInfo);
  }) as typeof fetch;

  let back: URL;
  try {
    const cb = await get(`/callback?state=${encodeURIComponent(ourState)}&code=supabase-code`);
    expect(cb.status, "the callback did not send the student back to their assistant").toBe(302);
    back = new URL(cb.headers.get("location")!);
  } finally {
    globalThis.fetch = realFetch;
  }

  return { clientId: reg.client_id, code: back.searchParams.get("code")!, back };
}

describe("an assistant that has never heard of this server", () => {
  it("registers, signs the student in, and asks a question with the token", async () => {
    const verifier = "a-verifier-at-least-43-characters-long-for-oauth21";
    const { clientId, code, back } = await throughSignIn(verifier);

    expect(back.origin + back.pathname).toBe("https://assistant.example/cb");
    expect(back.searchParams.get("state"), "the client's own state was not returned").toBe("client-state");
    expect(code).toBeTruthy();

    const tokenRes = await postForm("/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: "https://assistant.example/cb",
    });
    expect(tokenRes.status).toBe(200);
    const granted = (await tokenRes.json()) as { access_token: string; token_type: string };
    expect(granted.token_type).toBe("Bearer");

    // THE POINT. The token the flow issued is one the connector accepts.
    const ask = await worker.fetch(
      new Request("https://mcp.lionsdegree.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${granted.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      env,
    );
    expect(ask.status, "the token this flow issued was refused by the connector").toBe(200);
    expect(await ask.text()).toMatch(/search_catalog/);
  });

  it("cannot spend the same code twice", async () => {
    // A code that survives its exchange can be replayed by anyone who
    // saw it — in a browser history, a proxy log, over a shoulder.
    const verifier = "another-verifier-at-least-43-characters-long-abc";
    const { clientId, code } = await throughSignIn(verifier);
    const exchange = () =>
      postForm("/token", {
        grant_type: "authorization_code", code, code_verifier: verifier,
        client_id: clientId, redirect_uri: "https://assistant.example/cb",
      });
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status, "the code was accepted a second time").toBe(400);
  });

  it("cannot exchange a code it did not start the flow for", async () => {
    // THE WHOLE POINT OF PKCE. A code intercepted on its way back
    // through the browser is not enough without the verifier, which
    // never left the assistant.
    const { clientId, code } = await throughSignIn("the-real-verifier-at-least-43-characters-xxx");
    const res = await postForm("/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: "an-attacker-guessing-at-least-43-characters-yyy",
      client_id: clientId,
      redirect_uri: "https://assistant.example/cb",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: string }).error).toBe("invalid_grant");
  });

  it("cannot redirect the code somewhere other than where it was issued", async () => {
    const verifier = "a-fourth-verifier-at-least-43-characters-long-zz";
    const { clientId, code } = await throughSignIn(verifier);
    const res = await postForm("/token", {
      grant_type: "authorization_code", code, code_verifier: verifier,
      client_id: clientId, redirect_uri: "https://attacker.example/cb",
    });
    expect(res.status).toBe(400);
  });

  it("cannot exchange another client's code", async () => {
    const verifier = "a-fifth-verifier-at-least-43-characters-long-qq";
    const { code } = await throughSignIn(verifier);
    const other = (await (await postJson("/register", {
      client_name: "Someone Else", redirect_uris: ["https://assistant.example/cb"],
    })).json()) as { client_id: string };
    const res = await postForm("/token", {
      grant_type: "authorization_code", code, code_verifier: verifier,
      client_id: other.client_id, redirect_uri: "https://assistant.example/cb",
    });
    expect(res.status).toBe(400);
  });
});

describe("when Supabase will not complete the sign-in", () => {
  it("says so in words a student can act on, and issues nothing", async () => {
    const reg = (await (await postJson("/register", {
      client_name: "Claude", redirect_uris: ["https://assistant.example/cb"],
    })).json()) as { client_id: string };
    const authRes = await get(
      `/authorize?response_type=code&client_id=${reg.client_id}` +
        `&redirect_uri=${encodeURIComponent("https://assistant.example/cb")}` +
        `&code_challenge=${await challengeFor("x".repeat(43))}&code_challenge_method=S256`,
    );
    const ourState = new URL(new URL(authRes.headers.get("location")!).searchParams.get("redirect_to")!).searchParams.get("state")!;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("no", { status: 400 })) as typeof fetch;
    try {
      const cb = await get(`/callback?state=${encodeURIComponent(ourState)}&code=whatever`);
      expect(cb.status).toBe(502);
      const text = await cb.text();
      expect(text).toMatch(/start again/i);
      expect(text, "an internal detail reached the student").not.toContain("supabase");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses a callback with a state we never issued", async () => {
    // Someone walking up to /callback directly.
    const res = await get("/callback?state=invented&code=whatever");
    expect(res.status).toBe(400);
  });
});
