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

/** Cloudflare's asset binding, modelled CASE-SENSITIVELY.
 *
 * `fs.existsSync` is case-insensitive on Windows and macOS, which is
 * where this is written, and case-sensitive on Linux, which is where it
 * runs. The bug this whole check exists to catch was exactly that — 0
 * of 367 subject files resolving in production because the paths were
 * built with the wrong case — and a stub using `existsSync` cannot
 * reproduce it on a dev machine. That is the "stub more permissive than
 * the real dependency" mistake this repo keeps paying for, so the
 * lookup compares against the real directory entries instead. */
function servedFile(rel: string): string | null {
  const parts = rel.split("/").filter(Boolean);
  let at = CATALOG;
  for (const part of parts) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return null;
    }
    const hit = entries.find((e) => e.name === part);
    if (!hit) return null;
    at = path.join(at, hit.name);
  }
  return fs.statSync(at).isDirectory() ? null : at;
}

const assets = {
  async fetch(req: Request): Promise<Response> {
    const rel = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ""));
    const file = servedFile(rel);
    return file
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
    await expect(worker.scheduled({}, gone)).rejects.toThrow();
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

    await expect(worker.scheduled({}, missing)).rejects.toThrow();
    expect(recorded()?.ok, "a catalog that cannot answer reported itself healthy").toBe(false);
    expect(recorded()?.detail, "nothing was recorded about what could not be answered").toMatch(/MATH 141/);
  });

  it("THROWS when it fails, because a cron that swallows its failure is silent", async () => {
    // THIS WAS BACKWARDS. A scheduled handler that catches and logs is
    // a SUCCESSFUL invocation as far as Cloudflare is concerned, so
    // the error-rate alert the README tells the operator to switch on
    // would never fire — the one notification path this ticket asked
    // for was a log nobody reads.
    //
    // Recording happens first, so throwing does not cost the report:
    // /health can still show what failed and when.
    const broken = { ...env, CATALOG: { async fetch() { throw new Error("boom"); } } } as Env;
    await expect(worker.scheduled({}, broken), "a failing cron reported success to Cloudflare").rejects.toThrow(
      /self-check failed/i,
    );
    expect(recorded()?.ok, "it threw without recording what happened").toBe(false);
  });

  it("FAILS WHEN THE CONNECTOR IS REFUSING EVERYONE", async () => {
    // THE FAILURE GO-LIVE ACTUALLY RISKS, and the first version of this
    // check was blind to it. With a secret or the KV binding missing,
    // the gate refuses every student with a 503 while the catalog loads
    // perfectly — so a monitor that only reads the catalog reports a
    // healthy connector that is answering nobody.
    for (const half of [{ ...env, SUPABASE_JWT_SECRET: undefined }, { ...env, OAUTH: undefined }]) {
      kv.store.clear();
      await expect(
        worker.scheduled({}, half as Env),
        "a connector refusing every request reported itself healthy",
      ).rejects.toThrow();
    }
  });

  it("says which way it is broken, when there is somewhere to write it down", async () => {
    // Only the missing-secret half can be recorded: with the KV binding
    // itself gone there is nowhere to put a report, which is exactly
    // why the THROW matters — in that state the Cloudflare alert is the
    // only signal that exists.
    await expect(worker.scheduled({}, { ...env, SUPABASE_JWT_SECRET: undefined } as Env)).rejects.toThrow();
    expect(recorded()?.detail, "the report does not say what is missing").toMatch(/missing|refusing/i);
  });

  it("passes only because the gate answers 401, not because it is absent", async () => {
    // The control for the test above: a configured connector tells an
    // anonymous caller to sign in, and that is what "healthy" means
    // here — not that the endpoint returned something.
    await worker.scheduled({}, env);
    expect(recorded()?.ok).toBe(true);
  });

  it("still answers when it cannot write its own result down", async () => {
    // The bookkeeping must not decide the verdict. A KV write failing
    // is not the connector failing — but the connector IS still
    // reachable here, so the run should not report a failure either.
    const noKv = {
      ...env,
      OAUTH: { ...kv, async put() { throw new Error("KV is unavailable"); } },
    } as unknown as Env;
    await expect(worker.scheduled({}, noKv), "a KV write failure was read as the connector failing").resolves
      .toBeUndefined();
  });
});

