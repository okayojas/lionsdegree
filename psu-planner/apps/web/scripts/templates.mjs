/** Templates, as the web catalog publishes them: which Programs in an Edition
 * have a suggested plan and for which campuses, and each one's plan Term by
 * Term.
 *
 * The Sample plans page lists every Program that has a Template and shows the
 * one a student chooses (#60, #67, #68). A Program's own file holds all of
 * it, deep inside a much larger record; the page needs the list for all of
 * them at once, and then one Program's Terms and nothing more. So both are
 * published beside the catalog, per Edition:
 *
 *   public/catalog/<edition>/templates/index.json
 *   [{ "program": "abington-accounting-bs",
 *      "name": "Accounting, B.S. (Abington)",
 *      "campuses": ["Abington Campus"] }, ...]
 *
 *   public/catalog/<edition>/templates/<program>.json
 *   { "program": "abington-accounting-bs",
 *     "bulletin": "https://bulletins.psu.edu/undergraduate/colleges/abington/accounting-bs/",
 *     "templates": [{ "label": "Accounting, B.S. at Abington Campus",
 *                     "credits": 120,
 *                     "terms": [{ "label": "Year 1 Fall", "credits": 15,
 *                                 "entries": [{ "course": "ENGL 15", "credits": 3, "or": ["ENGL 30H"] },
 *                                             { "slot": "General Education Course (GN)", "credits": 3 }] }] }] }
 *
 * WHAT IS IN THEM, AND WHAT IS NOT. The index: identifiers, names and
 * campuses. A Program's file: where its page is in the Bulletin, the
 * Bulletin's name for each of its plans, the Terms in order, and in each Term
 * the Course codes, the credits, and the Bulletin's own label for each choice
 * it leaves open. Not the footnotes or their marks, not a Course's title or
 * description, and not the remarks the Bulletin puts in some Terms ("Take
 * PECT exams..."): those are its sentences, so a file says a note is there
 * and the page sends the student to the Bulletin to read it. What may be
 * republished is narrow (DECISIONS 5.1), and a grid of codes and labels is on
 * the right side of that line.
 *
 * Written by scripts/sync-catalog.mjs for every Edition it syncs. Run on its
 * own, it writes them for every Edition already in public/catalog, from the
 * Program files published there:
 *
 *   node scripts/templates.mjs
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

/** A Program's suggested plans that have Terms in them. One with none is not
 * a plan anyone can be shown, and is not a Template. */
const plansWithTerms = (program) => (program.suggestedPlans ?? []).filter((plan) => (plan.semesters ?? []).length > 0);

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

/** A Slot's label without the Bulletin's footnote marks.
 *
 * The marks ("IST 140*# or CMPSC 121 (GQ)") point at notes under the plan,
 * and the notes are not published: a mark left in would point at nothing. A
 * "#" in front of a number is not a mark ("Option Course #3") and stays. */
