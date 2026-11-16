/** Checks the landing page's sample Plan against the latest Edition.
 *
 * Runs before every build and before the dev server (`prepage`). The landing
 * page prints 48 Course codes and one Program, and the same file holds 48
 * more for the scene to show. A name on the front page is a claim: if the
 * Bulletin retires CMPSC 461, the page must stop saying it before a student
 * sees it, not after one writes in. So this does not warn. `assertSamplePlan`
 * throws, nothing here catches it, the script exits non-zero, and the build
 * stops with the list of what no longer matches.
 *
 * The check itself is in src/landing/sample-plan.ts, beside the data.
 *
 *   tsx scripts/sample-plan.mts                  # the shipped catalog
 *   tsx scripts/sample-plan.mts --catalog <dir>  # another one
 *
 * `--catalog` is how the unit suite shows the build stopping: it points this
 * script at a catalog that lacks a Course and reads the exit code.
 */
import { SAMPLE_PLAN, assertSamplePlan } from "../src/landing/sample-plan.js";
import { CATALOG_ROOT, courseCodes, latestEdition, programSlugs } from "./catalog-programs.mjs";

const flag = process.argv.indexOf("--catalog");
const root = flag === -1 ? CATALOG_ROOT : process.argv[flag + 1];
if (!root) throw new Error("--catalog needs a directory");

const edition = latestEdition(root);
const courses = courseCodes(edition, root);
const programs = programSlugs(edition, root);

assertSamplePlan(SAMPLE_PLAN, {
  edition,
  hasCourse: (code) => courses.has(code),
  hasProgram: (id) => programs.has(id),
});

const named = SAMPLE_PLAN.terms.reduce((n, term) => n + term.courses.length, 0) + SAMPLE_PLAN.others.length;
console.log(`sample-plan: ${SAMPLE_PLAN.title}, ${named} Courses, all in the ${edition} Edition`);
