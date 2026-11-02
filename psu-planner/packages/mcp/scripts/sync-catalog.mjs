/** Copy the catalog files this package ships into ./catalog.
 *
 * Source is the WEB app's published catalog, not the pipeline's raw output,
 * and that is deliberate: the web copy has already had Penn State's
 * description prose stripped out of it (DECISIONS.md 5.1). Copying from
 * `data/out` instead would quietly put 20 MB of the Bulletin's own text
 * into an npm package. The boundary holds by construction here rather than
 * by remembering to strip.
 *
 * WHAT CHANGED IN #31. This used to copy `search-index.json` — every field
 * of every Course plus the search postings, in one 11 MB file. Two things
 * were wrong with that. The server held all of it resident (64 MB of heap,
 * 138 MB RSS) which a 128 MB Cloudflare isolate cannot do; and #29 deleted
 * that file from the web catalog, so this script had been silently copying
 * nothing for a release and the shipped catalog was stale.
 *
 * It now ships the artifacts the planner's own boot work produced:
 *
 *   audit-index.json      every Course, slim. Always loaded.
 *   courses/              prerequisite structure, keywords, bulletin URLs,
 *                         one subject per file. Read on demand.
 *   search-postings.json  description ranking. Read on first search.
 *
 * Bigger on disk, a fraction of it resident. Not the suggested-plan grids,
 * which describe a schedule the student already has.
 *
 * WHAT CHANGED IN #48, and what it cost. The connector could not attach an
 * Integrated Undergraduate-Graduate degree because no `iug/` ever reached
 * this tree -- the planner read it from the web catalog and the Worker had
 * no equivalent. MEASURED before it was added, because a Cloudflare isolate
 * has 128 MB and this script is the only place that decides what has to fit
 * in it (ADR 0002). Measured by `npm run measure-memory`, 2026-11-02:
 *
 *   iug/ on disk, per Edition      24,766 bytes raw / 5,202 gzipped, 4 files
 *                                  (49,532 / 10,404 across both Editions)
 *   iug/index.json                 927 bytes, the only read an isolate makes
 *                                  before a student asks for an IUG
 *   all 3 specs + every graduate
 *     subject they name, resident  14.1 MB, against 13.8 MB for the same
 *                                  Plan without one. A delta of 0.3 MB.
 *   same isolate having searched   44.2 MB, so 83.8 MB of headroom remains.
 *
 * The data this ticket adds is 0.02% of the Edition on disk and 2% of one
 * Plan's resident footprint. The reason it is that cheap is worth writing
 * down, because the ticket was costed as though it were expensive: the
 * graduate COURSES an attach needs were already shipping inside `courses/`,
 * which `loadSubject` has resolved as `PREFIX:grad` since #31. Only the
 * programs themselves were missing, and a program is a page of JSON.
 *
 * WHAT CHANGED IN #47. "Not the suggested-plan grids, which describe a
 * schedule the student already has" was true for as long as the connector
 * could only read a Plan that already existed. #47 lets a student declare a
 * NEW Program from the chat, and `addProgram` folds that Program's grid into
 * their existing Terms -- so without the grids the connector would add a
 * major and place none of its courses, which is a different answer from the
 * planner's for the same action. The grid is what a Program's first two
 * years actually look like; dropping it would leave the two surfaces
 * disagreeing about what "add a minor" means, which is the one thing #39
 * exists to prevent.
 *
 * DERIVED, NOT COPIED, and this is the only derivation in this script.
 * Copying `programs/` whole would be 12.6 MB per Edition, almost all of it
 * `requirementSections` that `program-requirements.json` already ships --
 * the same requirements twice, free to drift. So `plans/<slug>.json` carries
 * the grid and nothing else, and the loader pairs it with the requirements
 * already here. MEASURED, before it was added (ADR 0002), 2026-11-02:
 *
 *   programs/ copied whole           12.56 MB per Edition
 *   all suggestedPlans, grids only    4.56 MB per Edition
 *   plans/ as shipped                 1.62 MB raw / 0.26 MB gzipped,
 *                                     383 files (381 for 2025-2026)
 *   largest single file               7 KB (arts-architecture-music-
 *                                     education-bme)
 *   resident cost per declaration     one file, so 7 KB at the worst
 *
 * Only the FIRST published grid, which is the one `templateFor` in the
 * planner uses: onboarding asks which campus plan to start from, a Program
 * declared later does not, and the optimizer re-flows whatever it gets
 * against the Plan it is joining. Shipping every campus variant would be
 * 2.8x the bytes for a choice neither surface offers.
 *
 * 376 of the 759 Programs publish no grid at all -- most minors and
 * certificates contribute requirements only -- and they get no file. An
 * absent `plans/` entry means "this Program publishes no grid", which is
 * what the planner already does with `semesters: []`, NOT "we could not
 * read it".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../../apps/web/public/catalog");
const DST = path.resolve(here, "../catalog");

/** Flat files, copied as-is. */
const FILES = [
  "audit-index.json",
  "search-postings.json",
  "program-requirements.json",
  "programs_index.json",
  // Where each subject's course file actually lives. Without it the server
  // cannot locate a single one -- the names are lower-cased and sometimes
  // slugged (AI -> a-i.json), so they cannot be derived from the code.
  "subjects_index.json",
  "coverage.json",
];

