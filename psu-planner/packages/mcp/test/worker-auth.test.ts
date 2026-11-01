/** Who may ask the connector anything.
 *
 * #33 shipped it open: anyone with the URL could call the catalog
 * tools. That was deliberate and temporary. This is the gate.
 *
 * Driven through `fetch(Request, Env)` like the rest of the Worker
 * suite — the gate runs before any tool, so it is observable from
 * outside without reaching into anything.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetInMemoryCounters, type KVLike } from "@psu-planner/identity";
import worker, { type Env } from "../src/worker.js";

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "catalog");
const SECRET = "test-jwt-secret";

const assets = {
  async fetch(req: Request): Promise<Response> {
    const rel = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ""));
    const file = path.join(CATALOG, rel);
    if (!file.startsWith(CATALOG) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response("not found", { status: 404 });
    }
    return new Response(fs.readFileSync(file, "utf-8"), { status: 200 });
  },
};

/** A Worker with the gate configured. A FRESH object each time: the
 * catalog cache is keyed by the binding, so sharing one across tests
 * would let an earlier test warm a later one's isolate. */
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

/** The OAUTH binding is part of the gate, not just of the sign-in flow:
 * `isRevoked` fails closed without it, because "we cannot tell whether
 * this was revoked" must not read as "it was not". */
