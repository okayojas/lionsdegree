/** The MCP tool surface, called directly.
 *
 * The seam is the DISPATCHER, not the transport: protocol framing is the
 * SDK's job and testing it would assert a library rather than this project's
 * behaviour. Everything here is about what a student's assistant is told. */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool, listTools, loadContext, type ToolContext } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const planPath = path.join(here, "fixtures", "plan.json");

let ctx: ToolContext;
beforeAll(async () => {
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
});

const call = (name: string, args: Record<string, unknown> = {}) => executeTool(name, args, ctx);

describe("the tool surface", () => {
  it("offers the read tools", () => {
    const names = listTools().map((t) => t.name);
    for (const n of ["get_plan", "search_catalog", "audit_requirements"]) expect(names).toContain(n);
  });

  it("gates the one tool that can destroy work behind explicit consent", () => {
    // Until #13 this test asserted that NO mutating tool existed. That was
    // true then and is false now, so it asserts the thing that outlived the
    // ticket instead: a model must not be able to drop a required course by
    // reading a description and deciding the student meant it.
    const remove = listTools().find((t) => t.name === "remove_course");
    expect(remove, "remove_course is not declared").toBeDefined();
    const schema = JSON.stringify(remove!.inputSchema);
    expect(schema).toContain("user_explicitly_asked");
    expect(remove!.description).toMatch(/explicit|confirm|ask/i);
  });

  it("describes every tool it offers", () => {
    for (const t of listTools()) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema, t.name).toBeTruthy();
    }
  });

  it("refuses a tool it does not have", async () => {
    const r = (await call("delete_everything")) as { error?: string };
    expect(r.error).toMatch(/unknown tool/i);
  });
});

describe("get_plan", () => {
  it("reports the student's terms, courses and open slots", async () => {
    const r = (await call("get_plan")) as { programs: string[]; terms: { label: string; courses: unknown[] }[]; edition: string };
    expect(r.programs.length).toBeGreaterThan(0);
    expect(r.terms.length).toBeGreaterThan(0);
    expect(r.terms[0].label).toMatch(/Fall|Spring|Summer/);
  });

  it("says which bulletin Edition governs the plan", async () => {
    // A student's requirements come from the Edition they started under, so an
    // assistant answering without knowing it can be confidently wrong.
    const r = (await call("get_plan")) as { edition: string };
    expect(r.edition).toMatch(/^\d{4}-\d{4}$/);
  });
});

describe("search_catalog", () => {
  it("finds courses by topic, not only by code", async () => {
    const r = (await call("search_catalog", { query: "robotics" })) as { code: string }[];
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBeGreaterThan(0);
  });

  it("finds a course by its code", async () => {
    const r = (await call("search_catalog", { query: "CMPSC 465" })) as { code: string }[];
    expect(r.map((c) => c.code)).toContain("CMPSC 465");
  });

  it("caps how much it returns, so one call cannot flood the context", async () => {
    const r = (await call("search_catalog", { query: "engineering", limit: 500 })) as unknown[];
    expect(r.length).toBeLessThanOrEqual(25);
  });
});

describe("get_course_details", () => {
  it("returns the facts an assistant needs to answer about one course", async () => {
    const r = (await call("get_course_details", { code: "MATH 141" })) as Record<string, unknown>;
    expect(r.code).toBe("MATH 141");
    expect(r.title).toBeTruthy();
    expect(r.credits).toBeTruthy();
  });

  it("fences catalog prose as untrusted, never as instruction", async () => {
    // A course description is text the university wrote and we retrieved. If
    // an assistant treats it as instruction, a crafted description becomes a
    // prompt injection (DECISIONS.md 5.0, S4).
    const r = (await call("get_course_details", { code: "MATH 141" })) as { description: string };
    expect(r.description).toMatch(/^<untrusted_catalog_text>/);
    expect(r.description).toMatch(/<\/untrusted_catalog_text>$/);
  });

  it("says plainly when a code is not in the catalog", async () => {
    const r = (await call("get_course_details", { code: "FAKE 999" })) as { error?: string };
    expect(r.error).toMatch(/not in/i);
  });
});

describe("get_prereq_chain", () => {
  it("returns the whole chain in one call", async () => {
    // One call rather than a walk: a per-step loop blew the message cap and
    // timed out a real conversation (DECISIONS.md 4, get_prereq_chain).
    const r = (await call("get_prereq_chain", { code: "MATH 141" })) as Record<string, unknown>;
    expect(r.code).toBe("MATH 141");
    expect(r).toHaveProperty("prerequisites");
  });
});

describe("search_programs", () => {
  it("finds a major by name", async () => {
    const r = (await call("search_programs", { query: "engineering science" })) as { matches: { slug: string }[] };
    expect(r.matches.length).toBeGreaterThan(0);
  });

  it("does not claim a program is absent when it exists at another campus", async () => {
    const r = (await call("search_programs", { query: "accounting" })) as { note: string };
    expect(r.note).toMatch(/campus/i);
  });
});

describe("audit_requirements", () => {
  it("reports progress against the plan's programs", async () => {
    const r = (await call("audit_requirements")) as { programs: { slug: string }[] };
    expect(r.programs.length).toBeGreaterThan(0);
  });
});

describe("it needs nothing from the network", () => {
  it("reads only files inside the package and the student's plan", async () => {
    // No account, no key, no fetch. The whole point is that running it costs
    // the project nothing and tells no one what a student is studying.
    expect(fs.existsSync(path.join(CATALOG, "editions.json"))).toBe(true);
    const src = fs.readFileSync(path.resolve(here, "..", "src", "tools.ts"), "utf-8");
    expect(src).not.toMatch(/\bfetch\s*\(|https?:\/\/(?!bulletins)/);
  });
});

describe("a catalog it cannot read", () => {
  /** The old reader swallowed every error and returned an empty catalog, so
   * the server started cleanly and then answered "MATH 141 is not in the
   * 2025-2026 catalog" for every course. A confident wrong answer is the one
   * outcome this package is built to avoid (iron rule 2). */
  /** A catalog root holding only the edition the fixture plan pins, so the
   * server gets past the "this build has no such bulletin" check and reaches
   * the reader -- which is what these tests are about. */
  const ED = (JSON.parse(fs.readFileSync(planPath, "utf-8")).plan.edition ?? "2026-2027") as string;
  const scratch = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-cat-"));
    fs.mkdirSync(path.join(root, ED));
    fs.writeFileSync(path.join(root, "editions.json"), JSON.stringify({ editions: [ED], latest: ED }));
    return root;
  };

  it("refuses to start when the course index is missing", async () => {
    const root = scratch();
    fs.writeFileSync(path.join(root, ED, "program-requirements.json"), JSON.stringify({ a: {} }));
    await expect(loadContext({ planPath, catalogRoot: root })).rejects.toThrow(/course index/i);
  });

  it("refuses to start when the course index is present but empty", async () => {
    const root = scratch();
    fs.writeFileSync(path.join(root, ED, "search-index.json"), "[]");
    fs.writeFileSync(path.join(root, ED, "program-requirements.json"), JSON.stringify({ a: {} }));
    // Parsed-but-empty is the same failure wearing a different hat.
    await expect(loadContext({ planPath, catalogRoot: root })).rejects.toThrow(/empty/i);
  });

  it("says how to fix it", async () => {
    const root = scratch();
    fs.writeFileSync(path.join(root, ED, "search-index.json"), "{ not json");
    await expect(loadContext({ planPath, catalogRoot: root })).rejects.toThrow(/sync-catalog/);
  });
});
