/** Search quality against the slim catalog.
 *
 * THE ARTIFACT MOVED TWICE AND THIS SUITE WENT QUIET. It used to read
 * `search-index.json`; #29 took that off the web's boot path and #31
 * removed it from the MCP package too, which left every case here
 * skipping on a missing file — a search-quality guard that had stopped
 * guarding anything while still appearing in the run.
 *
 * It now reads what actually ships: `audit-index.json` for the Courses
 * and `search-postings.json` for the ranking, which is the pair the
 * hosted connector searches with. Same question as before — does the
 * slim catalog return what the full one would — asked of the files that
 * exist. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  buildCatalog, buildSearchRanking, hydrateAuditRow, searchCatalog,
  type AuditIndexFile, type Course, type SearchRanking,
} from "../src/index.js";
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
  : (fs.existsSync(MCP_CATALOG) ? (fs.readdirSync(MCP_CATALOG).filter((d) => fs.existsSync(path.join(MCP_CATALOG, d, "audit-index.json")))[0] ?? "") : "");
const MCP_DIR = mcpEdition ? path.join(MCP_CATALOG, mcpEdition) : "";
const indexPath = MCP_DIR ? path.join(MCP_DIR, "audit-index.json") : "";
const postingsPath = MCP_DIR ? path.join(MCP_DIR, "search-postings.json") : "";
const haveIndex = Boolean(indexPath) && fs.existsSync(indexPath) && fs.existsSync(postingsPath);

function slim(): Course[] {
  const file = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as AuditIndexFile;
  return file.courses.map(hydrateAuditRow);
}

/** The body signal the hosted connector loads on first search. */
function ranking(): SearchRanking {
  const f = JSON.parse(fs.readFileSync(postingsPath, "utf-8")) as {
    terms: string[];
    postings: Record<string, number[]>;
  };
  return buildSearchRanking(f.terms, f.postings);
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

  it("carries what the audit needs, and says plainly what it does not", () => {
    // Credits and gen-ed designations ARE here: the audit reasons about
    // every Course in the catalog and those are what it reads.
    const by = new Map(slim().map((c) => [c.code, c]));
    const m = by.get("MATH 141");
    expect(m).toBeDefined();
    expect(m!.creditsParsed?.min).toBeGreaterThan(0);
    expect(by.get("ENGL 015")?.genEd ?? by.get("ENGL 15")?.genEd).toBeDefined();

    // Prerequisites are NOT, and that is the design rather than a gap —
    // they live in the subject file, loaded for the Courses that need
    // them (#31). What matters is that a row without them SAYS so:
    // `astComplete: false` is what stops a prerequisite check reporting
    // "satisfied" on structure nobody read (iron rule 2).
    expect(m!.prereqAst, "an audit row invented a prerequisite tree").toBeNull();
    expect(m!.astComplete, "an audit row claimed complete prerequisites").toBe(false);
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
    const rank = ranking();
    for (const q of ["robotics", "public speaking", "machine learning", "thermodynamics"]) {
      // The full catalog carries descriptions, so it ranks on them
      // directly; the slim one needs the postings handed to it. Same
      // signal, two routes to it — which is exactly what is being
      // compared.
      const want = searchCatalog(fullCat, q, 25);
      const got = new Set(searchCatalog(slimCat, q, 25, rank));
      const kept = want.filter((c) => got.has(c)).length / Math.max(want.length, 1);
      expect(kept, `${q}: only ${(100 * kept).toFixed(0)}% of the full catalog's top 25 survived`).toBeGreaterThanOrEqual(0.9);
    }
    expect(searchCatalog(slimCat, "CMPSC 465", 10, rank)).toContain("CMPSC 465");
  });

  it("leaves the bulletin link to the subject file, and says so", () => {
    // The audit index deliberately carries no `url` -- 11% of the old
    // combined file for 526 distinct values (#24). `get_course_details`
    // loads the subject file, which has it. What matters is that an
    // audit row does not pretend to one: an empty string rendered as a
    // link is worse than a tool that goes and fetches the real thing.
    expect(slim().every((c) => c.url === "")).toBe(true);
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
    const missing = bundled.filter((ed) => !fs.existsSync(path.join(MCP_CATALOG, ed, "audit-index.json")));
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
