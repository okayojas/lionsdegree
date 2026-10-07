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
function blurb(text: string): string {
  if (text.length <= BLURB) return text;
  const cut = text.slice(0, BLURB);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > BLURB * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
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
      // url is reconstructable from the course page and unused by search.
      const { url: _url, ...rest } = c;
      slim.push(withoutEmpties({ ...rest, description: blurb(c.description ?? "") }));
    }
  }
}
const searchIndexPath = path.join(outDir, "search-index.json");
fs.writeFileSync(searchIndexPath, JSON.stringify(slim), "utf-8");
const slimMb = fs.statSync(searchIndexPath).size / 1048576;

console.log(
  `programs_index: ${programs.length} programs; subjects_index: ${Object.keys(subjects).length} subjects; ` +
    `search-index: ${slim.length} courses, ${slimMb.toFixed(1)} MB`,
);
