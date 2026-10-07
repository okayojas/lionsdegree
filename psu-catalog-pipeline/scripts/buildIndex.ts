/** Emit the two client-facing index files the web app boots from:
 *   programs_index.json — slug/name/type/campuses/college/hasPlans
 *   subjects_index.json — course prefix -> courses file path
 * Run after a scrape:  npx tsx scripts/buildIndex.ts [--edition X] */
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

/** The readable opening, plus every remaining distinct word.
 *
 * Search scores against the description and DROPS a course whose terms score
 * nowhere, so a plain truncation silently shrinks the result set. Measured on
 * the real catalog, cutting at 200 characters kept only 14% of the top 25 for
 * "public speaking" -- it lost CAS 100A -- and 32% for "data structures".
 * Keeping the opening preserves phrase matching where it matters most, and
 * the tail of distinct words restores the rest: both of those return to 100%.
 *
 * Ranking among matches still shifts slightly, because repeated words are
 * counted once in the tail. That changes the order of courses that all
 * genuinely match, which is a far smaller harm than losing them. */
function searchText(text: string): string {
  if (text.length <= BLURB) return text;
  const cut = text.slice(0, BLURB);
  const lastSpace = cut.lastIndexOf(" ");
  const head = (lastSpace > BLURB * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
  const seen = new Set(head.toLowerCase().split(/[^a-z0-9]+/));
  const tail = [
    ...new Set(
      text
        .slice(head.length)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3 && !STOP.has(w) && !seen.has(w)),
    ),
  ];
  return tail.length ? `${head}… ${tail.join(" ")}` : head;
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

const slim: unknown[] = [];
for (const dir of [path.join(outDir, "courses"), path.join(outDir, "courses", "grad")]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    for (const c of JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"))) {
      // `url` is kept. Dropping it saved 0.01 MB compressed and made the chat
      // tool hand out an empty bulletin link for every course -- a false
      // economy that cost correctness for nothing.
      slim.push(withoutEmpties({ ...c, description: searchText(c.description ?? "") }));
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

const searchIndexPath = path.join(outDir, "search-index.json");
fs.writeFileSync(searchIndexPath, JSON.stringify(slim), "utf-8");
const slimMb = fs.statSync(searchIndexPath).size / 1048576;

console.log(
  `programs_index: ${programs.length} programs; subjects_index: ${Object.keys(subjects).length} subjects; ` +
    `search-index: ${slim.length} courses, ${slimMb.toFixed(1)} MB; ` +
    `program-requirements: ${Object.keys(programRequirements).length} programs, ${(fs.statSync(reqPath).size / 1048576).toFixed(1)} MB`,
);
