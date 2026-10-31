/** Emit the two client-facing index files the web app boots from:
 *   programs_index.json — slug/name/type/campuses/college/hasPlans
 *   subjects_index.json — course prefix -> courses file path
 * Run after a scrape:  npx tsx scripts/buildIndex.ts [--edition X] */
import { encodePostings } from "@psu-planner/engine";
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const edition = arg("edition") ?? config.edition;
const outDir = config.outDir(edition);

// programs_index.json
const programs: unknown[] = [];
for (const sub of ["majors", "minors", "certificates"]) {
  const dir = path.join(outDir, "programs", sub);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    programs.push({
      slug: p.slug,
      name: p.name,
      type: p.type,
      campuses: p.campuses ?? [],
      college: p.college,
      hasPlans: (p.suggestedPlans ?? []).length > 0,
    });
  }
}
fs.writeFileSync(path.join(outDir, "programs_index.json"), JSON.stringify(programs), "utf-8");

// subjects_index.json — prefix -> file, from actual parsed course data
const subjects: Record<string, string> = {};
for (const [dir, rel] of [
  [path.join(outDir, "courses"), "courses"],
  [path.join(outDir, "courses", "grad"), "courses/grad"],
] as const) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const courses = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    if (!Array.isArray(courses) || !courses.length) continue;
    const prefix = courses[0].subject;
    // Undergrad wins collisions (grad file for same prefix is merged client-side later).
    const key = rel === "courses/grad" && subjects[prefix] ? prefix + ":grad" : prefix;
    subjects[key] = `${rel}/${f}`;
  }
}
fs.writeFileSync(path.join(outDir, "subjects_index.json"), JSON.stringify(subjects), "utf-8");

// search-index.json — every course in one file, without the prose.
//
// Catalog search used to fetch all ~527 subject files (about 20 MB) the first
// time a student asked the advisor anything, which on a phone is the download
// before the answer. Descriptions are 69% of that payload, so they are cut to
// a blurb rather than dropped: search scores against the description, and
// "robotics" failing to find the right course is the incident that started
// this (DECISIONS.md 4.2). Everything scheduling needs -- credits, prerequisite
// structure, gen-ed tags, attributes, aliases -- is kept whole.
//
// The full description is still one fetch away in the subject file, which is
// what a course card already reads.
const BLURB = 200;
const STOP = new Set(
  ("a an the and or of in to for with on by is are as its this that at from will be may not have has " +
    "been students student course courses credit credits prerequisite concurrent").split(" "),
);

/** Build the shared term dictionary and per-course postings.
 *
 * The scorer asked the description exactly one question -- how often does this
 * term occur, capped at 5 -- so that is all the index carries. The prose stops
 * here, at the build (DECISIONS.md 5.1).
 *
 * Words are stored AS WRITTEN, not stemmed. The engine stems the query
 * ("statistics" -> "statistic") and then prefix-matches, and every inflection
 * in the text already starts with its own stem -- "statistics" and
 * "statistical" both begin "statistic" -- so storing stems too was 437,000
 * redundant postings for matches the prefix walk already makes.
 *
 * Previously this emitted a 200-character blurb plus a bag of distinct words,
 * which was still Penn State's prose and still shipped. Counts are facts about
 * the text; the blurb was the text. */
function buildPostings(descriptions: Map<string, string>): {
  terms: string[];
  byCode: Map<string, number[]>;
} {
  const counts = new Map<string, Map<string, number>>();
  const vocab = new Set<string>();
  for (const [code, text] of descriptions) {
    const per = new Map<string, number>();
    for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (!w || w.length < 2 || STOP.has(w)) continue;
      per.set(w, (per.get(w) ?? 0) + 1);
      vocab.add(w);
    }
    if (per.size) counts.set(code, per);
  }
  const terms = [...vocab].sort();
  const id = new Map(terms.map((t, i) => [t, i] as const));
  const byCode = new Map<string, number[]>();
  for (const [code, per] of counts) {
    const ids = new Map<number, number>();
    for (const [t, n] of per) ids.set(id.get(t)!, n);
    byCode.set(code, encodePostings(ids));
  }
  return { terms, byCode };
}

/** Empty fields cost more than they look: `"crossListings":[]` on 12,727
 * courses and `"concurrent":null` on 14,479 is key names repeated 14,615
 * times. Dropped here and restored by hydrateSearchIndex in the engine, so
 * consumers still receive whole Course objects. */
function withoutEmpties(c: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    if (k === "level" && v === "undergraduate") continue; // the common case
    out[k] = v;
  }
  return out;
}

/** audit-index.json — what the DEGREE AUDIT needs about every course (#26).
 *
 * The audit has to see the whole catalog: an elective or a General Education
 * requirement can be satisfied by almost anything, so narrowing it to the
 * subjects a plan already touches would silently hide real options from a
 * student. What it does not need is every field. It needs to know a course
 * exists, what it is called, what it is worth, and which requirement buckets
 * it can fill.
 *
 * Five fields against twenty-two is the difference between 206 KB and 2.36 MB
 * on a path every student walks (#24). Everything left out is left out
 * because it already lives where it is used:
 *
 *   description  never shipped at all (DECISIONS.md 5.1)
 *   keywords     in the per-subject file the course modal already loads
 *   url          likewise, and only 526 distinct values across 14,615 courses
 *   prereqAst    only wanted for courses the chart loads real subject files for
 *   credits      the same fact as creditsParsed, in a shape nothing computes on
 *   t            search postings; meaningless until somebody types
 */
interface AuditRow {
  code: string;
  title: string;
  creditsParsed?: unknown;
  genEd?: string[];
  attributes?: string[];
  /** Only ever present for graduate courses: `withoutEmpties` drops the
   * "undergraduate" common case, so 9,489 of 14,615 rows carry nothing. */
  level?: string;
}
const auditRows: AuditRow[] = [];

