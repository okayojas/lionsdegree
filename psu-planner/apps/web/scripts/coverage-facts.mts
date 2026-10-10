/** Compute the coverage figure the landing page states.
 *
 * Runs before the build and writes `coverage.generated.json`, which the Vite
 * plugin substitutes into index.html. A separate step rather than inline in
 * vite.config because the engine's modules import each other with `.js`
 * specifiers that only resolve once something transpiles them — Node loading
 * the config as ESM cannot, and the alternative (reimplementing the counting
 * in the config) is exactly the drift this ticket exists to prevent. One
 * implementation, in `packages/engine/src/coverageStat.ts`, tested there.
 *
 * Reads the catalog under public/, so the number describes the bytes this
 * build is about to ship.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requirementCoverage, type ReqSection } from "@psu-planner/engine";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(web, "public", "catalog");
const editionsFile = path.join(root, "editions.json");

if (!fs.existsSync(editionsFile)) {
  console.error(
    `no catalog at ${root}. The landing page states a figure computed from it, so a build ` +
      `without it would publish a number describing nothing. Run \`npm run sync-catalog\` first.`,
  );
  process.exit(1);
}

const { latest } = JSON.parse(fs.readFileSync(editionsFile, "utf-8")) as { latest: string };
const programs: { requirementSections?: ReqSection[] }[] = [];
for (const kind of ["majors", "minors", "certificates"]) {
  const dir = path.join(root, latest, "programs", kind);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    programs.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
  }
}

if (!programs.length) {
  console.error(`no programs under ${path.join(root, latest)} — refusing to publish a figure of nothing.`);
  process.exit(1);
}

const s = requirementCoverage(programs);
const n = (v: number) => v.toLocaleString("en-US");
const facts = {
  edition: latest,
  percent: s.percent,
  resolved: n(s.resolved),
  total: n(s.total),
  adviser: n(s.adviserDefined),
  programs: n(programs.length),
  // Kept raw for tests, which recompute and compare rather than trusting the
  // formatted strings above.
  raw: { resolved: s.resolved, total: s.total, adviserDefined: s.adviserDefined, programs: programs.length },
};

fs.writeFileSync(path.join(web, "coverage.generated.json"), JSON.stringify(facts, null, 2) + "\n", "utf-8");
console.log(
  `coverage: ${s.percent}% (${n(s.resolved)}/${n(s.total)}) across ${n(programs.length)} programs, ` +
    `${n(s.adviserDefined)} adviser-defined excluded — ${latest}`,
);
