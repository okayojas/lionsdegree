/** Load every program in a shipped catalog edition.
 *
 * Shared by the pre-build step that computes the coverage figure and by the
 * test that recomputes it to check the built page. Those two must disagree
 * about the STATISTIC if anything drifts — that is the point of the test —
 * but they have no reason to disagree about which files to read, and three
 * copies of the same directory walk bought no drift detection at all.
 *
 * Lives here rather than in the engine on purpose: the engine reads no files,
 * and there is a test asserting it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReqSection } from "@psu-planner/engine";

export interface CatalogProgram {
  slug?: string;
  requirementSections?: ReqSection[];
}

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_ROOT = path.join(web, "public", "catalog");

/** The newest published edition, as the app resolves it. */
export function latestEdition(root = CATALOG_ROOT): string {
  const index = path.join(root, "editions.json");
  if (!fs.existsSync(index)) {
    throw new Error(
      `no catalog at ${root}. The landing page states a figure computed from it, so a build ` +
        `without it would publish a number describing nothing. Run \`npm run sync-catalog\` first.`,
    );
  }
  return (JSON.parse(fs.readFileSync(index, "utf-8")) as { latest: string }).latest;
}

/** Majors, minors and certificates for one edition. */
export function loadPrograms(edition = latestEdition(), root = CATALOG_ROOT): CatalogProgram[] {
  const programs: CatalogProgram[] = [];
  for (const kind of ["majors", "minors", "certificates"]) {
    const dir = path.join(root, edition, "programs", kind);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      programs.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as CatalogProgram);
    }
  }
  if (!programs.length) {
    throw new Error(`no programs under ${path.join(root, edition)} — refusing to report a figure of nothing.`);
  }
  return programs;
}
