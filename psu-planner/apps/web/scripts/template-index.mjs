/** The Template index: which Programs in an Edition publish a suggested plan,
 * and for which campuses.
 *
 * The Sample plans page lists every Program that has a Template (#60, #67).
 * A Program's own file says so, deep inside it; the page needs the answer for
 * all of them at once, without fetching several hundred files to ask. So the
 * answer is published beside the catalog, one small file per Edition:
 *
 *   public/catalog/<edition>/templates/index.json
 *   [{ "program": "abington-accounting-bs",
 *      "name": "Accounting, B.S. (Abington)",
 *      "campuses": ["Abington Campus"] }, ...]
 *
 * IDENTIFIERS, NAMES AND CAMPUSES, AND NOTHING ELSE. No Course codes, no
 * credits, and above all none of the Bulletin's prose: what may be republished
 * from it is narrow (DECISIONS 5.1), and a list of which Programs have a plan
 * is on the right side of that line.
 *
 * Written by scripts/sync-catalog.mjs for every Edition it syncs. Run on its
 * own, it writes the index for every Edition already in public/catalog, from
 * the Program files published there:
 *
 *   node scripts/template-index.mjs
 *
 * Plain JavaScript with no dependencies, like firstSentence.mjs, because the
 * sync script that calls it is.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where a Program's file lives, by what kind of Program it is. */
const DIR = { major: "majors", minor: "minors", certificate: "certificates" };

/** The campus a suggested plan is for, in the Bulletin's own words.
 *
 * The Bulletin labels each plan "<Program> at <campus>", sometimes with an
 * option in front ("Digital Media Option: Arts Administration, B.A. at Lehigh
 * Valley Campus"). The campus is whatever follows the LAST " at ". It is not
 * tidied or split: "Erie Campus and World Campus" is what the Bulletin says
 * the plan is for, and a list we rebuilt from it would be ours, not theirs.
 *
 * Returns null where the label names no campus. A few do not. */
export function campusOf(label) {
  const at = typeof label === "string" ? label.lastIndexOf(" at ") : -1;
  const campus = at === -1 ? "" : label.slice(at + 4).trim();
  return campus || null;
}

/** Joins an Edition's Programs to the suggested plans found for them.
 *
 * `programs` is the Edition's own index (slug, name, campuses). `plans` is
 * one entry per suggested plan that has Terms in it: the Program's slug and
 * the Bulletin's label for that plan.
 *
 * A PLAN WHOSE PROGRAM THE EDITION DOES NOT HAVE IS NOT LISTED. The page's
 * one action is "Open in the planner", and the planner validates a Program
 * against this same index before it loads anything: a Template listed for a
 * Program the Edition has dropped would be a link to an error.
 *
 * In name order, which is the order a student looks for theirs in. */
export function templateIndex(programs, plans) {
  const labels = new Map();
  for (const plan of plans) {
    if (!labels.has(plan.program)) labels.set(plan.program, []);
    labels.get(plan.program).push(plan.label);
  }
  const index = [];
  for (const program of programs) {
    const found = labels.get(program.slug);
    if (!found) continue;
    // Each campus once, in the order the Bulletin lists its plans.
    let campuses = [...new Set(found.map(campusOf).filter(Boolean))];
    // Where no plan's label names a campus, the Program's own record may.
    if (!campuses.length) campuses = [...(program.campuses ?? [])];
    index.push({ program: program.slug, name: program.name, campuses });
  }
  return index.sort((a, b) => a.name.localeCompare(b.name, "en") || a.program.localeCompare(b.program, "en"));
}

/** Every suggested plan with Terms in it, under one Edition's directory.
 *
 * FOUND BY WALKING THE PROGRAM FILES, not by asking the index which ones to
 * open: the two are then independent, and `templateIndex` joining them is a
 * real check and not a formality. An unreadable file is skipped and counted;
 * one bad Program must not stop an Edition's index being written. */
function plansIn(editionDir) {
  const plans = [];
  let unreadable = 0;
  for (const sub of Object.values(DIR)) {
    const dir = path.join(editionDir, "programs", sub);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      let program;
      try {
        program = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      } catch {
        unreadable++;
        continue;
      }
      for (const plan of program.suggestedPlans ?? []) {
        if ((plan.semesters ?? []).length) plans.push({ program: program.slug, label: plan.campusLabel ?? "" });
      }
    }
  }
  return { plans, unreadable };
}

/** Writes `templates/index.json` for one Edition directory, and says what it
 * found. */
export function writeTemplateIndex(editionDir) {
  const programs = JSON.parse(fs.readFileSync(path.join(editionDir, "programs_index.json"), "utf-8"));
  const { plans, unreadable } = plansIn(editionDir);
  const index = templateIndex(programs, plans);
  const out = path.join(editionDir, "templates");
  fs.mkdirSync(out, { recursive: true });
  // One entry a line: it is committed with the catalog, and a diff of it
  // should show which Programs came and went.
  const body = `[\n${index.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`;
  fs.writeFileSync(path.join(out, "index.json"), body, "utf-8");
  return { programs: index.length, plans: plans.length, unreadable, bytes: body.length };
}

// Run directly: every Edition already published.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const catalog = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/catalog");
  const editions = fs
    .readdirSync(catalog, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(catalog, e.name, "programs_index.json")))
    .map((e) => e.name)
    .sort();
  for (const edition of editions) {
    const made = writeTemplateIndex(path.join(catalog, edition));
    console.log(
      `templates/index.json for ${edition}: ${made.programs} Programs with a Template (${made.plans} plans, ` +
        `${made.unreadable} unreadable files, ${(made.bytes / 1024).toFixed(1)} KB)`,
    );
  }
}
