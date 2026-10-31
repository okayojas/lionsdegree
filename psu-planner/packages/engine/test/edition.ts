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

/** The combined course index, which lives in the MCP package's bundle now.
 *
 * It used to sit in the web catalog, and these suites read it from there as a
 * convenient whole-catalog source. #29 removed it from the web app — one
 * 2.4 MB file on the path every student waits on was the whole of #24 — but
 * `packages/mcp` still requires it, so the artifact and the tests that want a
 * full catalog both follow it to where it actually ships. */
export const MCP_CATALOG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../mcp/catalog",
);

export function fullIndexDir(): string {
  const preferred = path.join(MCP_CATALOG, latestEdition());
  if (fs.existsSync(path.join(preferred, "search-index.json"))) return preferred;
  const any = fs.existsSync(MCP_CATALOG)
    ? fs.readdirSync(MCP_CATALOG).find((d) => fs.existsSync(path.join(MCP_CATALOG, d, "search-index.json")))
    : undefined;
  if (!any) {
    throw new Error(
      "no bundled course index — run `pnpm --filter lionsdegree-mcp sync-catalog`. " +
        "It is no longer in the web catalog (#29).",
    );
  }
  return path.join(MCP_CATALOG, any);
}
