/** Asking what a Program requires, through the hosted connector.
 *
 * The local tests drive `executeTool` directly. That is the seam, but it
 * is not the deploy: the Worker builds its own context, picks its own
 * catalog and decides for itself which Edition a question is answered
 * against. "The local one works" has never been evidence about any of
 * those, and the one property this ticket most needs — that a student is
 * answered from THEIR bulletin and never from the one next to it — is
 * decided entirely on this path.
 *
 * Its own file, with its own harness, rather than another block on
 * `worker-plan.test.ts`: the thing under test is a different question,
 * and the harness is sixty lines that would otherwise be shared by
 * accident.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetInMemoryCounters, type KVLike } from "@psu-planner/identity";
import worker, { type Env } from "../src/worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const SECRET = "test-jwt-secret";

const PLAN = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "plan.json"), "utf-8")).plan;

/** A minor the fixture student has not declared. */
const MATH_MINOR = "eberly-science-mathematics-minor";
/** FIRST PUBLISHED IN 2026-2027. A student pinned to 2025-2026 must not
 * be shown it, and this connector carries both editions, so the wrong
 * answer is genuinely within reach (ADR 0001). */
const NEW_IN_2026 = "arts-architecture-popular-music-minor";

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

function memoryKv(): KVLike {
  const store = new Map<string, string>();
  return {
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function signedIn(sub = "student-1"): Promise<string> {
  const payload = { sub, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: "s@psu.edu" };
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `Bearer ${body}.${b64url(sig)}`;
}

const env = (): Env =>
  ({
    CATALOG: assets,
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    OAUTH: memoryKv(),
  }) as Env;

/** Stands in for the student's row in Postgres. */
function database(reply: () => Response) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => reply()) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; } };
}

const storing = (plan: unknown) => () =>
  Response.json([{ doc: plan, rev: 4, updated_at: "2026-10-20T09:00:00.000Z" }]);

async function rpc(e: Env, auth: string, method: string, params: unknown): Promise<Record<string, unknown>> {
  const res = await worker.fetch(
    new Request("https://mcp.lionsdegree.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: auth,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    e,
  );
  const line = (await res.text()).split("\n").filter((l) => l.startsWith("data:")).pop()!;
  return JSON.parse(line.slice(5).trim()).result as Record<string, unknown>;
}

interface Answer {
  slug?: string;
  edition?: string;
  sections?: { heading: string; credits_required: number | null }[];
  total_credits?: number | null;
  in_your_plan?: boolean;
  offered_at?: string[] | null;
  error?: string;
  editions_this_connector_carries?: string[];
}

async function ask(e: Env, auth: string, slug: string): Promise<Answer> {
  const result = await rpc(e, auth, "tools/call", { name: "get_program_requirements", arguments: { slug } });
  return JSON.parse((result.content as { text: string }[])[0].text) as Answer;
}

const offered = async (e: Env, auth: string): Promise<string[]> =>
  ((await rpc(e, auth, "tools/list", {})).tools as { name: string }[]).map((t) => t.name);

let db: ReturnType<typeof database> | null = null;
beforeEach(() => resetInMemoryCounters());
afterEach(() => { db?.restore(); db = null; });

describe("a signed-in student asking what another program requires", () => {
  it("gets its requirement sections", async () => {
    db = database(storing(PLAN));
    const r = await ask(env(), await signedIn(), MATH_MINOR);
    expect(r.error, `the hosted connector refused a real minor: ${r.error}`).toBeUndefined();
    expect(r.sections?.length, "no requirement sections came back from the hosted connector").toBeGreaterThan(0);
    expect(r.sections!.every((s) => typeof s.heading === "string" && s.heading.length > 0),
      "a section came back without a heading").toBe(true);
  });

  it("is told it is not one of their own programs", async () => {
    // So a model does not read these sections back as progress against
    // a degree the student never declared.
    db = database(storing(PLAN));
    const r = await ask(env(), await signedIn(), MATH_MINOR);
    expect(r.in_your_plan, "a program the student has not declared was reported as theirs").toBe(false);
  });

  it("is offered the tool at all", async () => {
    expect(await offered(env(), await signedIn()), "get_program_requirements is not reachable hosted")
      .toContain("get_program_requirements");
  });
});

describe("which bulletin the hosted connector answers from", () => {
  it("is the student's own, not the newest published", async () => {
    // The Worker picks the catalog, and the newest is the one it uses
    // for every question that has no Plan behind it. A student pinned
    // to 2025-2026 must still be answered from 2025-2026 (ADR 0001).
    db = database(storing({ ...PLAN, edition: "2025-2026" }));
    const r = await ask(env(), await signedIn(), MATH_MINOR);
    expect(r.edition, "the hosted connector answered from a bulletin the student is not pinned to").toBe("2025-2026");
  });

  it("refuses a program that edition does not carry, with the editions it has", async () => {
    // THE ASSERTION THAT MATTERS HERE. This minor exists in 2026-2027,
    // which the same isolate can load and may already have warm. A
    // student on 2025-2026 asking for it must be refused and told what
    // we hold — never handed the 2026-2027 requirements, which do not
    // govern them.
    db = database(storing({ ...PLAN, edition: "2025-2026" }));
    const r = await ask(env(), await signedIn(), NEW_IN_2026);
    expect(r.sections, "a program from a later bulletin was answered to a student pinned to an earlier one")
      .toBeUndefined();
    expect(r.error, "the refusal does not name the bulletin the student follows").toMatch(/2025-2026/);
    expect(r.editions_this_connector_carries, "the refusal does not say what this connector carries")
      .toEqual(expect.arrayContaining(["2025-2026", "2026-2027"]));
  });

  it("answers for that same program once the student is pinned to the edition that has it", async () => {
    // The other half of the pair, on the same connector in the same
    // run. Without it the refusal above could be a program we simply
    // cannot read rather than one that edition does not carry.
    db = database(storing({ ...PLAN, edition: "2026-2027" }));
    const r = await ask(env(), await signedIn(), NEW_IN_2026);
    expect(r.error, `the 2026-2027 student was refused their own bulletin's minor: ${r.error}`).toBeUndefined();
    expect(r.edition).toBe("2026-2027");
    expect(r.sections?.length, "no sections for a minor that edition does publish").toBeGreaterThan(0);
  });
});

describe("a student with no plan stored, hosted", () => {
  it("is sent to the planner rather than answered from the newest bulletin", async () => {
    // Without a Plan there is no Edition to be pinned to, and guessing
    // one would quietly answer about requirements that may not govern
    // them. Being sent to build a Plan is the honest outcome.
    db = database(() => Response.json([]));
    const r = await ask(env(), await signedIn(), MATH_MINOR);
    expect(r.error, "a program was described against a bulletin nobody chose").toMatch(/no plan to read|build one/i);
    expect(r.sections, "requirement sections came back for a student with no plan").toBeUndefined();
  });
});
