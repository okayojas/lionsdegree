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
  "coverage.json",
];

/** Directories copied whole, one file per subject. */
const DIRS = ["courses"];

/** An Edition is unusable without these. Listing it in editions.json anyway
 * shipped a server that started fine and then told every student their
 * Courses do not exist — a confident wrong answer, which is the one failure
 * this package refuses (iron rule 2). */
const REQUIRED = ["audit-index.json", "program-requirements.json"];

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
    const rows = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!Array.isArray(rows)) continue;
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

let total = 0;
const usable = [];

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