const descriptions = new Map<string, string>();
for (const dir of [path.join(outDir, "courses"), path.join(outDir, "courses", "grad")]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    for (const c of JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"))) {
      // `url` is kept. Dropping it saved 0.01 MB compressed and made the chat
      // tool hand out an empty bulletin link for every course -- a false
      // economy that cost correctness for nothing.
      descriptions.set(c.code, c.description ?? "");
      // Built from the SAME walk that collects descriptions, so the audit
      // index cannot cover a different set of courses than the catalog it is
      // derived from. (`slim` moved to its own walk in #29; this comment used
      // to name it and was wrong for a release.) A separate pass over the
      // same directories would be one filter away from quietly omitting a
      // subject -- which the pipeline suite now also asserts against.
      auditRows.push(
        withoutEmpties({
          code: c.code,
          title: c.title,
          creditsParsed: c.creditsParsed ?? null,
          genEd: c.genEd ?? [],
          attributes: c.attributes ?? [],
          // NOT omittable. The index is built from courses/ AND courses/grad/,
          // and 5,126 of these rows are 500-level or higher. The engine gates
          // gen-ed and elective suggestions on `level !== "undergraduate"`
          // (genEd.ts, slotPicks.ts), so a row that does not carry this is a
          // graduate course the planner will happily offer a sophomore.
          level: c.level ?? "undergraduate",
        }) as unknown as AuditRow,
      );
    }
  }
}
// program-requirements.json — every program's REQUIREMENTS in one file.
//
// For anything that audits an existing plan rather than generating one, the
// suggested-plan grids are dead weight: 4.8 MB of the 8.2 MB in the program
// files, describing a schedule the student already has. rawText is another
// 1.5 MB of display prose that the structured rules already carry. Dropping
// both leaves the part an audit actually reads.
const programRequirements: Record<string, unknown> = {};
for (const sub of ["majors", "minors", "certificates"]) {
  const dir = path.join(outDir, "programs", sub);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    programRequirements[p.slug] = {
      slug: p.slug,
      name: p.name,
      type: p.type,
      totalCredits: p.totalCredits ?? null,
      requirementSections: (p.requirementSections ?? []).map(({ rawText: _raw, ...s }: Record<string, unknown>) => s),
    };
  }
}
const reqPath = path.join(outDir, "program-requirements.json");
fs.writeFileSync(reqPath, JSON.stringify(programRequirements), "utf-8");

const { terms, byCode } = buildPostings(descriptions);
/* search-index.json — now built FOR THE MCP PACKAGE ONLY (#29).
 *
 * #29 set out to delete this outright. It cannot be: `packages/mcp` reads it
 * as a required file and its `prepublishOnly` syncs it, so removing the
 * emission breaks that package at publish and at runtime. The ticket's claim
 * that the MCP package was unaffected was simply wrong, and the build failing
 * is how that surfaced.
 *
 * What #29 actually achieves, and what matters, is that the WEB app never
 * requests it: the audit reads audit-index.json, search adds
 * search-postings.json, and course detail reads the subject file. This file
 * is deliberately excluded from the web catalog sync, so it cannot find its
 * way back onto a path a student waits on.
 *
 * Retiring it for real means giving the MCP package a bundle of its own.
 * That is a separate piece of work, not a line to delete here. */
const slim: unknown[] = [];
for (const dir of [path.join(outDir, "courses"), path.join(outDir, "courses", "grad")]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    for (const c of JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"))) {
      const { description: _drop, ...rest } = c;
      const e = withoutEmpties(rest) as { code?: string; t?: number[] };
      const packed = e.code ? byCode.get(e.code) : undefined;
      if (packed?.length) e.t = packed;
      slim.push(e);
    }
  }
}
const searchIndexPath = path.join(outDir, "search-index.json");
fs.writeFileSync(searchIndexPath, JSON.stringify({ terms, courses: slim }), "utf-8");
const slimMb = fs.statSync(searchIndexPath).size / 1048576;

const auditIndexPath = path.join(outDir, "audit-index.json");
fs.writeFileSync(auditIndexPath, JSON.stringify({ courses: auditRows }), "utf-8");
const auditMb = fs.statSync(auditIndexPath).size / 1048576;

/** search-postings.json — the body signal, on its own (#28).
 *
 * The term dictionary plus per-course posting lists: how often each
 * dictionary term occurs in a course's description, capped at 5. It is the
 * one question the scorer asks of the prose, and the prose itself still
 * stops here at the build (DECISIONS.md 5.1).
 *
 * Split out because it is 31% of the old index and means nothing until
 * somebody types. A student opening a plan was downloading the ranking data
 * for 14,615 courses in order to look at a chart. */
const postings: Record<string, number[]> = {};
for (const [code, packed] of byCode) if (packed.length) postings[code] = packed;
const postingsPath = path.join(outDir, "search-postings.json");
fs.writeFileSync(postingsPath, JSON.stringify({ terms, postings }), "utf-8");
const postingsMb = fs.statSync(postingsPath).size / 1048576;

console.log(
  `programs_index: ${programs.length} programs; subjects_index: ${Object.keys(subjects).length} subjects; ` +
    `search-index(mcp): ${slim.length} courses, ${slimMb.toFixed(1)} MB; ` +
    `audit-index: ${auditRows.length} courses, ${auditMb.toFixed(2)} MB; ` +
    `search-postings: ${Object.keys(postings).length} courses, ${postingsMb.toFixed(2)} MB; ` +
    `program-requirements: ${Object.keys(programRequirements).length} programs, ${(fs.statSync(reqPath).size / 1048576).toFixed(1)} MB`,
);
