/** Regression corpus: run the ported parser over every enforced/concurrent
 * string in the demo's 9 catalogs/*.json files. The parser must never throw,
 * must terminate, and must extract the same course codes the demo's CODE_RE
 * finds (the demo evaluates the same tokens at runtime). */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tokenize, parseExpr, parsePrereqText, astComplete, astCourses } from "../src/lib/prereq.js";
import { CODE_RE, normCode } from "../src/lib/codes.js";

const catalogsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "catalogs");
const files = fs.readdirSync(catalogsDir).filter((f) => f.endsWith(".json"));

interface DemoCourse { code: string; enforced?: string; concurrent?: string }

function codesViaRegex(text: string): string[] {
  CODE_RE.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = CODE_RE.exec(text)) !== null) out.push(normCode(m[1], m[2]));
  return [...new Set(out)];
}

describe("prereq parser regression vs demo catalogs", () => {
  it("found the demo catalog corpus", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  for (const f of files) {
    describe(f, () => {
      const courses: DemoCourse[] = JSON.parse(fs.readFileSync(path.join(catalogsDir, f), "utf-8"));
      const withPrereqs = courses.filter((c) => c.enforced || c.concurrent);

      it(`parses all ${withPrereqs.length} prereq strings without throwing`, () => {
        for (const c of withPrereqs) {
          for (const text of [c.enforced, c.concurrent]) {
            if (!text) continue;
            const ast = parsePrereqText(text);
            expect(ast).toBeTruthy();
            expect(typeof astComplete(ast)).toBe("boolean");
          }
        }
      });

      it("parseExpr preserves every course token and invents none", () => {
        for (const c of withPrereqs) {
          for (const text of [c.enforced, c.concurrent]) {
            if (!text) continue;
            // Same-tokenizer oracle: every course token must survive into the AST.
            const tokenCodes = [...new Set(
              tokenize(text).flatMap((t) => (t.t === "course" ? [t.code] : [])),
            )].sort();
            const astCodes = [...new Set(astCourses(parsePrereqText(text)))].sort();
            expect(astCodes).toEqual(tokenCodes);
            // Sanity: the AST never contains a code the raw text doesn't contain.
            const naive = new Set(codesViaRegex(text));
            for (const code of astCodes) expect(naive.has(code)).toBe(true);
          }
        }
      });
    });
  }
});

describe("parser semantics (hand cases mirroring the demo)", () => {
  it("or/and precedence: A or B and C == or(A, and(B,C))", () => {
    const ast = parseExpr(tokenize("MATH 140 or MATH 141 and PHYS 211"));
    expect(ast).toEqual({
      op: "or",
      a: { op: "course", code: "MATH 140" },
      b: { op: "and", a: { op: "course", code: "MATH 141" }, b: { op: "course", code: "PHYS 211" } },
    });
  });
  it("parens override precedence", () => {
    const ast = parseExpr(tokenize("(MATH 140 or MATH 141) and PHYS 211"));
    expect(ast.op).toBe("and");
  });
  it("strips 'C or better in' without creating an or-branch", () => {
    const ast = parseExpr(tokenize("C or better in MATH 140"));
    expect(ast).toEqual({ op: "course", code: "MATH 140" });
  });
  it("hyphenated subjects normalize (A-I 100 -> AI 100)", () => {
    const ast = parseExpr(tokenize("A-I 100"));
    expect(ast).toEqual({ op: "course", code: "AI 100" });
  });
  it("non-course text becomes an UNK phrase leaf", () => {
    const ast = parsePrereqText("satisfactory performance on the mathematics placement examination");
    expect(ast.op).toBe("phrase");
    expect(astComplete(ast)).toBe(false);
  });
  it("bulletin edge case: 'One of:' label phrases (CAS 472) keep all codes", () => {
    const ast = parsePrereqText(
      "One of: (Psych 100 or HDFS 216 or CAS 203) and One of (HDFS 312W or Psych 301W or CAS 304)",
    );
    expect([...new Set(astCourses(ast))].sort()).toEqual(
      ["CAS 203", "CAS 304", "HDFS 216", "HDFS 312W", "PSYCH 100", "PSYCH 301W"],
    );
    expect(ast.op).toBe("and");
  });
  it("bulletin edge case: square brackets (EE 200) keep all codes", () => {
    const ast = parsePrereqText(
      "C or better in [CMPEN 270 or ((C or better in CMPEN 271) and CMPEN 275)] and (CMPSC 201 or CMPSC 121 or CMPSC 131)",
    );
    expect([...new Set(astCourses(ast))].sort()).toEqual(
      ["CMPEN 270", "CMPEN 271", "CMPEN 275", "CMPSC 121", "CMPSC 131", "CMPSC 201"],
    );
  });
});
