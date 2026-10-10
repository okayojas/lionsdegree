/** English prose that looks like a course code.
 *
 * A course code is a SUBJECT followed by a number, and "Select 12 credits"
 * matches that shape exactly. 120 rows in the shipped catalog became course
 * rules named `SELECT 12`, `THE 400`, `APPLY 6`, `LEAST 3`.
 *
 * They arrive in pairs, because one sentence yields two: "Select 15 credits
 * ... with at least 3 credits at the 400 level" produced `SELECT 15` and
 * `LEAST 3`. In several programs that sentence is the section's ONLY trace of
 * the requirement, so the fix cannot be to delete the rows -- that would
 * delete the requirement. Rejecting the token here makes the row fall through
 * to the comment classifier, which keeps the prose and surfaces it for review
 * (iron rule 2: unparseable must never present as satisfied, and must never
 * silently vanish either).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyComment, parseBooleanRow, parseCodeListText } from "../src/parse/programRequirements.js";
import { normBulletinCode, normDisplayCode } from "../src/lib/codes.js";

const codesOf = (text: string) => parseCodeListText(text)?.codes ?? null;

describe("a requirement row containing parentheses", () => {
  /** THE actual source of all 120 phantom rows.
   *
   * A row with brackets is tried as a boolean expression ("CHEM 210 & (CHEM
   * 213 or CHEM 213W)") using the PREREQUISITE tokenizer, which matches codes
   * case-insensitively. Run over an ordinary sentence it harvests words:
   *
   *   "Select 15 credits from College-approved list (at least 3 credits
   *    must be at the 400-level)"
   *
   * yielded SELECT 15, LEAST 3 and THE 400 -- three phantom courses from one
   * line, which is why they appear in the catalog in groups. */
  it("is not mined for courses when its 'codes' are English words", () => {
    const row = parseBooleanRow(
      "Select 15 credits from College-approved list (at least 3 credits must be at the 400-level)",
      null,
    );
    expect(row, "a sentence was read as a boolean course expression").toBeNull();
  });

  it("still reads a genuine boolean expression", () => {
    // Credits stay null when a row yields several rules -- they describe the
    // row as a whole and cannot be attributed to one of them.
    expect(parseBooleanRow("CHEM 210 & (CHEM 213 or CHEM 213W)", 3)).toEqual([
      { type: "course", code: "CHEM 210", credits: null },
      { type: "oneOf", options: ["CHEM 213", "CHEM 213W"], credits: null },
    ]);
  });

  it("leaves the sentence to the comment classifier, which keeps its words", () => {
    // The requirement must survive. In several programs this sentence is the
    // section's only trace of it, so dropping the row would drop the rule.
    const rule = classifyComment(
      "Select 15 credits from College-approved list (at least 3 credits must be at the 400-level)",
    );
    expect(rule.type).not.toBe("course");
    expect(JSON.stringify(rule)).toMatch(/College-approved list/);
  });
});

describe("a link in a requirement table", () => {
  /** The real mechanism. CODE_RE is case-INSENSITIVE, so normDisplayCode
   * happily turns "Select 12 credits" into `SELECT 12`. Case is what tells a
   * code from a sentence: the bulletin writes codes in capitals, which is the
   * rule CODE_TOKEN already applies elsewhere in the parser.
   *
   * This is the third time a case-insensitive code regex has read prose as a
   * code in this project (DECISIONS 2.4): "credits" once parsed as a subject
   * named REDITS. */
  it("rejects a sentence that happens to fit the shape", () => {
    for (const prose of ["Select 12 credits", "Select 6", "Apply 6 credits", "least 3 credits", "of 400-level courses", "the 400 level"]) {
      expect(normBulletinCode(prose), `"${prose}" read as a course code`).toBeNull();
    }
  });

  it("still reads a code the bulletin wrote in capitals", () => {
    expect(normBulletinCode("MATH 140")).toBe("MATH 140");
    expect(normBulletinCode("ENGL 202C")).toBe("ENGL 202C");
    expect(normBulletinCode("A-I 100")).toBe("AI 100");
  });

  it("is stricter than the shared normaliser, which stays as it was", () => {
    // normDisplayCode is ported verbatim from the demo and the engine must
    // normalise identically, so the strictness is added alongside it rather
    // than inside it.
    expect(normDisplayCode("Select 12 credits")).toBe("SELECT 12");
    expect(normBulletinCode("Select 12 credits")).toBeNull();
  });
});

