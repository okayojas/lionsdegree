/** Checks the landing page's sample Plan against the latest Edition.
 *
 * Runs before every build and before the dev server (`prepage`). The landing
 * page names 96 Courses and one Program, and a name on the front page is a
 * claim: if the Bulletin retires CMPSC 461, the page must stop saying it
 * before a student sees it, not after one writes in. So this does not warn.
 * `assertSamplePlan` throws, the script exits non-zero, and the build stops
 * with the list of what no longer matches.
 *
 * The check itself is in src/landing/sample-plan.ts, beside the data, where
 * the unit suite can hand it a Course that does not exist.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLE_PLAN, assertSamplePlan } from "../src/landing/sample-plan.js";
import { latestEdition } from "./catalog-programs.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const edition = latestEdition();
const read = (file: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(web, "public", "catalog", edition, file), "utf-8"));
/** Both files are a bare list in some Editions and wrapped in others. */
const listOf = (raw: unknown, key: string): Record<string, unknown>[] =>
  Array.isArray(raw) ? raw : ((raw as Record<string, unknown[]>)[key] ?? []);

const courses = new Set(listOf(read("audit-index.json"), "courses").map((c) => String(c.code)));
const programs = new Set(listOf(read("programs_index.json"), "programs").map((p) => String(p.slug)));
if (!courses.size || !programs.size) {
  throw new Error(`read ${courses.size} Courses and ${programs.size} Programs from the ${edition} Edition; expected thousands and hundreds`);
}

assertSamplePlan(SAMPLE_PLAN, {
  edition,
  hasCourse: (code) => courses.has(code),
  hasProgram: (id) => programs.has(id),
});

const named = SAMPLE_PLAN.terms.reduce((n, term) => n + term.courses.length, 0) + SAMPLE_PLAN.others.length;
console.log(`sample-plan: ${SAMPLE_PLAN.title}, ${named} Courses, all in the ${edition} Edition`);
