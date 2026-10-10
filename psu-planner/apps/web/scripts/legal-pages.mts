/** Generate the static legal documents before the build.
 *
 * Writes `privacy/index.html` and `terms/index.html` from `src/legal/content.ts`,
 * which Vite then picks up as extra rollup inputs (see vite.config.ts). They
 * are generated rather than hand-written so there is exactly one copy of the
 * wording; the drift test in `test/legal.test.ts` fails if a generated file on
 * disk no longer matches what the content module would produce.
 *
 * Same prebuild pattern as `coverage-facts.mts`, and for the same reason:
 * doing it inside vite.config means reimplementing the renderer in a file Node
 * loads as plain ESM.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECTIONS } from "../src/legal/content.js";
import { pageHtml } from "../src/legal/render.js";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const GENERATED = SECTIONS.filter((s) => s.path).map((s) => ({
  section: s,
  // "/privacy/" -> "privacy/index.html"
  file: path.join(s.path!.replace(/^\/|\/$/g, ""), "index.html"),
}));

let wrote = 0;
for (const { section, file } of GENERATED) {
  const abs = path.join(web, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const html = pageHtml(section);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
  if (existing !== html) {
    fs.writeFileSync(abs, html, "utf-8");
    wrote++;
  }
}

console.log(`legal: ${GENERATED.length} static document(s) (${wrote} rewritten) — ${GENERATED.map((g) => g.file).join(", ")}`);
