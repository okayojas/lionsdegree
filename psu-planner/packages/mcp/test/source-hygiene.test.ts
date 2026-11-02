/** No control characters in tracked source (#51).
 *
 * THIS IS THE PACKAGE WHERE IT KEPT HAPPENING, and it was the one
 * without a guard. `apps/web` grew this test after seven U+0008 bytes
 * landed in a regex there; `psu-catalog-pipeline` has one for the same
 * reason. `packages/mcp` — where the OAuth consent filter, the
 * prerequisite matchers and the Mermaid escaping all live — had none,
 * and every one of the eight agents working here in parallel had to
 * hand-scan its own files because the guard they were told about did
 * not cover them.
 *
 * It arrives the same way each time: a `\b` typed into a shell heredoc
 * or a Python string collapses to the byte it names. Nothing complains.
 * The file parses, the editor shows `\b`, and the regex quietly becomes
 * "followed by a backspace character", which matches nothing.
 *
 * WHAT THAT COSTS HERE RATHER THAN IN A STYLESHEET. The narration
 * filter in `mutations.ts` is the thing deciding whether a model is
 * claiming a student's consent on their behalf. A control character in
 * that pattern leaves a guard that still reads correctly in review and
 * matches something else entirely — and the failure is silent on the
 * side that lets something through.
 *
 * Tabs, newlines and carriage returns are fine. Everything else in the
 * C0 range is a mistake.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `catalog/` is generated and enormous; `dist/` is build output. Neither
 * is written by hand, so neither can acquire a stray backspace from a
 * heredoc — and scanning 38 MB of JSON on every run would make this
 * cost more than it is worth. */
const SKIP_DIRS = new Set(["node_modules", "dist", "catalog"]);
const EXTS = /\.(ts|tsx|mts|mjs|js|json|md|toml)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...sourceFiles(full));
    } else if (EXTS.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Allowed C0 bytes: tab, line feed, carriage return. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

describe("tracked source", () => {
  const files = sourceFiles(root);

  it("has source to scan, including the files this guard exists for", () => {
    // A wrong root, or a skip list that swallowed `src/`, would make
    // every assertion below pass having checked nothing — which is
    // precisely how the gap went unnoticed in the first place.
    expect(files.length, `nothing scanned under ${root}`).toBeGreaterThan(20);
    for (const needed of ["src/mutations.ts", "src/tools.ts", "src/oauth.ts", "scripts/sync-catalog.mjs"]) {
      expect(
        files.some((f) => f.endsWith(needed.replace("/", path.sep))),
        `${needed} is not being scanned`,
      ).toBe(true);
    }
  });

  it("contains no control characters", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const raw = fs.readFileSync(f);
      for (let i = 0; i < raw.length; i++) {
        const b = raw[i];
        if (b < 0x20 && !ALLOWED.has(b)) {
          const near = raw.subarray(Math.max(0, i - 30), i + 10).toString("utf-8");
          offenders.push(
            `${path.relative(root, f)} @${i}: 0x${b.toString(16).padStart(2, "0")} near ${JSON.stringify(near)}`,
          );
          break; // one report per file is enough to act on
        }
      }
    }
    expect(offenders, "control characters in source — a backslash-b that became a backspace?").toEqual([]);
  });

  it("would catch a planted backspace", () => {
    // Mutation check. The whole failure mode of a scanner is looking
    // correct while seeing nothing, so the scan has to be shown firing
    // on a byte of exactly the kind it is here to catch.
    const planted = Buffer.from("const narrating = /" + String.fromCharCode(8) + "(the )?user/;", "utf-8");
    const hit = [...planted].some((b) => b < 0x20 && !ALLOWED.has(b));
    expect(hit, "the scan cannot see a backspace byte").toBe(true);
  });
});
