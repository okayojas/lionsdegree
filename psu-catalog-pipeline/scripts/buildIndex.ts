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

console.log(`programs_index: ${programs.length} programs; subjects_index: ${Object.keys(subjects).length} subjects`);
