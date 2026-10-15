/** Compute the coverage figure the landing page states.
 *
 * Runs before the build (and before `dev`) and writes
 * `coverage.generated.json`, which the Vite plugin substitutes into
 * index.html. A separate step rather than inline in vite.config because the
 * engine's modules import each other with `.js` specifiers that only resolve
 * once something transpiles them — Node loading the config as ESM cannot —
 * and the alternative, reimplementing the counting in the config, is exactly
 * the drift this ticket exists to prevent. One implementation, in
 * `packages/engine/src/coverageStat.ts`, tested there.
 *
 * Reads the catalog under public/, so the number describes the bytes this
 * build is about to ship.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requirementCoverage } from "@psu-planner/engine";
import { latestEdition, loadPrograms } from "./catalog-programs.mjs";

/** Distinct courses in the shipped index for this edition. The proof strip
 * states it, so it is counted from the bytes that ship rather than typed. */
function courseCount(edition: string): number {
  const file = path.join(web, "public", "catalog", edition, "search-index.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { courses?: unknown[] } | unknown[];
  const list = Array.isArray(raw) ? raw : (raw.courses ?? []);
  return new Set(list.map((c) => (c as { code?: string }).code).filter(Boolean)).size;
}

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let edition: string;
let programs: ReturnType<typeof loadPrograms>;
try {
  edition = latestEdition();
  programs = loadPrograms(edition);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const s = requirementCoverage(programs);
const n = (v: number) => v.toLocaleString("en-US");

fs.writeFileSync(
  path.join(web, "coverage.generated.json"),
  JSON.stringify(
    {
      edition,
      percent: s.percent,
      resolved: n(s.resolved),
      named: n(s.named),
      patterned: n(s.patterned),
      genEd: n(s.genEd),
      unreadable: n(s.unreadable),
      total: n(s.total),
      adviser: n(s.adviserDefined),
      programs: n(programs.length),
      // RAW copies for the count-up animation, which has to parse them as
      // numbers. The formatted versions stay, because they are what renders
      // before the script runs and what a reader sees if it never does.
      programsRaw: String(programs.length),
      courses: n(courseCount(edition)),
      coursesRaw: String(courseCount(edition)),
    },
    null,
    2,
  ) + "\n",
  "utf-8",
);

console.log(
  `coverage: ${s.percent}% (${n(s.named)} named + ${n(s.patterned)} patterned of ${n(s.total)}) ` +
    `across ${n(programs.length)} programs; ${n(s.unreadable)} unreadable, ${n(s.genEd)} gen-ed, ` +
    `${n(s.adviserDefined)} adviser-defined excluded — ${edition}`,
);