describe("prose shaped like a course code", () => {
  it("is not read as one", () => {
    for (const prose of [
      "Select 12 credits",
      "Select 6",
      "Apply 6 credits",
      "at least 3 credits",
      "of 400-level courses",
      "the 400 level",
    ]) {
      expect(codesOf(prose), `"${prose}" parsed as a course code`).toBeNull();
    }
  });

  it("does not yield a pair of phantoms from one sentence", () => {
    // The shape that produced SELECT 15 + LEAST 3.
    expect(codesOf("Select 15 credits, with at least 3 credits at the 400 level")).toBeNull();
  });

  it("leaves the requirement visible rather than dropping it", () => {
    // The row still says something. It must survive as prose for review, not
    // disappear -- in several programs this sentence is the only trace of the
    // requirement in its section.
    const rule = classifyComment("Select 15 credits, with at least 3 credits at the 400 level");
    expect(rule.type).not.toBe("course");
    expect(JSON.stringify(rule)).toMatch(/Select 15 credits/);
  });
});

describe("real course codes still parse", () => {
  it("reads an ordinary code", () => {
    expect(codesOf("MATH 140")).toEqual(["MATH 140"]);
    expect(codesOf("CMPSC 465")).toEqual(["CMPSC 465"]);
  });

  it("reads a list", () => {
    expect(codesOf("ECON 102, ECON 302, or ECON 304")).toEqual(["ECON 102", "ECON 302", "ECON 304"]);
  });

  it("reads a cross-listed pair", () => {
    expect(codesOf("STS/PHIL 107")).toEqual(["STS 107", "PHIL 107"]);
  });

  it("keeps a code whose subject is real but whose number we cannot verify", () => {
    // Class B in #19: STAT 301 looks like a discontinued or renamed course.
    // Flagging it `unverified` downstream is the correct handling; deleting
    // it here would be inventing an absence.
    expect(codesOf("STAT 301")).toEqual(["STAT 301"]);
    expect(codesOf("GEOG 123")).toEqual(["GEOG 123"]);
  });

  it("keeps a subject that merely looks like a word", () => {
    // Guarding by stopword must not eat real subjects. ART, LER, BA and ENGL
    // are all real, and two of them are English words.
    expect(codesOf("ART 100")).toEqual(["ART 100"]);
    expect(codesOf("BA 342")).toEqual(["BA 342"]);
    expect(codesOf("ENGL 202C")).toEqual(["ENGL 202C"]);
  });
});

describe("the shipped catalog", () => {
  /** The ratchet. 120 rows across 90 programs were sentences presented as
   * courses; a student opening those programs saw `THE 400` and `SELECT 12`
   * listed as things to take. They carried `unverified: true`, so iron rule 2
   * held and nothing was falsely satisfied — but it was visible nonsense, and
   * it polluted every piece of logic that reads a section's sibling courses.
   */
  const PROSE = new Set(["SELECT", "APPLY", "LEAST", "THE", "OF", "AND", "WITH", "TAKE", "FROM", "AT"]);

  const catalogDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "psu-planner", "apps", "web", "public", "catalog",
  );

  function editions(): string[] {
    const index = path.join(catalogDir, "editions.json");
    if (!fs.existsSync(index)) return [];
    return (JSON.parse(fs.readFileSync(index, "utf-8")) as { editions: string[] }).editions;
  }

  it("has catalog data to check", () => {
    expect(editions().length, "no shipped catalog — this suite would pass having checked nothing").toBeGreaterThan(0);
  });

  for (const edition of editions()) {
    it(`contains no prose presented as a course in ${edition}`, () => {
      const offenders: string[] = [];
      let courseRules = 0;
      for (const kind of ["majors", "minors", "certificates"]) {
        const dir = path.join(catalogDir, edition, "programs", kind);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          const program = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
          for (const section of program.requirementSections ?? []) {
            for (const rule of section.rules ?? []) {
              if (rule.type !== "course" || typeof rule.code !== "string") continue;
              courseRules++;
              const subject = rule.code.split(" ")[0];
              if (PROSE.has(subject)) offenders.push(`${f}: ${rule.code}`);
            }
          }
        }
      }
      expect(courseRules, "no course rules were examined").toBeGreaterThan(1000);
      expect(offenders, `prose presented as courses:\n  ${offenders.slice(0, 8).join("\n  ")}`).toEqual([]);
    });
  }
});