const gated = (over: Partial<Env> = {}): Env =>
  ({ CATALOG: assets, SUPABASE_JWT_SECRET: SECRET, OAUTH: memoryKv(), ...over }) as Env;

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function token(payload: Record<string, unknown>, secret = SECRET): Promise<string> {
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

const valid = (sub = "student-1") => token({ sub, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: "s@psu.edu" });

const ask = (env: Env, auth?: string, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) =>
  worker.fetch(
    new Request("https://mcp.lionsdegree.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
  );

beforeEach(() => resetInMemoryCounters());

describe("an unauthenticated request", () => {
  it("is refused", async () => {
    const res = await ask(gated());
    expect(res.status).toBe(401);
  });

  it("is refused BEFORE any tool runs", async () => {
    // Not merely "the answer is an error" — nothing may be read, and no
    // work may be done, on behalf of someone we cannot name.
    let reads = 0;
    const counting = gated({ CATALOG: { async fetch(r: Request) { reads++; return assets.fetch(r); } } });
    await ask(counting);
    expect(reads, "the catalog was read for an unauthenticated caller").toBe(0);
  });

  it("is told how to authenticate, as the spec requires", async () => {
    // A 401 with no `WWW-Authenticate` leaves a client guessing. MCP
    // clients use this header to find the authorization server.
    const res = await ask(gated());
    const header = res.headers.get("www-authenticate") ?? "";
    expect(header).toMatch(/Bearer/i);
    expect(header, "the 401 does not point at resource metadata").toMatch(/resource_metadata/i);
  });

  it("gets JSON-RPC, not an HTML error page", async () => {
    const body = await (await ask(gated())).json() as Record<string, unknown>;
    expect(body.jsonrpc).toBe("2.0");
    expect((body.error as { message?: string })?.message).toMatch(/sign in|authenticat/i);
  });
});

describe("a token that is not ours", () => {
  it("signed with another secret is refused", async () => {
    const res = await ask(gated(), `Bearer ${await valid().then(() => token({ sub: "x", exp: Math.floor(Date.now() / 1000) + 60 }, "wrong"))}`);
    expect(res.status).toBe(401);
  });

  it("expired is refused", async () => {
    const t = await token({ sub: "student-1", aud: "authenticated", exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await ask(gated(), `Bearer ${t}`)).status).toBe(401);
  });

  it("malformed is refused with an explanation, not a stack trace", async () => {
    for (const junk of ["Bearer not-a-token", "Bearer a.b.c", "Bearer ", "Basic abc", "garbage"]) {
      const res = await ask(gated(), junk);
      expect(res.status, `${junk} was accepted`).toBe(401);
      const text = await res.text();
      expect(text, "a stack trace reached the client").not.toContain(".ts:");
      expect(text).toMatch(/jsonrpc/);
    }
  });

  it("is refused the same way whatever was wrong with it", async () => {
    // One message for every failure. Telling a caller WHICH part of
    // their forgery was wrong is telling them how to iterate.
    const expired = await token({ sub: "s", aud: "authenticated", exp: Math.floor(Date.now() / 1000) - 60 });
    const forged = await token({ sub: "s", exp: Math.floor(Date.now() / 1000) + 60 }, "wrong");
    const a = await (await ask(gated(), `Bearer ${expired}`)).text();
    const b = await (await ask(gated(), `Bearer ${forged}`)).text();
    expect(a).toBe(b);
  });
});

describe("a signed-in student", () => {
  it("gets the catalog tools", async () => {
    const res = await ask(gated(), `Bearer ${await valid()}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/search_catalog/);
  });

  it("can still ask a Course question end to end", async () => {
    const res = await ask(gated(), `Bearer ${await valid()}`, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "get_course_details", arguments: { code: "MATH 141" } },
    });
    const text = await res.text();
    const line = text.split("\n").filter((l) => l.startsWith("data:")).pop()!;
    const d = JSON.parse(JSON.parse(line.slice(5).trim()).result.content[0].text);
    expect(d.title).toBeTruthy();
    expect(d.bulletin_url).toMatch(/^https/);
  });
});

describe("the gate when it is not configured", () => {
  it("refuses everything rather than letting everyone in", async () => {
    // FAIL CLOSED. A deploy that forgot the secret must not silently
    // become the open connector #33 shipped.
    for (const half of [{ CATALOG: assets }, { CATALOG: assets, SUPABASE_JWT_SECRET: SECRET }]) {
      const res = await ask(half as Env, `Bearer ${await valid()}`);
      expect(res.status, "a half-configured deploy did not refuse").toBe(503);
      const text = await res.text();
      expect(text, "the caller was told which piece is missing").not.toContain("SUPABASE_JWT_SECRET");
      expect(text).not.toContain("OAUTH");
    }
  });
});

describe("the rate limit", () => {
  it("refuses a student who has asked too often", async () => {
    const env = gated({ RATE_LIMIT_PER_DAY: "3" });
    const auth = `Bearer ${await valid("heavy-user")}`;
    for (let i = 0; i < 3; i++) expect((await ask(env, auth)).status, `request ${i + 1}`).toBe(200);
    expect((await ask(env, auth)).status, "the fourth request was allowed").toBe(429);
  });

  it("refuses them BEFORE any tool runs", async () => {
    let reads = 0;
    const env = gated({
      RATE_LIMIT_PER_DAY: "1",
      CATALOG: { async fetch(r: Request) { reads++; return assets.fetch(r); } },
    });
    const auth = `Bearer ${await valid("heavy-user")}`;
    await ask(env, auth);
    const before = reads;
    await ask(env, auth); // over the limit
    expect(reads, "the catalog was read for a request that was refused").toBe(before);
  });

  it("keys on the student, never on the network they share", async () => {
    // THE ONE THAT MATTERS FOR A CAMPUS. Two students behind one IP
    // must not spend each other's budget.
    const env = gated({ RATE_LIMIT_PER_DAY: "2" });
    const a = `Bearer ${await valid("student-a")}`;
    const b = `Bearer ${await valid("student-b")}`;
    await ask(env, a);
    await ask(env, a);
    expect((await ask(env, a)).status, "student A should be over").toBe(429);
    expect((await ask(env, b)).status, "student B was refused for A's use").toBe(200);
  });

  it("says when to come back", async () => {
    const env = gated({ RATE_LIMIT_PER_DAY: "1" });
    const auth = `Bearer ${await valid("heavy-user")}`;
    await ask(env, auth);
    const res = await ask(env, auth);
    expect(res.headers.get("retry-after"), "no Retry-After on a 429").toBeTruthy();
  });
});
