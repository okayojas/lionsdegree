/** What one Edition costs to hold in memory.
 *
 *   node --expose-gc --import tsx scripts/measure-memory.mts
 *
 * WHY THIS IS A SCRIPT AND NOT A COMMENT. ADR 0002: ceilings are measured,
 * never guessed, and the figure goes in the commit. A number that exists
 * only as commit prose cannot be re-checked by the next person to touch
 * the loader — which is exactly when it matters, because the constraint
 * is hard: a Cloudflare isolate has 128 MB and the pre-#31 loader took 64
 * MB of heap for the catalog alone.
 *
 * HEAP, not RSS. A Node process's resident size includes the runtime
 * itself and whatever the allocator has not returned, so it says more
 * about Node than about this catalog; the isolate limit is on the objects.
 * RSS is printed alongside for context, not as the figure under test.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsCatalogSource } from "../src/source.js";
import { loadEdition } from "../src/catalog.js";

if (typeof global.gc !== "function") {
  console.error("run with --expose-gc, or the numbers are whatever the collector felt like");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const mb = (n: number) => (n / 1048576).toFixed(1).padStart(6);
const heap = () => {
  global.gc!();
  return process.memoryUsage().heapUsed;
};

const source = new FsCatalogSource(CATALOG);
const edition = (await source.editions()).pop();
if (!edition) {
  console.error("no catalog — run `node scripts/sync-catalog.mjs` first");
  process.exit(1);
}

const base = heap();
const t0 = Date.now();
const ed = await loadEdition(source, edition);
const loaded = heap();
console.log(`edition ${edition}`);
console.log(`  audit index + programs (${Object.keys(ed.catalog).length} courses)  ${mb(loaded - base)} MB   ${Date.now() - t0} ms`);

// A representative Plan's worth: a handful of subjects plus the one hop
// their prerequisites pull in.
await ed.ensureCourses(["MATH 141", "PHYS 212", "CMPSC 465", "ESC 261", "EE 210"]);
console.log(`  + a plan's subjects and their one hop        ${mb(heap() - base)} MB`);

await ed.ensureSearchRanking();
console.log(`  + search ranking (only if somebody searches) ${mb(heap() - base)} MB`);
console.log(`  process RSS, for context only                ${mb(process.memoryUsage().rss)} MB`);
console.log(`\nCeiling: a Cloudflare isolate has 128 MB. Before #31 the catalog alone took 64 MB of heap.`);
