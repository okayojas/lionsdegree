/** Copy the catalog files this package ships into ./catalog.
 *
 * Only what a READ-ONLY server reads: the search index, each program's
 * requirements, the program list and the coverage map. Not courses/ (20 MB of
 * full descriptions the index already summarises) and not the suggested-plan
 * grids, which describe a schedule the student already has. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../../apps/web/public/catalog");
const DST = path.resolve(here, "../catalog");
const FILES = ["search-index.json", "program-requirements.json", "programs_index.json", "coverage.json"];

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

// An edition is unusable without these two. Listing it in editions.json
// anyway shipped a server that started fine and then told every student
// their courses do not exist.
const REQUIRED = ["search-index.json", "program-requirements.json"];

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
  usable.push(ed);
}
if (!usable.length) {
  console.error("no usable edition found — refusing to write an editions.json that promises catalogs this server does not have");
  process.exit(1);
}
fs.writeFileSync(
  path.join(DST, "editions.json"),
  JSON.stringify({ editions: usable, latest: usable[usable.length - 1] }),
  "utf-8",
);
console.log(`bundled ${usable.length} edition(s): ${usable.join(", ")} — ${(total / 1048576).toFixed(1)} MB`);
