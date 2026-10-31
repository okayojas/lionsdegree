/** Copy pipeline-emitted catalogs into public/catalog for dev/build.
 *
 *   node scripts/sync-catalog.mjs                 # every edition in data/out
 *   node scripts/sync-catalog.mjs 2026-2027       # just this one
 *   node scripts/sync-catalog.mjs 2025-2026 2026-2027
 *
 * ADDITIVE BY CONSTRUCTION. Each edition lands in public/catalog/<edition>/ and
 * only the editions named on the command line are touched. This is not a style
 * preference: a student's degree requirements are governed by the bulletin
 * edition in force when they entered their major, so the app ships several
 * editions at once, and Penn State's archive is robots-disallowed, which means
 * an edition we drop is an edition we can never re-fetch. See
 * docs/adr/0001-forward-only-catalog-editions.md.
 *
 * The previous version of this script began with a recursive delete of the
 * whole catalog directory. Do not reintroduce that.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../../../../psu-catalog-pipeline/data/out");
const DST = path.resolve(here, "../public/catalog");

function available() {
  if (!fs.existsSync(OUT)) return [];
  return fs
    .readdirSync(OUT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(OUT, e.name, "manifest.json")))
    .map((e) => e.name)
    .sort();
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

/** The pre-multi-edition layout put courses/ and programs/ at the catalog root.
 * Those files are reproducible from data/out, so clearing them is safe — but
 * only once we have confirmed the edition they came from is still on disk. */
function clearLegacyFlatLayout() {
  const marker = path.join(DST, "manifest.json");
  if (!fs.existsSync(marker)) return;
  const edition = JSON.parse(fs.readFileSync(marker, "utf-8")).edition;
  if (!edition || !fs.existsSync(path.join(OUT, edition, "manifest.json"))) {
    console.error(
      `refusing to clear the legacy flat catalog: it is edition ${edition ?? "(unknown)"}, ` +
        `which is not in ${OUT}. Re-scrape it first, or move it aside by hand.`,
    );
    process.exit(1);
  }
  for (const entry of fs.readdirSync(DST)) {
    if (/^\d{4}-\d{4}$/.test(entry)) continue; // an edition directory, not legacy
    fs.rmSync(path.join(DST, entry), { recursive: true, force: true });
  }
  console.log(`cleared legacy flat layout (was edition ${edition}; reproduced below)`);
}

const all = available();
if (!all.length) {
  console.error(`no pipeline output found in ${OUT}`);
  process.exit(1);
}

const requested = process.argv.slice(2);
const editions = requested.length ? requested : all;

for (const edition of editions) {
  if (!all.includes(edition)) {
    console.error(`edition ${edition} not found in ${OUT} (have: ${all.join(", ")})`);
    process.exit(1);
  }
}

/** Remove course descriptions from the PUBLISHED copy.
 *
 * This is the line between the two trees, and it is the reason the strip lives
 * here rather than in the pipeline. `data/out` is everything we parsed: the
 * descriptions stay there, because keyword extraction and the search index are
 * both built from them. `public/catalog` is what we PUBLISH, and the
 * descriptions are Penn State's prose (DECISIONS.md 5.1).
 *
 * Not displaying them was never enough. These are static files served to
 * anyone who asks; shipping the bytes and declining to render them is still
 * distribution, with devtools one keystroke away. The only version of "we keep
 * it internally" that means anything is the version where it does not leave
 * the build.
 *
 * What replaces it for a student: `keywords` says what the course covers and
 * `url` links to the Bulletin page the prose lives on.
 */
function stripDescriptions(editionDir) {
  let bytes = 0;
  for (const sub of [["courses"], ["courses", "grad"]]) {
    const dir = path.join(editionDir, ...sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const file = path.join(dir, f);
      const courses = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!Array.isArray(courses)) continue;
      let touched = false;
      for (const c of courses) {
        if (typeof c?.description === "string" && c.description) {
          bytes += c.description.length;
          delete c.description;
          touched = true;
        }
      }
      if (touched) fs.writeFileSync(file, JSON.stringify(courses, null, 1), "utf-8");
    }
  }
  return bytes / 1048576;
}

fs.mkdirSync(DST, { recursive: true });
clearLegacyFlatLayout();

for (const edition of editions) {
  const src = path.join(OUT, edition);
  const dst = path.join(DST, edition);
  fs.rmSync(dst, { recursive: true, force: true }); // this edition only
  fs.cpSync(src, dst, { recursive: true });
  // `search-index.json` is built for the MCP package, which bundles its own
  // catalog and has no boot-time constraint. The web app must never see it:
  // it carries every field of every course plus the search postings in one
  // 2.4 MB file, and the whole of #24 was that file sitting on the path
  // every student waits on. Excluded here rather than hoped-about, because
  // a recursive copy has no opinion about what it carries.
  for (const mcpOnly of ["search-index.json"]) {
    fs.rmSync(path.join(dst, mcpOnly), { force: true });
  }
  const stripped = stripDescriptions(dst);
  console.log(`synced ${edition} (${countFiles(dst)} files, ${stripped.toFixed(1)} MB of description prose withheld)`);
}

// Every edition now published, newest last. The app reads this to populate the
// onboarding edition picker, so it must describe what is on disk rather than
// what this run happened to sync.
const published = fs
  .readdirSync(DST, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(DST, e.name, "manifest.json")))
  .map((e) => e.name)
  .sort();

const index = {
  note:
    "Editions ship forward-only; Penn State's bulletin archive is robots-disallowed, " +
    "so an edition absent here cannot be backfilled. See docs/adr/0001.",
  editions: published,
  latest: published[published.length - 1],
};
fs.writeFileSync(path.join(DST, "editions.json"), JSON.stringify(index, null, 1), "utf-8");
console.log(`editions.json -> [${published.join(", ")}], latest ${index.latest}`);
