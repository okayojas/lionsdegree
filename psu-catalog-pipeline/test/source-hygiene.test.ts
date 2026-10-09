/** Control characters in source.
 *
 * Three separate regexes in this repo were silently broken by literal U+0008
 * bytes sitting where `\b` had been typed -- a shell heredoc swallowed the
 * backslash and wrote the character it denotes. The failure is invisible:
 * editors, `git diff`, `grep` and code review all render U+0008 as nothing,
 * so the line LOOKS right while the regex matches nothing.
 *
 * What it cost:
 *   - the pipeline's two-word subject token never fired, so "PL SC courses"
 *     shipped as an unreadable requirement in two editions;
 *   - a palette guard could not match anything, so it passed unconditionally
 *     while guarding a release's colour change;
 *   - campus names never title-cased ("this is the berks list").
 *
 * This test scans the whole repository rather than the files that happened
 * to be hit, because the mechanism is a shell quirk and lands anywhere. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", "data", "public", ".turbo"]);
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|html|ya?ml)$/;

/** Tab, newline and carriage return are the only control characters any of
 * these files has a reason to contain. */
const ALLOWED = new Set([9, 10, 13]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) sourceFiles(p, out);
    } else if (EXT.test(e.name)) out.push(p);
  }
  return out;
}

describe("source files", () => {
  const files = sourceFiles(REPO);

  it("there are files to check", () => {
    // A walk that silently finds nothing is the same shape of bug this test
    // exists to catch.
    expect(files.length).toBeGreaterThan(50);
  });

  it("contain no control characters masquerading as regex escapes", () => {
    const bad: string[] = [];
    for (const f of files) {
      const buf = fs.readFileSync(f);
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c < 32 && !ALLOWED.has(c)) {
          const line = buf.subarray(0, i).toString("utf-8").split("\n").length;
          bad.push(`${path.relative(REPO, f)}:${line} contains U+${c.toString(16).padStart(4, "0")}`);
          break;
        }
      }
    }
    expect(bad, "write \\b as two characters; a heredoc will eat the backslash").toEqual([]);
  });
});