const withoutFootnoteMarks = (label) =>
  label
    .replace(/[*\u2020\u2021]/g, "")
    .replace(/#(?!\d)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,;)])/g, "$1")
    .trim();

/** The Edition's own code for a code a plan writes, or null where it has no
 * such Course. The same code, or the same with the number written plainly:
 * the Bulletin's plans say "BISC 004" for the Course its catalog lists as
 * "BISC 4". Nothing looser than that: a near miss is not a match. */
function listedAs(code, courseCodes) {
  if (courseCodes.has(code)) return code;
  const plain = code.replace(/ 0+(?=\d)/, " ");
  return courseCodes.has(plain) ? plain : null;
}

/** One line of a Term, as it is published.
 *
 * A COURSE THE BULLETIN NAMES is `{ course, credits, or }`: its code, and the
 * codes the Bulletin offers in its place ("ENGL 15 or ENGL 30H"). The code is
 * the one the catalog's record of the plan carries, which is the Edition's
 * own: where the Bulletin's plan writes "CAS 100" and its catalog lists CAS
 * 100A, 100B, 100C and 100S, the record already names those four, and so does
 * this.
 *
 * A CHOICE IT LEAVES OPEN is a Slot, `{ slot, credits }`, with the Bulletin's
 * own label for it and nothing else. No Course is put in it, here or on the
 * page: which Course fills a Slot is the student's to decide, in the planner.
 * Many of the Bulletin's labels name Courses themselves ("STAT 200 or SCM 200
 * or DS 200"); that is the Bulletin listing what it would accept, and it is
 * kept as it wrote it.
 *
 * A REMARK is `{ note: true }` and no more. Some lines are not a Course and
 * not a choice: "Take PECT exams (not required for graduation...)", "Enter
 * the major before the end of this semester...". They are told apart by what
 * a Slot is (a requirement with credits behind it): a line the Bulletin gives
 * no credits and the catalog does not count as General Education is a remark.
 * Its text is the Bulletin's sentence, and is not copied.
 *
 * A CODE THE EDITION DOES NOT HAVE is `{ unlisted, credits }`. The Bulletin's
 * plans name a few Courses its own catalog no longer lists ("LA 283"), and
 * calling one a Course would be a claim this Edition cannot back. It is
 * published as what it is: a code the Bulletin wrote, flagged. The same goes
 * for an alternative (`orUnlisted`).
 *
 * Credits are the Bulletin's figure, nought included, and are left off where
 * it gives none. */
function publishedEntry(entry, courseCodes) {
  const credits = typeof entry.credits === "number" ? { credits: entry.credits } : {};
  if (entry.type !== "course") {
    if (entry.type !== "genEd" && typeof entry.credits !== "number") return { note: true };
    return { slot: withoutFootnoteMarks(String(entry.label ?? "")), ...credits };
  }
  const listed = listedAs(entry.code, courseCodes);
  const alternatives = (entry.alternatives ?? []).map((code) => ({ code, listed: listedAs(code, courseCodes) }));
  const or = alternatives.filter((alternative) => alternative.listed).map((alternative) => alternative.listed);
  const orUnlisted = alternatives.filter((alternative) => !alternative.listed).map((alternative) => alternative.code);
  return {
    ...(listed ? { course: listed } : { unlisted: entry.code }),
    ...credits,
    ...(or.length ? { or } : {}),
    ...(orUnlisted.length ? { orUnlisted } : {}),
  };
}

/** Where a Program's page is in the Bulletin, if its record says and it is
 * there. Nothing else is ever published as a link. */
const bulletinPage = (program) =>
  typeof program.url === "string" && program.url.startsWith("https://bulletins.psu.edu/") ? { bulletin: program.url } : {};

/** A Program's Templates, as its file under `templates/` carries them, or
 * null where it has none.
 *
 * `program` is the Program's own record from the catalog. `courseCodes` is
 * every Course code the Edition has. */
export function templateFile(program, courseCodes) {
  const plans = plansWithTerms(program);
  if (!plans.length) return null;
  return {
    program: program.slug,
    ...bulletinPage(program),
    templates: plans.map((plan) => ({
      // The Bulletin's name for this plan, which is all that tells a
      // Program's plans apart: its option and its campus. Empty where the
      // Bulletin gives it none.
      label: plan.campusLabel ?? "",
      ...(typeof plan.totalCredits === "number" ? { credits: plan.totalCredits } : {}),
      terms: plan.semesters.map((term) => ({
        label: term.label,
        ...(typeof term.credits === "number" ? { credits: term.credits } : {}),
        entries: (term.entries ?? []).map((entry) => publishedEntry(entry, courseCodes)),
      })),
    })),
  };
}

/** Every Program file under one Edition's directory.
 *
 * FOUND BY WALKING THE DIRECTORIES, not by asking the index which files to
 * open: the two are then independent, and `templateIndex` joining them is a
 * real check and not a formality.
 *
 * A Program file that cannot be read stops everything, and says which. The
 * other choice is an index that is quietly one Program short, on a page whose
 * whole claim is that it lists them all. */
function programsIn(editionDir) {
  const programs = [];
  for (const sub of PROGRAM_DIRECTORIES) {
    const dir = path.join(editionDir, "programs", sub);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        programs.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")));
      } catch (cause) {
        throw new Error(`${path.join(dir, file)} is not a Program file that can be read: ${cause.message}`);
      }
    }
  }
  return programs;
}

/** Every Course code an Edition has, from the index of them it ships. */
function courseCodesIn(editionDir) {
  const { courses } = JSON.parse(fs.readFileSync(path.join(editionDir, "audit-index.json"), "utf-8"));
  return new Set(courses.map((course) => course.code));
}

/** Writes an Edition's Templates: `index.json`, and a file for each Program
 * the index lists. Says how many Programs and how many Templates.
 *
 * Into `templates/` under the Edition unless told otherwise. That directory
 * is emptied first: a file left from a Program the Bulletin has dropped would
 * be a Template published for a Program the Edition does not have. */
export function writeTemplates(editionDir, into = path.join(editionDir, "templates")) {
  const index = JSON.parse(fs.readFileSync(path.join(editionDir, "programs_index.json"), "utf-8"));
  const programs = programsIn(editionDir);
  const courseCodes = courseCodesIn(editionDir);

  const files = new Map();
  for (const program of programs) {
    const file = templateFile(program, courseCodes);
    if (file) files.set(program.slug, file);
  }
  const listed = templateIndex(
    index,
    [...files.values()].flatMap((file) => file.templates.map((template) => ({ program: file.program, label: template.label }))),
  );

  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });
  // One entry a line: it is committed with the catalog, and a diff of it
  // should show which Programs came and went.
  fs.writeFileSync(path.join(into, "index.json"), `[\n${listed.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`, "utf-8");
  let bytes = 0;
  let templateCount = 0;
  for (const { program } of listed) {
    const body = `${JSON.stringify(files.get(program))}\n`;
    fs.writeFileSync(path.join(into, `${program}.json`), body, "utf-8");
    bytes += Buffer.byteLength(body, "utf-8");
    templateCount += files.get(program).templates.length;
  }
  return { programCount: listed.length, templateCount, bytes };
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
    const made = writeTemplates(path.join(catalog, edition));
    console.log(
      `templates for ${edition}: ${made.programCount} Programs, ${made.templateCount} Templates, ` +
        `${(made.bytes / 1024 / 1024).toFixed(2)} MB in ${made.programCount} files beside the index`,
    );
  }
}
