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

/** The directories under `programs/` that hold Program files. */
const PROGRAM_DIRECTORIES = ["majors", "minors", "certificates"];

/** Penn State's campuses, as this index names them, and how the Bulletin's
 * plan labels and Program records spell each one.
 *
 * A LIST, BECAUSE THE LABELS ARE SENTENCES. "Chemistry, B.S. at Commonwealth
 * Campuses (For Change-of-Campus students who can take CHEM 213 at their
 * Commonwealth Campus)" is one of them; so is "Nursing, B.S.N. at University
 * Park, Altoona, Erie, Fayette, Mont Alto, Schuylkill, and Scranton
 * Campuses". Cutting a label at a word gives a student "their Commonwealth
 * Campus)" as a place. Naming the places is the only reading that holds, and
 * there are twenty-one of them and two ways of saying "several".
 *
 * A campus the Bulletin adds is not dropped for being missing here:
 * `campusesOf` gives back the phrase as written, and the test that checks the
 * published index against this list fails until someone adds it. */
export const CAMPUSES = [
  ["University Park Campus", /\bUniversity Park\b/],
  ["Abington Campus", /\bAbington\b/],
  ["Altoona Campus", /\bAltoona\b/],
  ["Beaver Campus", /\bBeaver\b/],
  ["Berks Campus", /\bBerks\b/],
  ["Brandywine Campus", /\bBrandywine\b/],
  ["DuBois Campus", /\bDuBois\b/],
  ["Erie Campus", /\bErie\b/],
  ["Fayette Campus", /\bFayette\b/],
  ["Greater Allegheny Campus", /\bGreater Allegheny\b/],
  ["Harrisburg Campus", /\bHarrisburg\b/],
  // The Bulletin spells it both ways, and once without its capital.
  ["Hazleton Campus", /\bHaz(?:le|el)ton\b/i],
  ["Lehigh Valley Campus", /\bLehigh Valley\b/],
  ["Mont Alto Campus", /\bMont Alto\b/],
  ["New Kensington Campus", /\bNew Kensington\b/],
  ["Schuylkill Campus", /\bSchuylkill\b/],
  ["Scranton Campus", /\bScranton\b/],
  ["Shenango Campus", /\bShenango\b/],
  ["Wilkes-Barre Campus", /\bWilkes-Barre\b/],
  ["York Campus", /\bYork\b/],
  ["World Campus", /\bWorld Campus\b/],
  // Not places, but what the Bulletin says where a plan is for several.
  ["Commonwealth Campuses", /\bCommonwealth Campus(?:es)?\b/],
  ["All campuses", /\bAll Campuses\b/],
];

/** The campuses named in a piece of the Bulletin's text, each once, in the
 * order the text names them. */
function campusesNamedIn(text) {
  return CAMPUSES.map(([name, spelling]) => ({ name, at: text.search(spelling) }))
    .filter((found) => found.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((found) => found.name);
}

/** The campuses one suggested plan is for, from the Bulletin's label for it.
 *
 * The label reads "<Program> at <where>", with an option in front of some
 * ("Digital Media Option: Arts Administration, B.A. at Lehigh Valley Campus")
 * and a remark after others ("… at Erie Campus (3-Year Accelerated Plan)",
 * "… at New Kensington Campus with Behavioral Health and Counseling
 * Psychology Certificate"). Where the plan is for is the campuses named after
 * the first " at ", once anything in brackets and anything from " with " on
 * has been set aside: those say WHICH plan it is, or who it is for, and a
 * campus mentioned inside one ("except Altoona") is not where the plan runs.
 *
 * Nothing where the label names no place. Where it names one this list does
 * not know, the phrase comes back as the Bulletin wrote it: shown as it is,
 * not swallowed. */
export function campusesOf(label) {
  if (typeof label !== "string") return [];
  const plain = label.replace(/\([^)]*\)/g, " ");
  const at = plain.indexOf(" at ");
  if (at === -1) return [];
  const where = plain.slice(at + 4).split(" with ")[0].replace(/\s+/g, " ").trim();
  if (!where) return [];
  const named = campusesNamedIn(where);
  return named.length ? named : [where];
}