/** Directories copied whole, one file per subject.
 *
 * `iug/` is NOT a subject directory and is here for a different reason: it
 * is `index.json` plus one file per Integrated Undergraduate-Graduate
 * program, and without it the connector can only tell a student that no IUG
 * exists -- which is false, and the kind of confident wrong answer this
 * package refuses (iron rule 2).
 *
 * IT CARRIES BULLETIN PROSE ON PURPOSE, which is the one place this script's
 * other rule does not apply. `assertNoDescriptions` strips Penn State's
 * COURSE descriptions (DECISIONS.md 5.1) and still runs over these files; it
 * passes because an IUG spec is an object rather than a course list. The
 * `applyText` it carries is graduate POLICY text, and policy text is quoted
 * verbatim by deliberate decision (CONTEXT.md, GCAC-210): a student checking
 * a citation against the Graduate Bulletin has to find the same words.
 * Paraphrasing it here would silently break every citation the connector
 * makes. It is fenced where it reaches a model, not rewritten. */
const DIRS = ["courses", "iug"];

/** An Edition is unusable without these. Listing it in editions.json anyway
 * shipped a server that started fine and then told every student their
 * Courses do not exist — a confident wrong answer, which is the one failure
 * this package refuses (iron rule 2). */
const REQUIRED = ["audit-index.json", "program-requirements.json", "subjects_index.json"];

if (!fs.existsSync(SRC)) {
  console.error(`no catalog at ${SRC} — run the web app's sync-catalog first`);
  process.exit(1);
}

fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });

const editions = fs
  .readdirSync(SRC, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^\d{4}-\d{4}$/.test(e.name))
  .map((e) => e.name)
  .sort();

function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
}

/** Guard rather than trust. The web catalog is stripped today, but this
 * package publishes to npm and a regression upstream would ship the
 * Bulletin's prose under our name. Checked here because here is the last
 * point before it leaves the build. */
function assertNoDescriptions(dir, edition) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      assertNoDescriptions(p, edition);
      continue;
    }
    if (!e.name.endsWith(".json")) continue;
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    // Both shapes. A bare array is a subject file; `{courses: [...]}` is
    // the audit index. Skipping the second meant the guard did not cover
    // the one file every Edition is required to ship.
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.courses) ? parsed.courses : null;
    if (!rows) continue;
    const leaked = rows.filter((c) => typeof c?.description === "string" && c.description.length);
    if (leaked.length) {
      console.error(
        `refusing to ship ${edition}: ${path.basename(p)} carries ${leaked.length} course descriptions. ` +
          `That is Penn State's prose (DECISIONS.md 5.1) and must not leave the build. ` +
          `Re-run the web app's sync-catalog, which strips it.`,
      );
      process.exit(1);
    }
  }
}

/** The grid half of every Program that publishes one, written to
 * `plans/<slug>.json` (#47).
 *
 * WHY THE INDEX RATHER THAN A DIRECTORY WALK: `programs_index.json` is what
 * says whether a slug is a major, a minor or a certificate, and that is the
 * subdirectory the file is in. Deriving the path from the slug is not
 * possible, which is the same reason `subjects_index.json` ships.
 *
 * A Program the index names but whose file is missing or unreadable is
 * SKIPPED, not failed: the connector reads an absent grid as "this Program
 * publishes none", the same thing the planner does, and one unreadable
 * program must not stop an Edition shipping. It is counted and reported so
 * a number that starts climbing is visible. */