describe("what /health says about it", () => {
  it("reports the last check once one has run", async () => {
    await worker.scheduled({}, env);
    const body = await health();
    const last = body.last_self_check as { recorded?: boolean; ok?: boolean };
    expect(last?.recorded, "the check ran and /health does not know").toBe(true);
    expect(last?.ok).toBe(true);
  });

  it("says plainly when no check has run, rather than showing a reassuring blank", async () => {
    // An absent report is not a passing one. If the cron is not firing
    // at all — never configured, or disabled on a redeploy — that is
    // itself the thing to notice.
    const body = await health();
    // STRUCTURED, not prose: a consumer should not have to tell an
    // object from a sentence. And it says only what it knows — "no
    // report" has three causes that look identical from here.
    expect((body.last_self_check as { recorded?: boolean })?.recorded, "an absent report looked like a passing one").toBe(
      false,
    );
  });

  it("never hands the failure detail to an anonymous caller", async () => {
    // The reason is for the operator. An upstream message can carry a
    // file layout or a build command (DECISIONS.md 5.0 S5/S8/S13), and
    // /health takes no authentication.
    const gone = { ...env, CATALOG: { async fetch() { return new Response("no", { status: 404 }); } } } as Env;
    await expect(worker.scheduled({}, gone)).rejects.toThrow();
    // A later request on a working deploy still must not echo it.
    const body = JSON.stringify(await health());
    expect(body, "the failure detail reached an anonymous caller").not.toMatch(/sync-catalog|audit-index|\.ts:/);
  });
});

describe("/health as something an uptime monitor can watch", () => {
  /** The status code, which is all a monitor sees. */
  const status = async (e: Env) =>
    (await worker.fetch(new Request("https://mcp.lionsdegree.com/health"), e)).status;

  it("is 200 when the connector is actually serving", async () => {
    expect(await status(env)).toBe(200);
  });

  it("IS NOT 200 WHEN THE CONNECTOR IS REFUSING EVERY STUDENT", async () => {
    // THE PRODUCTION BUG, from this morning, in a test. With the JWT
    // secret unset, /health answered 200 while /mcp returned 503 to
    // every single request. Cloudflare has no Workers error alert on
    // any plan and its Health Checks need Pro, so on a free account an
    // external monitor on this URL is the realistic way to be told —
    // and a monitor can only see the status code. A health endpoint
    // that cannot go red is decoration.
    for (const half of [{ ...env, SUPABASE_JWT_SECRET: undefined }, { ...env, OAUTH: undefined }]) {
      expect(await status(half as Env), "a connector refusing everyone answered 200").toBe(503);
    }
  });

  it("says which way it is broken, without naming the missing piece", async () => {
    // Enough for the operator to know where to look; not enough to
    // tell an anonymous caller which secret is absent.
    const body = (await (
      await worker.fetch(new Request("https://mcp.lionsdegree.com/health"), {
        ...env,
        SUPABASE_JWT_SECRET: undefined,
      } as Env)
    ).json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(String(body.not_serving)).toMatch(/refusing every request/);
    expect(JSON.stringify(body), "the response names a specific secret").not.toMatch(/SUPABASE_JWT_SECRET|OAUTH/);
  });

  it("stays 200 when a PAST check failed but the connector works now", async () => {
    // A failure that has resolved belongs in the body, not in a page
    // at three in the morning. The status code tracks the live answer.
    kv.store.set(
      "health:last",
      JSON.stringify({ ok: false, at: "2026-11-01T00:00:00.000Z", detail: "it was broken earlier" }),
    );
    expect(await status(env), "a resolved failure kept the monitor red").toBe(200);
    const body = (await (
      await worker.fetch(new Request("https://mcp.lionsdegree.com/health"), env)
    ).json()) as { last_self_check?: { ok?: boolean } };
    expect(body.last_self_check?.ok, "the past failure vanished from the body too").toBe(false);
  });
});

describe("the harness itself", () => {
  it("serves assets case-sensitively, the way Cloudflare does", () => {
    // THE STUB'S OWN HONESTY, asserted. If this ever reverts to
    // `fs.existsSync`, the suite would quietly stop being able to
    // reproduce the failure the self-check was built for — on the dev
    // machines where it is written, and nowhere else.
    expect(servedFile("editions.json"), "the real file is not served").toBeTruthy();
    expect(servedFile("EDITIONS.JSON"), "the stub is case-insensitive, so it cannot model Linux").toBeNull();
  });
});
