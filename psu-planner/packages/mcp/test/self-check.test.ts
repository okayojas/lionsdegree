/** Noticing the connector is broken before a student does.
 *
 * THE FAILURES THIS SERVICE HAS ACTUALLY HAD were not outages. The
 * process was up and serving; a dependency was refusing something —
 * "expiration_ttl must be at least 60", "cache_ttl must be at least
 * 30", 0 of 367 subject files resolving on a case-sensitive
 * filesystem. A liveness ping would have returned 200 through every one
 * of them.
 *
 * So the check answers a real question about a real Course, and these
 * tests are mostly about it being hard to pass while broken.
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

function memoryKv(): KVLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(k, opts) {
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
  env = { CATALOG: assets, SUPABASE_JWT_SECRET: "s", OAUTH: kv } as Env;
});

const recorded = () => {
  const raw = kv.store.get("health:last");
  return raw ? (JSON.parse(raw) as { ok: boolean; at: string; detail?: string }) : null;
};

const health = async (e: Env = env) =>
  (await (await worker.fetch(new Request("https://mcp.lionsdegree.com/health"), e)).json()) as Record<
    string,
    unknown
  >;

describe("the scheduled self-check", () => {
  it("passes when the connector can actually answer", async () => {
    await worker.scheduled({}, env);
    expect(recorded()?.ok, "a working connector reported itself broken").toBe(true);
  });

  it("records WHEN it ran, so a stale green is visible as stale", async () => {
    await worker.scheduled({}, env);
    expect(Date.parse(recorded()!.at), "the report carries no usable timestamp").not.toBeNaN();
  });

  it("fails when the catalog is gone", async () => {
    const gone = { ...env, CATALOG: { async fetch() { return new Response("no", { status: 404 }); } } } as Env;
    await worker.scheduled({}, gone);
    expect(recorded()?.ok, "a connector with no catalog reported itself healthy").toBe(false);
    expect(recorded()?.detail, "nothing was recorded about why").toBeTruthy();
  });

  it("FAILS WHEN THE CATALOG LOADS FINE BUT THE ANSWER IS WRONG", async () => {
    // THE CASE A LIVENESS PING CANNOT SEE, and the shape of the one
    // that actually happened here: in #31 the index loaded perfectly
    // and 0 of 367 subject lookups resolved, because the paths were
    // built with the wrong case — on Linux, which is where this runs.
    // Everything was "up" and every lookup missed.
    //
    // Modelled by a catalog that loads completely and simply does not
    // contain the Course being asked about. The first version of this
    // test blocked the subject index instead, which makes `loadEdition`
    // throw — so it passed with the answer check REMOVED, proving
    // nothing about the thing it was named for.
    // Both doors to MATH 141 are shut — the audit index and the MATH
    // subject file — while every file `loadEdition` requires still
    // loads. The catalog comes up with hundreds of courses in it and
    // the one being asked about is not reachable by either route.
    const missing = {
      ...env,
      CATALOG: {
        async fetch(req: Request) {
          const p = new URL(req.url).pathname;
          if (/courses\/math\.json$/i.test(p)) return new Response("not found", { status: 404 });
          const res = await assets.fetch(req);
          if (!p.endsWith("audit-index.json") || !res.ok) return res;
          const index = JSON.parse(await res.text()) as { courses: { code?: string }[] };
          index.courses = index.courses.filter((c) => c.code !== "MATH 141");
          return new Response(JSON.stringify(index), { status: 200 });
        },
      },
    } as Env;

    await worker.scheduled({}, missing);
    expect(recorded()?.ok, "a catalog that cannot answer reported itself healthy").toBe(false);
    expect(recorded()?.detail, "nothing was recorded about what could not be answered").toMatch(/MATH 141/);
  });

  it("does not throw when it fails, because a thrown cron is a silent cron", async () => {
    const broken = { ...env, CATALOG: { async fetch() { throw new Error("boom"); } } } as Env;
    await expect(worker.scheduled({}, broken)).resolves.toBeUndefined();
    expect(recorded()?.ok).toBe(false);
  });

  it("still reports when it cannot write its own result down", async () => {
    // The bookkeeping must not be able to take down the check. A KV
    // write failing is not the connector failing.
    const noKv = {
      ...env,
      OAUTH: { ...kv, async put() { throw new Error("KV is unavailable"); } },
    } as unknown as Env;
    await expect(worker.scheduled({}, noKv)).resolves.toBeUndefined();
  });
});

describe("what /health says about it", () => {
  it("reports the last check once one has run", async () => {
    await worker.scheduled({}, env);
    const body = await health();
    expect((body.last_self_check as { ok?: boolean })?.ok).toBe(true);
  });

  it("says plainly when no check has run, rather than showing a reassuring blank", async () => {
    // An absent report is not a passing one. If the cron is not firing
    // at all — never configured, or disabled on a redeploy — that is
    // itself the thing to notice.
    const body = await health();
    expect(String(body.last_self_check), "an unmonitored connector looked monitored").toMatch(
      /none recorded|may not be running/i,
    );
  });

  it("never hands the failure detail to an anonymous caller", async () => {
    // The reason is for the operator. An upstream message can carry a
    // file layout or a build command (DECISIONS.md 5.0 S5/S8/S13), and
    // /health takes no authentication.
    const gone = { ...env, CATALOG: { async fetch() { return new Response("no", { status: 404 }); } } } as Env;
    await worker.scheduled({}, gone);
    // A later request on a working deploy still must not echo it.
    const body = JSON.stringify(await health());
    expect(body, "the failure detail reached an anonymous caller").not.toMatch(/sync-catalog|audit-index|\.ts:/);
  });
});