function writePlanGrids(srcEdition, dstEdition) {
  const indexPath = path.join(srcEdition, "programs_index.json");
  if (!fs.existsSync(indexPath)) return { files: 0, bytes: 0, unreadable: 0, noGrid: 0 };
  const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  const DIR = { major: "majors", minor: "minors", certificate: "certificates" };

  const out = path.join(dstEdition, "plans");
  let files = 0;
  let bytes = 0;
  let unreadable = 0;
  let noGrid = 0;

  for (const entry of index) {
    const sub = DIR[entry?.type];
    if (!sub || typeof entry.slug !== "string") continue;
    const from = path.join(srcEdition, "programs", sub, `${entry.slug}.json`);
    let program;
    try {
      program = JSON.parse(fs.readFileSync(from, "utf-8"));
    } catch {
      unreadable++;
      continue;
    }
    const grid = (program.suggestedPlans ?? []).find((s) => (s.semesters ?? []).length);
    if (!grid) {
      noGrid++;
      continue;
    }
    // THE GRID AND NOTHING ELSE. `footnotes` is Bulletin prose and the
    // engine's ProgramTemplate has no field for it; `totalCredits` and the
    // name are already in `program-requirements.json`. Writing a field
    // nobody reads is a field that eventually gets read.
    const body = JSON.stringify({
      slug: program.slug,
      campusLabel: grid.campusLabel ?? "",
      semesters: grid.semesters,
    });
    if (!files) fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${entry.slug}.json`), body);
    files++;
    bytes += body.length;
  }
  return { files, bytes, unreadable, noGrid };
}

let total = 0;
const usable = [];
const grids = { files: 0, bytes: 0, unreadable: 0 };

for (const ed of editions) {
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(SRC, ed, f)));
  if (missing.length) {
    console.warn(`skipping ${ed}: missing ${missing.join(", ")} — run the pipeline for this edition first`);
    continue;
  }
  fs.mkdirSync(path.join(DST, ed), { recursive: true });

  for (const f of FILES) {
    const from = path.join(SRC, ed, f);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(DST, ed, f));
    total += fs.statSync(from).size;
  }

  // Written before the prose guard runs, so the derived grids are checked
  // by it like everything else. They carry course CODES and no text, but
  // "it cannot contain prose" is a claim about upstream, and upstream is
  // the thing this guard exists not to trust.
  const g = writePlanGrids(path.join(SRC, ed), path.join(DST, ed));
  grids.files += g.files;
  grids.bytes += g.bytes;
  grids.unreadable += g.unreadable;
  total += g.bytes;
  if (g.unreadable) {
    console.warn(
      `${ed}: ${g.unreadable} program(s) named by the index could not be read, so they ship no ` +
        `suggested-plan grid — the connector will add them as requirements only`,
    );
  }

  // Checked across the WHOLE Edition, flat files included -- the guard
  // used to run only over the directories, so the audit index was never
  // looked at.
  assertNoDescriptions(path.join(DST, ed), ed);

  for (const d of DIRS) {
    const from = path.join(SRC, ed, d);
    if (!fs.existsSync(from)) continue;
    assertNoDescriptions(from, ed);
    fs.cpSync(from, path.join(DST, ed, d), { recursive: true });
    total += dirSize(from);
  }

  usable.push(ed);
}

if (!usable.length) {
  console.error("no usable edition was copied — the server would start and then answer nothing");
  process.exit(1);
}

// Written rather than inferred. A fetch-backed source cannot list a
// directory, so this file is the only way the hosted connector learns which
// Editions exist — and both sources read it the same way.
fs.writeFileSync(
  path.join(DST, "editions.json"),
  JSON.stringify({ editions: usable, latest: usable[usable.length - 1] }, null, 1),
);

console.log(
  `catalog: ${usable.length} edition(s) [${usable.join(", ")}], ${(total / 1048576).toFixed(1)} MB on disk`,
);
console.log(
  `suggested-plan grids: ${grids.files} file(s), ${(grids.bytes / 1048576).toFixed(2)} MB across ` +
    `${usable.length} edition(s)`,
);