/** Joins an Edition's Programs to the Templates found for them.
 *
 * `programs` is the Edition's own index (slug, name, campuses). `templates`
 * is one entry per suggested plan that has Terms in it: the Program's slug
 * and the Bulletin's label for that plan.
 *
 * A TEMPLATE WHOSE PROGRAM THE EDITION DOES NOT HAVE IS NOT LISTED. The
 * page's one action is "Open in the planner", and the planner validates a
 * Program against this same index before it loads anything: a Template listed
 * for a Program the Edition has dropped would be a link to an error.
 *
 * A Program's campuses are those its Templates' labels name, in the
 * Bulletin's order. A Template with no place in its label takes the campus on
 * the Program's own record, where there is one: "Software Engineering, B.S."
 * at Behrend has one plan labelled for World Campus and one not labelled at
 * all, and the second is Erie's. Where neither says, nothing is guessed.
 *
 * In name order, which is the order a student looks for theirs in. */
export function templateIndex(programs, templates) {
  const labels = new Map();
  for (const template of templates) {
    if (!labels.has(template.program)) labels.set(template.program, []);
    labels.get(template.program).push(template.label);
  }
  const index = [];
  for (const program of programs) {
    const found = labels.get(program.slug);
    if (!found) continue;
    const onRecord = (program.campuses ?? []).flatMap(campusesNamedIn);
    const campuses = found.flatMap((label) => {
      const named = campusesOf(label);
      return named.length ? named : onRecord;
    });
    index.push({ program: program.slug, name: program.name, campuses: [...new Set(campuses)] });
  }
  return index.sort((a, b) => a.name.localeCompare(b.name, "en") || a.program.localeCompare(b.program, "en"));
}

/** Every Template under one Edition's directory: each suggested plan that has
 * Terms in it, as the Program it belongs to and the Bulletin's label for it.
 *
 * FOUND BY WALKING THE PROGRAM FILES, not by asking the index which ones to
 * open: the two are then independent, and `templateIndex` joining them is a
 * real check and not a formality.
 *
 * A Program file that cannot be read stops everything, and says which. The
 * other choice is an index that is quietly one Program short, on a page whose
 * whole claim is that it lists them all. */
function templatesIn(editionDir) {
  const templates = [];
  for (const sub of PROGRAM_DIRECTORIES) {
    const dir = path.join(editionDir, "programs", sub);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      let program;
      try {
        program = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      } catch (cause) {
        throw new Error(`${path.join(dir, file)} is not a Program file that can be read: ${cause.message}`);
      }
      for (const plan of program.suggestedPlans ?? []) {
        if ((plan.semesters ?? []).length) templates.push({ program: program.slug, label: plan.campusLabel ?? "" });
      }
    }
  }
  return templates;
}

/** Writes `templates/index.json` for one Edition directory, and says how many
 * Programs it listed and how many Templates it found for them. */
export function writeTemplateIndex(editionDir) {
  const programs = JSON.parse(fs.readFileSync(path.join(editionDir, "programs_index.json"), "utf-8"));
  const templates = templatesIn(editionDir);
  const index = templateIndex(programs, templates);
  const out = path.join(editionDir, "templates");
  fs.mkdirSync(out, { recursive: true });
  // One entry a line: it is committed with the catalog, and a diff of it
  // should show which Programs came and went.
  const body = `[\n${index.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`;
  fs.writeFileSync(path.join(out, "index.json"), body, "utf-8");
  return { programCount: index.length, templateCount: templates.length, bytes: Buffer.byteLength(body, "utf-8") };
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
      `templates/index.json for ${edition}: ${made.programCount} Programs with a Template ` +
        `(${made.templateCount} Templates, ${(made.bytes / 1024).toFixed(1)} KB)`,
    );
  }
}
