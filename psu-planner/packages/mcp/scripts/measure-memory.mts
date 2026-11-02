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

// An IUG attach, measured on the SAME heap as the plan above it, because
// that is the situation: a student attaching a master's already has a
// bachelor's plan loaded. #48 was allowed to ship on this line — the
// question it answers is whether shipping `iug/` can push a Worker that is
// already near 128 MB over it, and the honest comparison is the delta from
// the line above, not a fresh process.
//
// The index is the only EAGER read; a program spec and its graduate
// subjects load on demand, so the second figure is the worst case of one
// attach rather than a standing cost.
const iugIndex = await source.read<{ slug: string }[]>(`${edition}/iug/index.json`);
if (!iugIndex?.length) {
  console.log(`  + IUG: this edition ships none — re-run scripts/sync-catalog.mjs`);
} else {
  const beforeIug = heap() - base;
  // EVERY program, cumulatively, in one isolate. Not one attach: an isolate
  // serves many students, so the figure that matters is what it holds once
  // it has seen all of them. Measuring a single attach would report a
  // ceiling the real server never lives under.
  let worst = { slug: "", cost: -1 };
  for (const { slug } of iugIndex) {
    const spec = await source.read<{
      doubleCount: { eligible: string[] };
      gradTracks: { sections: { rules: Record<string, unknown>[] }[] }[];
    }>(`${edition}/iug/${slug}.json`);
    if (!spec) continue;
    // Exactly the codes `attachIugNow` resolves before it folds the grad
    // half on; anything less would under-report the subject files pulled in.
    const codes = [
      ...spec.doubleCount.eligible,
      ...spec.gradTracks.flatMap((t) =>
        t.sections.flatMap((s) =>
          s.rules.flatMap((r) =>
            r.type === "course" ? [r.code as string] : Array.isArray(r.options) ? (r.options as string[]) : [],
          ),
        ),
      ),
    ];
    await ed.ensureCourses(codes);
    const cost = heap() - base;
    if (cost > worst.cost) worst = { slug, cost };
  }
  console.log(`  + all ${iugIndex.length} IUG specs and their grad subjects   ${mb(worst.cost)} MB  (last: ${worst.slug})`);
  console.log(`    ...a delta of ${mb(worst.cost - beforeIug)} MB over the plan above it`);
}

await ed.ensureSearchRanking();
console.log(`  + search ranking (only if somebody searches) ${mb(heap() - base)} MB`);
console.log(`  process RSS, for context only                ${mb(process.memoryUsage().rss)} MB`);
console.log(`\nCeiling: a Cloudflare isolate has 128 MB. Before #31 the catalog alone took 64 MB of heap.`);
