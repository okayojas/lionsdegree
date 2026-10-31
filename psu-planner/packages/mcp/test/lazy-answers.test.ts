/** The tools still answer fully, now that the catalog arrives in pieces.
 *
 * THE RISK THIS COVERS. #31 stopped loading every field of every Course up
 * front. The failure mode is not a crash — it is a tool that quietly
 * answers with LESS: empty keywords, a missing bulletin link, a
 * prerequisite tree that stops two levels early and looks complete.
 * Every one of those reads as a fact about the Course rather than as a
 * fact about what we bothered to load, which is the confident-wrong-answer
 * shape this package exists to refuse.
 *
 * So these assert substance, not shape. "Has a bulletin URL" rather than
 * "returns an object with a bulletin_url key".
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool, loadContext, type ToolContext } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const planPath = path.join(here, "fixtures", "plan.json");

let ctx: ToolContext;
beforeAll(async () => {
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
}, 60_000);

const call = (name: string, args: Record<string, unknown> = {}) =>
  executeTool(name, args, ctx) as Promise<Record<string, unknown>>;

describe("answers that need a subject file", () => {
  it("gives a Course its keywords and its bulletin link", async () => {
    // Both live in the subject file. Before the tool learned to ask for
    // one, these came back empty for every Course — and an empty keyword
    // list reads as "this Course is about nothing".
    const d = await call("get_course_details", { code: "MATH 141" });
    expect(d.error, String(d.error)).toBeUndefined();
    expect(d.title).toBeTruthy();
    expect(Array.isArray(d.keywords) && (d.keywords as string[]).length, "no keywords").toBeGreaterThan(0);
    expect(String(d.bulletin_url ?? ""), "no bulletin link").toMatch(/^https?:\/\//);
  });

  it("reports a real prerequisite requirement rather than silence", async () => {
    // MATH 141 has an enforced prerequisite in the Bulletin. Reporting
    // none would say "anyone can take this", which is a different claim
    // from "we have not read it".
    const d = await call("get_course_details", { code: "MATH 141" });
    expect(String(d.enforced_prerequisites ?? ""), "no prerequisite text").not.toBe("");
  });
});

describe("the prerequisite chain", () => {
  it("walks deeper than one hop", async () => {
    // The whole point of the chain tool. One hop is what `ensureCourses`
    // does; a chain that stopped there would return a tree one level deep
    // and present it as the whole story.
    const chain = await call("get_prereq_chain", { code: "MATH 230", max_depth: 3 });
    const depth = (n: Record<string, unknown>, d = 0): number => {
      const kids = (n.prerequisites as Record<string, unknown>[] | undefined) ?? [];
      return kids.length ? Math.max(...kids.map((k) => depth(k, d + 1))) : d;
    };
    expect(depth(chain), "the chain came back flat").toBeGreaterThan(1);
  });

  it("names the Courses at each level, not just codes it could not resolve", async () => {
    const chain = await call("get_prereq_chain", { code: "MATH 230", max_depth: 3 });
    const kids = (chain.prerequisites as Record<string, unknown>[] | undefined) ?? [];
    expect(kids.length, "no direct prerequisites found").toBeGreaterThan(0);
    for (const k of kids) expect(k.title, `${k.code} came back with no title`).toBeTruthy();
  });
});

describe("search", () => {
  it("still finds a Course by what it is about, not just by its code", async () => {
    // The postings are loaded lazily now. If that load were skipped or
    // broken, search would silently narrow to code-and-title matching —
    // which still returns results, so nothing would look wrong.
    const hits = (await executeTool("search_catalog", { query: "robotics", limit: 10 }, ctx)) as {
      code: string;
    }[];
    expect(hits.length, "no results for a term common in descriptions").toBeGreaterThan(3);
    expect(
      hits.some((h) => !h.code.toLowerCase().includes("rob")),
      "every hit matched the code, so the description signal is not loaded",
    ).toBe(true);
  });
});

describe("the audit", () => {
  it("sees the whole catalog, not only the Plan's own subjects", async () => {
    // An elective or a General Education requirement can be satisfied by
    // almost anything, so narrowing the catalog to what the Plan touches
    // would quietly hide real options. This is why the audit index is
    // loaded in full while everything else is deferred.
    expect(Object.keys(ctx.data.catalog).length).toBeGreaterThan(10_000);
  });

  it("answers an audit without error", async () => {
    const audit = await call("audit_requirements");
    expect(audit.error, String(audit.error)).toBeUndefined();
  });
});
