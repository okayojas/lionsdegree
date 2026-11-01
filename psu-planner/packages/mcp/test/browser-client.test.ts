/** Whether a BROWSER can talk to this connector.
 *
 * THE BUG THIS EXISTS FOR, and it cost four rounds of deploy-and-retry
 * to find. An MCP client is not always a program on a server: Claude's
 * web app is a web page, so every call it makes is cross-origin and
 * the browser enforces CORS before anything reaches us.
 *
 * The connector had no CORS support at all, and the auth gate ran
 * first — so the preflight came back 401, the browser never sent the
 * real request, and NOTHING appeared in our logs. We added
 * instrumentation to three stages in turn, each time to a stage the
 * request had never reached. The silence was the symptom.
 *
 * Every assertion here is a thing curl cannot notice and a browser
 * cannot work without.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KVLike } from "@psu-planner/identity";
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

function memoryKv(): KVLike {
  const store = new Map<string, string>();
  return {
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

let env: Env;
beforeEach(() => {
  env = {
    CATALOG: assets,
    SUPABASE_JWT_SECRET: "s",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    OAUTH: memoryKv(),
  } as Env;
});

const from = (p: string, init: RequestInit = {}) =>
  worker.fetch(
    new Request(`https://mcp.lionsdegree.com${p}`, {
      ...init,
      headers: { origin: "https://claude.ai", ...(init.headers ?? {}) },
    }),
    env,
  );

describe("the CORS preflight", () => {
  it("IS ANSWERED, rather than refused by the gate", async () => {
    // A preflight carries no credentials — browsers never attach them
    // — so a gate that runs first answers 401 and the real request is
    // never sent. That is not a 401 the client can recover from; it is
    // the connection failing before it begins.
    const res = await from("/mcp", {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    expect(res.status, "the preflight was refused, so no browser can reach this connector").toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("allows the headers an MCP client actually sends", async () => {
    const allowed = (
      (await from("/mcp", { method: "OPTIONS" })).headers.get("access-control-allow-headers") ?? ""
    ).toLowerCase();
    for (const h of ["authorization", "content-type", "accept", "mcp-protocol-version", "mcp-session-id"]) {
      expect(allowed, `a browser may not send ${h}, so the request will be blocked`).toContain(h);
    }
  });

  it("allows the methods the transport uses", async () => {
    const allowed = ((await from("/mcp", { method: "OPTIONS" })).headers.get("access-control-allow-methods") ?? "")
      .toUpperCase();
    for (const m of ["GET", "POST", "DELETE"]) expect(allowed).toContain(m);
  });

  it("is cacheable, so permission is not re-asked before every call", async () => {
    const age = Number((await from("/mcp", { method: "OPTIONS" })).headers.get("access-control-max-age"));
    expect(age).toBeGreaterThan(0);
  });
});

describe("the 401 that tells a client where to sign in", () => {
  it("is readable by a browser at all", async () => {
    const res = await from("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin"), "the browser will discard this response").toBe("*");
  });

  it("EXPOSES WWW-Authenticate, or discovery is invisible", async () => {
    // `WWW-Authenticate` is not on the CORS safelist, so a browser
    // hides it from JavaScript unless it is named in
    // `Access-Control-Expose-Headers`. That header IS the discovery
    // mechanism — it names the resource metadata document. Allowed but
    // unexposed means a client that can reach the 401 and cannot read
    // the one thing the 401 exists to carry.
    const res = await from("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.headers.get("www-authenticate"), "no challenge at all").toMatch(/resource_metadata/);
    expect(
      (res.headers.get("access-control-expose-headers") ?? "").toLowerCase(),
      "the challenge is present but a browser cannot read it",
    ).toContain("www-authenticate");
  });
});

describe("the rest of the sign-in surface", () => {
  it("is reachable from a browser too", async () => {
    // Discovery and registration are browser-side in a web client. A
    // connector whose /mcp allows CORS and whose /register does not is
    // one that gets exactly as far as asking how to sign in.
    for (const p of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
    ]) {
      const res = await from(p);
      expect(res.status, `${p} did not answer`).toBe(200);
      expect(res.headers.get("access-control-allow-origin"), `${p} is not readable cross-origin`).toBe("*");
    }
  });

  it("lets a browser register a client", async () => {
    const pre = await from("/register", {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(pre.status, "registration cannot even be attempted from a browser").toBeLessThan(300);

    const res = await from("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "a browser", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("what allowing every origin does and does not grant", () => {
  it("still refuses an unauthenticated caller", async () => {
    // `*` is safe here precisely because authority comes from the
    // Authorization header and never from a cookie or an origin. If
    // allowing any origin ever started granting access, this fails.
    const res = await from("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status, "an origin header was enough to get in").toBe(401);
  });

  it("never turns on credentials mode, which would make `*` illegal and cookies rideable", async () => {
    const res = await from("/mcp", { method: "OPTIONS" });
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
