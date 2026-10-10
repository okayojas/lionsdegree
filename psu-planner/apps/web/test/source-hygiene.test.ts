/** No control characters in tracked source.
 *
 * This is the project's most-repeated bug, and it had bitten four times in the
 * pipeline before that tree grew a guard. This tree did not have one, so it
 * bit a fifth time here: seven U+0008 BACKSPACE bytes landed in
 * `build-output.test.ts`, every one of them where `\b` was meant.
 *
 * It arrives the same way each time — a `\b` typed into a shell heredoc or a
 * Python string collapses to the byte it names. What makes it expensive is
 * that nothing complains: the file still parses, the editor shows `<img\b`,
 * and the regex quietly becomes "img followed by a backspace character",
 * which matches nothing. The symptom was a test asserting the hero image was
 * missing from a page that plainly contained it.
 *
 * Tabs and newlines are fine. Everything else in the C0 range is a mistake.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-advisor", "test-results", "playwright-report", ".shots"]);
const EXTS = /\.(ts|tsx|mts|mjs|js|css|html|json|md)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") && e.name !== ".shots") continue;
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

  it("has source to scan", () => {
    // A wrong root would make this pass having checked nothing — which is
    // exactly how the gap this test closes went unnoticed.
    expect(files.length, `nothing scanned under ${root}`).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("build-output.test.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("landing.css"))).toBe(true);
  });

  it("contains no control characters", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const raw = fs.readFileSync(f);
      for (let i = 0; i < raw.length; i++) {
        const b = raw[i];
        if (b < 0x20 && !ALLOWED.has(b)) {
          const near = raw.subarray(Math.max(0, i - 30), i + 10).toString("utf-8");
          offenders.push(`${path.relative(root, f)} @${i}: 0x${b.toString(16).padStart(2, "0")} near ${JSON.stringify(near)}`);
          break; // one report per file is enough to act on
        }
      }
    }
    expect(offenders, "control characters in source — a \\b that became a backspace?").toEqual([]);
  });

  it("would catch a planted backspace", () => {
    // Mutation check: the scan is only worth its runtime if it actually fires,
    // and the whole failure mode here is looking correct while doing nothing.
    const planted = Buffer.from('const re = /<img\bsrc/;', "utf-8");
    const hit = [...planted].some((b) => b < 0x20 && !ALLOWED.has(b));
    expect(hit, "the scan cannot see a backspace byte").toBe(true);
  });
});
