/** The authorization flow an assistant walks before it may ask anything.
 *
 * WHY WE RUN ONE AT ALL. MCP clients expect OAuth 2.1 with dynamic
 * client registration: the assistant has never heard of us, registers
 * itself, sends the student to a page they recognise, and comes back
 * with a token. Supabase is not that — it is an authorization server
 * for OUR app, with no DCR and no third-party clients — so the
 * connector is the authorization server and Supabase is where the
 * student actually proves who they are, through the Google and
 * Microsoft providers already configured there. No new credential.
 *
 * Driven as `fetch(Request, Env)`, like the rest. The one step these
 * cannot cover is a human clicking "allow" at Google; everything up to
 * and after that is here.
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

/** KV as a Map, so the real storage path is exercised. */
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
  kv = memoryKv();
  env = {
    CATALOG: assets,
    SUPABASE_JWT_SECRET: "test-secret",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    OAUTH: kv,
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

describe("discovery", () => {
  it("tells a client where to authenticate", async () => {
    // The document a 401's `WWW-Authenticate` points at. Without it an
    // assistant knows it needs a token and nothing about how to get one.
    const res = await get("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    const meta = await res.json() as { resource?: string; authorization_servers?: string[] };
    expect(meta.resource).toMatch(/\/mcp$/);
    expect(meta.authorization_servers?.[0]).toMatch(/^https:\/\//);
  });

  it("describes the authorization server it runs", async () => {
    const res = await get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const m = await res.json() as Record<string, unknown>;
    expect(m.issuer).toMatch(/^https:\/\//);
    expect(m.authorization_endpoint).toMatch(/\/authorize$/);
    expect(m.token_endpoint).toMatch(/\/token$/);
    expect(m.registration_endpoint, "no DCR endpoint, so a new client cannot register").toMatch(/\/register$/);
  });

  it("serves both documents where the SPEC puts them, not only where our header points", async () => {
    // THE GAP THAT MADE A CLIENT UNABLE TO CONNECT AT ALL, with nothing
    // in our logs to show for it.
    //
    // RFC 9728 §3.1 and RFC 8414 §3.1 build the metadata URL by
    // INSERTING `/.well-known/<name>` between the host and the
    // resource's own path. For a resource at `https://host/mcp` the
    // canonical document is at `/.well-known/oauth-protected-resource/mcp`
    // — and we matched the bare path with `===`, so that 404'd.
    //
    // It worked for as long as every client followed the
    // `resource_metadata` parameter in our 401, which names the bare
    // URL. One that derives the canonical path-aware URL instead, which
    // the MCP authorization spec tells it to, found nothing and could
    // not discover the authorization server.
    //
    // A 404 on a well-known path is not an error anybody logs, which is
    // why this looked like silence rather than a failure.
    for (const base of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      const bare = await get(base);
      const pathAware = await get(`${base}/mcp`);
      expect(bare.status, `${base} is not served`).toBe(200);
      expect(pathAware.status, `${base}/mcp is not served — the canonical location for a resource at /mcp`).toBe(200);
      // The same document either way: there is one resource here and one
      // authorization server, so a client must not get a different
      // answer depending on which spelling it tried.
      expect(await pathAware.json(), `${base} answers differently at its path-aware URL`).toEqual(await bare.json());
    }
  });

  it("does not answer for a well-known name it does not implement", async () => {
    // The suffix match must not turn into "any /.well-known/* is ours".
    // Claiming to be an OpenID provider we are not would send a client
    // down a flow nothing here can complete.
    for (const p of ["/.well-known/openid-configuration", "/.well-known/oauth-protected-resourceX", "/.well-known/"]) {
      expect((await get(p)).status, `${p} was answered by the OAuth router`).not.toBe(200);
    }
  });

  it("advertises PKCE, and only S256", async () => {
    // OAuth 2.1 requires PKCE. `plain` is not a challenge, it is the
    // verifier sent twice.
    const m = await (await get("/.well-known/oauth-authorization-server")).json() as {
      code_challenge_methods_supported?: string[];
    };
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
  });
});

describe("dynamic client registration", () => {
  it("issues a client id to an assistant that has never been here", async () => {
    const res = await postJson("/register", {
      client_name: "Some Assistant",
      redirect_uris: ["https://assistant.example/callback"],
    });
    expect(res.status).toBe(201);
    const reg = await res.json() as { client_id?: string; client_secret?: string };
    expect(reg.client_id).toBeTruthy();
    // A public client: an assistant cannot keep a secret, and issuing
    // one that cannot be protected invites it being treated as if it
    // could be.
    expect(reg.client_secret, "a secret was issued to a public client").toBeUndefined();
  });

  it("refuses a registration with no redirect", async () => {
    const res = await postJson("/register", { client_name: "No Redirect" });
    expect(res.status).toBe(400);
  });

  it("refuses a non-https redirect", async () => {
    // Where the authorization code is delivered. Over http it is
    // delivered to whoever is listening.
    const res = await postJson("/register", {
      client_name: "Insecure",
      redirect_uris: ["http://assistant.example/callback"],
    });
    expect(res.status).toBe(400);
  });

  it("allows http on loopback, which is how a desktop assistant works", async () => {
    const res = await postJson("/register", {
      client_name: "Desktop",
      redirect_uris: ["http://127.0.0.1:33418/callback"],
    });
    expect(res.status).toBe(201);
  });
});

describe("authorization", () => {
  const register = async () =>
    ((await (await postJson("/register", {
      client_name: "A", redirect_uris: ["https://assistant.example/cb"],
    })).json()) as { client_id: string }).client_id;

  it("sends the student to Supabase, not somewhere we invented", async () => {
    const client_id = await register();
    const res = await get(
      `/authorize?response_type=code&client_id=${client_id}` +
        `&redirect_uri=${encodeURIComponent("https://assistant.example/cb")}` +
        `&code_challenge=abc&code_challenge_method=S256&state=xyz`,
    );
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin, "the student was not sent to Supabase").toBe("https://project.supabase.co");
    expect(to.pathname).toMatch(/authorize/);
  });

  it("refuses a redirect the client did not register", async () => {
    // THE ATTACK. Anyone can call /authorize with someone else's
    // client_id; if the redirect is not checked against what that client
    // registered, the code is delivered to the attacker.
    const client_id = await register();
    const res = await get(
      `/authorize?response_type=code&client_id=${client_id}` +
        `&redirect_uri=${encodeURIComponent("https://attacker.example/cb")}` +
        `&code_challenge=abc&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    // And it must NOT redirect there to say so.
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses an unknown client", async () => {
    const res = await get(
      `/authorize?response_type=code&client_id=never-registered` +
        `&redirect_uri=${encodeURIComponent("https://assistant.example/cb")}&code_challenge=abc&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
  });

  it("requires PKCE", async () => {
    const client_id = await register();
    const res = await get(
      `/authorize?response_type=code&client_id=${client_id}` +
        `&redirect_uri=${encodeURIComponent("https://assistant.example/cb")}`,
    );
    expect(res.status).toBe(400);
  });

  it("refuses plain PKCE", async () => {
    const client_id = await register();
    const res = await get(
      `/authorize?response_type=code&client_id=${client_id}` +
        `&redirect_uri=${encodeURIComponent("https://assistant.example/cb")}` +
        `&code_challenge=abc&code_challenge_method=plain`,
    );
    expect(res.status).toBe(400);
  });
});

describe("the token endpoint", () => {
  it("refuses a code it never issued", async () => {
    const res = await postForm("/token", {
      grant_type: "authorization_code",
      code: "made-up",
      code_verifier: "whatever",
      client_id: "whoever",
      redirect_uri: "https://assistant.example/cb",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: string }).error).toBe("invalid_grant");
  });

  it("refuses a grant type we do not support", async () => {
    const res = await postForm("/token", { grant_type: "password", username: "a", password: "b" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: string }).error).toBe("unsupported_grant_type");
  });
});

describe("when the connector is not configured for OAuth", () => {
  it("says so rather than half-running a flow", async () => {
    // No KV, no Supabase URL: the operator has not finished setting up.
    // Better to refuse at the door than to issue codes nothing can
    // exchange.
    const bare = { CATALOG: assets, SUPABASE_JWT_SECRET: "x" } as Env;
    const res = await worker.fetch(
      new Request("https://mcp.lionsdegree.com/.well-known/oauth-authorization-server"),
      bare,
    );
    expect(res.status).toBe(503);
  });
});
