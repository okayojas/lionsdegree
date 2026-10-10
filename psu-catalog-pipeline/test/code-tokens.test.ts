/** English prose that looks like a course code.
 *
 * A course code is a SUBJECT followed by a number, and "Select 12 credits"
 * matches that shape exactly. 120 rows in the shipped catalog became course
 * rules named `SELECT 12`, `THE 400`, `APPLY 6`, `LEAST 3`.
 *
 * They arrive in pairs, because one sentence yields two: "Select 15 credits
 * ... with at least 3 credits at the 400 level" produced `SELECT 15` and
 * `LEAST 3`.
 *
 * Rejecting a token must make the row FALL THROUGH to the comment classifier,
 * never delete it: in several programs that sentence is its section's only
 * trace of the requirement. Full account in DECISIONS.md 2.4.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyComment, parseBooleanRow, parseCodeListText } from "../src/parse/programRequirements.js";

const codesOf = (text: string) => parseCodeListText(text)?.codes ?? null;

/** The two real sentences every test below is about, written once. Both are
 * verbatim catalog rows; editing one to make a test pass would stop it being
 * evidence about the catalog. */
const BRACKETED = "Select 15 credits from College-approved list (at least 3 credits must be at the 400-level)";
const PLAIN = "Select 15 credits, with at least 3 credits at the 400 level";

describe("a requirement row containing parentheses", () => {
  /** THE actual source of all 120 phantom rows.
   *
   * A row with brackets is tried as a boolean expression ("CHEM 210 & (CHEM
   * 213 or CHEM 213W)") using the PREREQUISITE tokenizer, which matches codes
   * case-insensitively. Run over BRACKETED it harvested SELECT 15, LEAST 3 and
   * THE 400 -- three phantom courses from one line, which is why they appear
   * in the catalog in groups. See DECISIONS.md 2.4. */
  it("is not mined for courses when its 'codes' are English words", () => {
    expect(parseBooleanRow(BRACKETED, null), "a sentence was read as a boolean course expression").toBeNull();
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
    const rule = classifyComment(BRACKETED);
    expect(rule.type).not.toBe("course");
    expect(JSON.stringify(rule)).toMatch(/College-approved list/);
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
    expect(codesOf(PLAIN)).toBeNull();
  });

  it("leaves the requirement visible rather than dropping it", () => {
    const rule = classifyComment(PLAIN);
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
  /** The ratchet. 120 rows across 90 programs listed sentences as courses --
   * a student opening those programs saw `THE 400` and `SELECT 12` among the
   * things to take. They carried `unverified: true`, so iron rule 2 held and
   * nothing was falsely satisfied, but it was visible nonsense and it
   * polluted everything that reads a section's sibling courses.
   *
   * Checked against the edition's own SUBJECT REGISTRY rather than a list of
   * English words. A word list is what the fix itself argues against: it is
   * wrong the first time a subject looks like a word, and the first version
   * of this test missed four of the twenty-eight codes it was written for
   * (`A 400`, `ANY 400`, `THAN 6`, `THESE 12`). A subject that does not
   * exist is the real property.
   */
  const catalogDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "psu-planner", "apps", "web", "public", "catalog",
  );

  const editionList: string[] = (() => {
    const index = path.join(catalogDir, "editions.json");
    if (!fs.existsSync(index)) return [];
    return (JSON.parse(fs.readFileSync(index, "utf-8")) as { editions: string[] }).editions;
  })();

  it("has catalog data to check", () => {
    expect(editionList.length, "no shipped catalog — this suite would pass having checked nothing").toBeGreaterThan(0);
  });

  for (const edition of editionList) {
    it(`names no course whose subject does not exist in ${edition}`, () => {
      const subjects = new Set(
        Object.keys(
          JSON.parse(fs.readFileSync(path.join(catalogDir, edition, "subjects_index.json"), "utf-8")) as Record<string, string>,
        ).map((k) => k.replace(/:grad$/, "")),
      );
      expect(subjects.size, "the subject registry is empty").toBeGreaterThan(100);

      const offenders: { file: string; code: string }[] = [];
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
              if (!subjects.has(subject)) offenders.push({ file: f, code: rule.code });
            }
          }
        }
      }
      expect(courseRules, "no course rules were examined").toBeGreaterThan(1000);
      // Three real codes carry subjects the registry does not list. They ARE
      // written in capitals in the bulletin, so they are the "unknown subject"
      // case -- a subject with no courses published this edition -- and not
      // prose. Listed exactly rather than bounded by a count: a count with
      // slack in it would let a genuinely new phantom take a free slot.
      expect(
        [...new Set(offenders.map((o) => o.code))].sort(),
        `course rules naming a subject that does not exist: ${offenders.map((o) => `${o.file}: ${o.code}`).join(", ")}`,
      ).toEqual(["AAAS 400", "ASM 327", "YFE 211"]);
    });
  }
});
