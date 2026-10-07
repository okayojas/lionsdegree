/** The slim search index: every course an Edition publishes, carrying enough
 * to find and schedule a course but not the prose that dominates the Catalog's
 * size.
 *
 * Catalog search used to fetch all 527 subject files, around 20 MB, the first
 * time a student asked the advisor anything. On a phone on campus that is the
 * download before the answer. The same artifact is what the MCP package ships,
 * since it cannot reasonably carry the full Catalog. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildCatalog, hydrateSearchIndex, searchCatalog, type Course } from "../src/index.js";
import { CATALOG_DIR, CATALOG_ROOT, latestEdition } from "./edition.js";

const indexPath = path.join(CATALOG_DIR, "search-index.json");

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

describe("the slim search index", () => {
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

  it("is produced for every published Edition", () => {
    const editions: string[] = JSON.parse(
      fs.readFileSync(path.join(CATALOG_ROOT, "editions.json"), "utf-8"),
    ).editions;
    expect(editions.length).toBeGreaterThan(1);
    for (const ed of editions) {
      expect(fs.existsSync(path.join(CATALOG_ROOT, ed, "search-index.json"))).toBe(true);
    }
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
