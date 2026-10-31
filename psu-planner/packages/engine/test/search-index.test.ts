/** The slim search index: every course an Edition publishes, carrying enough
 * to find and schedule a course but not the prose that dominates the Catalog's
 * size.
 *
 * NOW AN MCP-PACKAGE ARTIFACT (#29). The web app no longer reads it — the
 * audit reads `audit-index.json`, search adds `search-postings.json`, and
 * course detail reads the subject file — and it is deliberately excluded from
 * the web catalog sync, because one 2.4 MB file on the path every student
 * waits on is the whole of #24.
 *
 * It survives because `packages/mcp` requires it: that package bundles its own
 * catalog, cannot reasonably carry the full one, and has no boot-time
 * constraint. So the tests follow it to where it now lives rather than
 * asserting against a file the web app stopped shipping. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { buildCatalog, hydrateSearchIndex, searchCatalog, type Course } from "../src/index.js";
import { CATALOG_DIR, CATALOG_ROOT, latestEdition } from "./edition.js";

/** The MCP package's bundled catalog, which is where this artifact lives now.
 * Absent until `pnpm --filter lionsdegree-mcp sync-catalog` has run, so the
 * suite reports that rather than failing on a file it was never given. */
const MCP_CATALOG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../mcp/catalog",
);
const mcpEdition = fs.existsSync(path.join(MCP_CATALOG, latestEdition()))
  ? latestEdition()
  : (fs.existsSync(MCP_CATALOG) ? (fs.readdirSync(MCP_CATALOG).filter((d) => fs.existsSync(path.join(MCP_CATALOG, d, "search-index.json")))[0] ?? "") : "");
const MCP_DIR = mcpEdition ? path.join(MCP_CATALOG, mcpEdition) : "";
const indexPath = MCP_DIR ? path.join(MCP_DIR, "search-index.json") : "";
const haveIndex = Boolean(indexPath) && fs.existsSync(indexPath);

function slim(): Course[] {
  return hydrateSearchIndex(JSON.parse(fs.readFileSync(indexPath, "utf-8")));
}

/** Every course in the full Catalog, read the slow way, for comparison. */
function fullCourses(): Course[] {
  const out: Course[] = [];
  for (const dir of [path.join(CATALOG_DIR, "courses"), path.join(CATALOG_DIR, "courses", "grad")]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      out.push(...JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
    }
  }
  return out;
}

describe.skipIf(!haveIndex)("the slim search index (MCP bundle)", () => {
  it("exists for the published Edition", () => {
    expect(fs.existsSync(indexPath)).toBe(true);
  });

  it("holds every course the full Catalog holds", () => {
    const have = new Set(slim().map((c) => c.code));
    const missing = fullCourses()
      .map((c) => c.code)
      .filter((code) => !have.has(code));
    expect(missing.slice(0, 10)).toEqual([]);
  });

  it("carries what scheduling needs: credits, prerequisites and gen-ed tags", () => {
    const by = new Map(slim().map((c) => [c.code, c]));
    // MATH 141 has a real prerequisite and a GQ designation; if the index
    // dropped either, prereq chains and gen-ed audits would quietly weaken.
    const m = by.get("MATH 141");
    expect(m).toBeDefined();
    expect(m!.creditsParsed?.min).toBeGreaterThan(0);
    expect(m!.prereqAst).not.toBeNull();
    expect(by.get("ENGL 015")?.genEd ?? by.get("ENGL 15")?.genEd).toBeDefined();
  });

  it("is small enough to download on a phone", () => {
    // What a student actually pays is the COMPRESSED size over one request.
    // It replaces 20.2 MB fetched across 527 requests, so the bar is the
    // transfer, not the bytes on disk. Measured with gzip because brotli on
    // this file is slower than this suite should be; the CDN serves brotli,
    // which is smaller again.
    const gzip = zlib.gzipSync(fs.readFileSync(indexPath), { level: 6 }).length / 1048576;
    expect(gzip).toBeLessThan(3);
  });

  it("is small enough to ship inside an npm package", () => {
    // The MCP package carries this uncompressed on disk after install, which
    // is the only place the raw size is what matters.
    expect(fs.statSync(indexPath).size / 1048576).toBeLessThan(14);
  });

  it("returns the same top results as the full Catalog would", () => {
    // The earlier version of this test asserted only that a "robotics" search
    // returned SOMETHING. It passed while 9 of 16 robotics courses had
    // vanished, and while "public speaking" had lost CAS 100A. Asserting that
    // results merely exist is how a search regression ships.
    const slimCat = buildCatalog(slim());
    const fullCat = buildCatalog(fullCourses());
    for (const q of ["robotics", "public speaking", "machine learning", "thermodynamics"]) {
      const want = searchCatalog(fullCat, q, 25);
      const got = new Set(searchCatalog(slimCat, q, 25));
      const kept = want.filter((c) => got.has(c)).length / Math.max(want.length, 1);
      expect(kept, `${q}: only ${(100 * kept).toFixed(0)}% of the full catalog's top 25 survived`).toBeGreaterThanOrEqual(0.9);
    }
    expect(searchCatalog(slimCat, "CMPSC 465", 10)).toContain("CMPSC 465");
  });

  it("keeps the bulletin link, which the chat hands to students", () => {
    // Dropping `url` saved 0.01 MB compressed and made every bulletin link
    // an empty string.
    expect(slim().filter((c) => c.url).length).toBeGreaterThan(1000);
  });

  it("is produced for every Edition the MCP package bundles", () => {
    // Was asserted against the WEB catalog, which no longer carries this file
    // at all (#29). The property still matters — an MCP build that bundles
    // one edition's index and another's requirements would answer confidently
    // from the wrong bulletin — but it is a property of the package's own
    // bundle now, so that is what it reads.
    const bundled = fs
      .readdirSync(MCP_CATALOG, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(bundled.length, "the MCP package bundles no edition at all").toBeGreaterThan(0);
    const missing = bundled.filter((ed) => !fs.existsSync(path.join(MCP_CATALOG, ed, "search-index.json")));
    expect(missing, "editions bundled without a course index").toEqual([]);
  });

  it("omits the prose that dominates the Catalog's size", () => {
    const courses = slim();
    const total = courses.reduce((n, c) => n + (c.description ?? "").length, 0);
    // The full prose is ~9.9 MB; search text keeps the readable opening plus
    // the distinct words after it, which is materially less.
    expect(total).toBeLessThan(7_500_000);
    expect(latestEdition()).toBeTruthy();
  });
});
