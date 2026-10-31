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

/** The catalog the MCP package ships.
 *
 * It used to be one combined `search-index.json`, and these suites read it
 * as a convenient whole-catalog source. #31 retired that file: the server
 * now reads a slim audit index always and everything else on demand,
 * because the combined one cost 64 MB of heap and a hosted isolate has
 * 128 MB. The suites follow the artifacts to where they actually ship. */
export const MCP_CATALOG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../mcp/catalog",
);

/** An Edition directory inside the shipped catalog, preferring the newest. */
export function shippedCatalogDir(): string {
  const marker = "audit-index.json";
  const preferred = path.join(MCP_CATALOG, latestEdition());
  if (fs.existsSync(path.join(preferred, marker))) return preferred;
  const any = fs.existsSync(MCP_CATALOG)
    ? fs.readdirSync(MCP_CATALOG).find((d) => fs.existsSync(path.join(MCP_CATALOG, d, marker)))
    : undefined;
  if (!any) {
    throw new Error(
      "no bundled catalog — run `pnpm --filter lionsdegree-mcp sync-catalog`.",
    );
  }
  return path.join(MCP_CATALOG, any);
}

/** Every Course in the shipped catalog, as full Course objects.
 *
 * Replaces reading the retired combined index, which these suites used as
 * a convenient whole-catalog source. The per-subject files carry strictly
 * more than it did about each Course — prerequisite structure, gen-eds,
 * level, the bulletin URL — and strictly less of what must not ship: the
 * description prose is stripped before publication (DECISIONS.md 5.1).
 *
 * Reads from disk on every call; suites that want it should hoist it to
 * module scope, as they already did with the index. */
export function fullShippedCatalog(): unknown[] {
  const dir = shippedCatalogDir();
  const out: unknown[] = [];
  for (const sub of [path.join(dir, "courses"), path.join(dir, "courses", "grad")]) {
    if (!fs.existsSync(sub)) continue;
    for (const f of fs.readdirSync(sub).filter((x) => x.endsWith(".json"))) {
      const rows = JSON.parse(fs.readFileSync(path.join(sub, f), "utf-8"));
      if (Array.isArray(rows)) out.push(...rows);
    }
  }
  if (out.length < 10_000) {
    throw new Error(
      `the shipped catalog has only ${out.length} courses — run \`pnpm --filter lionsdegree-mcp sync-catalog\``,
    );
  }
  return out;
}
