/** Which catalog edition the suites run against.
 *
 * Defaults to the NEWEST published edition, because the refresh workflow uses
 * these suites as its gate: a freshly scraped edition must generate valid plans
 * before its PR opens. Set CATALOG_EDITION to pin an older one when
 * investigating an edition-specific regression. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CATALOG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/public/catalog",
);

export function latestEdition(): string {
  const pinned = process.env.CATALOG_EDITION;
  if (pinned) return pinned;
  const index = path.join(CATALOG_ROOT, "editions.json");
  if (fs.existsSync(index)) {
    const { latest } = JSON.parse(fs.readFileSync(index, "utf-8")) as { latest?: string };
    if (latest) return latest;
  }
  const dirs = fs
    .readdirSync(CATALOG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{4}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  if (!dirs.length) throw new Error(`no catalog editions in ${CATALOG_ROOT} - run sync-catalog.mjs`);
  return dirs[dirs.length - 1];
}

export const CATALOG_DIR = path.join(CATALOG_ROOT, latestEdition());
