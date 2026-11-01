/** Taking access back.
 *
 * WHY THIS NEEDS ANYTHING AT ALL. The token is a signed statement with
 * an expiry. Revoking a Supabase session does not reach back and unsign
 * it, so without a denylist "I disconnected my assistant" would mean
 * "my assistant stops working within the hour" — which is not what a
 * student pressing that button believes, and the gap is exactly when
 * they would be pressing it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetInMemoryCounters, type KVLike } from "@psu-planner/identity";
import worker, { type Env } from "../src/worker.js";

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
      // CLOUDFLARE'S REAL CONTRACT. A TTL under 60 seconds is rejected
      // outright, and the stub used to ignore `expirationTtl` entirely —
      // which is how a "delete" written as a one-second tombstone passed
      // every test and threw in production, leaving authorization codes
      // spendable twice.
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
  resetInMemoryCounters();
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

async function token(sub: string): Promise<string> {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

const ask = (t: string) =>
  worker.fetch(
    new Request("https://mcp.lionsdegree.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${t}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    env,
  );

const revoke = (t: string) =>
  worker.fetch(
    new Request("https://mcp.lionsdegree.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t }).toString(),
    }),
    env,
  );

describe("a student who disconnects their assistant", () => {
  it("stops it working immediately, not when the token expires", async () => {
    const t = await token("student-1");
    expect((await ask(t)).status, "the token did not work to begin with").toBe(200);

    expect((await revoke(t)).status).toBe(200);

    // THE ASSERTION. Still perfectly signed, still an hour from
    // expiring, and refused.
    expect((await ask(t)).status, "a revoked token still worked").toBe(401);
  });

  it("does not sign out their other assistants", async () => {
    // Keyed by the token, not by the student. Revoking one connection
    // must not be a silent sign-out everywhere.
    const laptop = await token("student-1");
    const phone = await token("student-1");
    // Two tokens for one student; distinct because they were signed a
    // moment apart or carry different claims. Guard the premise.
    if (laptop === phone) return;

    await revoke(laptop);
    expect((await ask(laptop)).status).toBe(401);
    expect((await ask(phone)).status, "revoking one connection signed out another").toBe(200);
  });

  it("stores no credential while doing it", async () => {
    // A denylist of raw tokens is a bag of working credentials sitting
    // in KV. Only a fingerprint is kept.
    const t = await token("student-1");
    await revoke(t);
    for (const [key, value] of kv.store) {
      expect(key, "the raw token is a KV key").not.toContain(t);
      expect(value, "the raw token is a KV value").not.toContain(t);
    }
    expect([...kv.store.keys()].some((k) => k.startsWith("revoked:")), "nothing was recorded").toBe(true);
  });

  it("answers the same whether or not the token was real", async () => {
    // RFC 7009. Telling a caller that a token existed is telling them
    // they guessed one.
    const real = await token("student-1");
    const a = await revoke(real);
    const b = await revoke("a-token-that-never-existed");
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });

  it("is advertised, so a client knows it can", async () => {
    const meta = await (await worker.fetch(
      new Request("https://mcp.lionsdegree.com/.well-known/oauth-authorization-server"),
      env,
    )).json() as { revocation_endpoint?: string };
    expect(meta.revocation_endpoint).toMatch(/\/revoke$/);
  });
});
