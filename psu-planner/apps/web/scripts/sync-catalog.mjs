/** Copy the pipeline's emitted catalog into public/catalog for dev/build.
 * Usage: node scripts/sync-catalog.mjs [edition] */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const edition = process.argv[2] ?? "2025-2026";
const src = path.resolve(here, "../../../../psu-catalog-pipeline/data/out", edition);
const dst = path.resolve(here, "../public/catalog");

if (!fs.existsSync(src)) {
  console.error("pipeline output not found:", src);
  process.exit(1);
}
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
const count = fs.readdirSync(path.join(dst, "courses")).length;
console.log(`synced ${src} -> ${dst} (${count} course files)`);
