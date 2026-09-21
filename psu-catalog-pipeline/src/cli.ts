/** Pipeline CLI.
 *   tsx src/cli.ts scrape [--only courses|programs] [--limit N] [--edition 2025-2026]
 *   tsx src/cli.ts emit
 * `scrape` fetches (cache-first) and parses into data/out/<edition>/.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { fetchPage } from "./lib/fetcher.js";
import { discoverSubjects } from "./discover/subjects.js";
import { discoverPrograms } from "./discover/programs.js";
import { parseSubjectPage } from "./parse/courses.js";
import { parseProgramPage } from "./parse/program.js";
import { applyOverrides } from "./normalize/overrides.js";
import { buildCourseIndex, indexFromCourses, resolveCourseAsts, validateProgram, type IntegrityReport } from "./validate/integrity.js";
import { CourseSchema, ProgramSchema, type Course, type Program } from "./validate/schemas.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const edition = arg("edition") ?? config.edition;
const only = arg("only");
const limit = arg("limit") ? parseInt(arg("limit")!, 10) : Infinity;
const outDir = config.outDir(edition);

function writeJson(rel: string, data: unknown) {
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1), "utf-8");
}

async function scrapeCourses(): Promise<{ files: string[]; count: number; astIncomplete: number }> {
  // Phase 1: fetch + parse everything into memory.
  const parsed: { rel: string; courses: Course[] }[] = [];
  for (const level of ["undergraduate", "graduate"] as const) {
    const subjects = (await discoverSubjects(edition, level)).slice(0, limit);
    console.log(`[courses] ${level}: ${subjects.length} subjects`);
    for (const s of subjects) {
      const { html, fromCache } = await fetchPage(s.urlPath, { edition });
      const courses = parseSubjectPage(html, { level, pageUrl: config.baseUrl + s.urlPath });
      const slug = s.urlPath.replace(/\/$/, "").split("/").pop()!;
      parsed.push({ rel: `courses/${level === "graduate" ? "grad/" : ""}${slug}.json`, courses });
      if (!fromCache) process.stdout.write(".");
    }
    console.log();
  }

  // Phase 2: resolve prereq-AST course leaves against the full index (the
  // bulletins' prereq strings carry the same stale codes as their tables).
  const all = parsed.flatMap((p) => p.courses);
  const index = indexFromCourses(all);
  const astStats = resolveCourseAsts(all, index);
  console.log(`[courses] AST integrity: ${astStats.resolved} leaves suffix-resolved, ${astStats.expanded} expanded to variant or-chains`);

  // Phase 3: validate + write.
  const files: string[] = [];
  let count = 0;
  let astIncomplete = 0;
  for (const { rel, courses } of parsed) {
    for (const c of courses) CourseSchema.parse(c);
    count += courses.length;
    astIncomplete += courses.filter((c) => !c.astComplete).length;
    writeJson(rel, courses);
    files.push(rel);
  }
  return { files, count, astIncomplete };
}

async function scrapePrograms(): Promise<{ files: string[]; majors: number; minors: number; reviewRows: number; unstructuredSections: number; totalSections: number }> {
  const links = (await discoverPrograms(edition)).slice(0, limit);
  console.log(`[programs] ${links.length} programs discovered`);
  const files: string[] = [];
  const review: unknown[] = [];
  let majors = 0, minors = 0, unstructuredSections = 0, totalSections = 0;
  const courseIndex = buildCourseIndex(outDir);
  const integrity: IntegrityReport = { resolved: [], expanded: [], unverified: [] };
  if (!courseIndex.known.size) console.warn("[programs] WARNING: course index empty — run courses scrape first; integrity validation will mark everything unverified");

  for (const link of links) {
    try {
      const { html } = await fetchPage(link.url, { edition });
      const { program, needsReview } = parseProgramPage(html, link);
      applyOverrides(program);
      if (courseIndex.known.size) validateProgram(program, courseIndex, integrity);
      ProgramSchema.parse(program);
      const sub = program.type === "minor" ? "minors" : program.type === "certificate" ? "certificates" : "majors";
      if (sub === "majors") majors++; else if (sub === "minors") minors++;
      totalSections += program.requirementSections.length;
      unstructuredSections += program.requirementSections.filter((s) => !s.structured).length;
      const rel = `programs/${sub}/${program.slug}.json`;
      writeJson(rel, program);
      files.push(rel);
      for (const r of needsReview) review.push({ program: program.slug, ...r });
    } catch (e) {
      console.error(`\n[programs] FAILED ${link.slug}: ${(e as Error).message}`);
      review.push({ program: link.slug, heading: "(page failed)", text: String(e) });
    }
  }
  fs.mkdirSync(path.join(outDir, "review"), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "review", "needs_review.jsonl"),
    review.map((r) => JSON.stringify(r)).join("\n"),
    "utf-8",
  );
  fs.writeFileSync(path.join(outDir, "review", "integrity.json"), JSON.stringify(integrity, null, 1), "utf-8");
  console.log(`\n[programs] review rows: ${review.length}`);
  console.log(`[integrity] suffix-resolved: ${integrity.resolved.length}, family-expanded: ${integrity.expanded.length}, unverified: ${integrity.unverified.length}`);
  return { files, majors, minors, reviewRows: review.length, unstructuredSections, totalSections };
}

function emitManifest(files: string[], counts: Record<string, number>) {
  const fileMeta: Record<string, { sha256: string; bytes: number }> = {};
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(outDir, rel));
    fileMeta[rel.replace(/\\/g, "/")] = {
      sha256: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16),
      bytes: buf.length,
    };
  }
  writeJson("manifest.json", {
    edition,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    counts,
    files: fileMeta,
  });
}

async function main() {
  const cmd = process.argv[2];
  if (cmd !== "scrape") {
    console.error("usage: cli.ts scrape [--only courses|programs] [--limit N] [--edition X]");
    process.exit(1);
  }
  const files: string[] = [];
  const counts: Record<string, number> = {};

  if (!only || only === "courses") {
    const r = await scrapeCourses();
    files.push(...r.files);
    counts.courses = r.count;
    counts.coursesAstIncomplete = r.astIncomplete;
    console.log(`[courses] total ${r.count}, AST incomplete ${r.astIncomplete} (${((1 - r.astIncomplete / Math.max(1, r.count)) * 100).toFixed(1)}% complete)`);
  }
  if (!only || only === "programs") {
    const r = await scrapePrograms();
    files.push(...r.files);
    counts.majors = r.majors;
    counts.minors = r.minors;
    counts.reviewRows = r.reviewRows;
    console.log(`[programs] majors ${r.majors}, minors ${r.minors}; sections structured ${r.totalSections - r.unstructuredSections}/${r.totalSections} (${((1 - r.unstructuredSections / Math.max(1, r.totalSections)) * 100).toFixed(1)}%)`);
  }
  emitManifest(files, counts);
  console.log(`[done] manifest written to ${path.join(outDir, "manifest.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
