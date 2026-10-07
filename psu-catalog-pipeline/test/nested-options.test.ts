/** Requirements whose options are INDENTED rows beneath a parent comment.
 *
 * The bulletin writes "Select 6 credits of the following:" and then indents
 * the options under it. An indented row that is prose rather than a course
 * code used to close the list, so every course after it was orphaned into the
 * section and the requirement itself resolved to an empty list -- which reads
 * to a student as "no course qualifies".
 *
 * Indentation is the boundary: indented rows belong to the open requirement,
 * and the first non-indented row ends it. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRequirementTables } from "../src/parse/programRequirements.js";
import type { Rule } from "../src/validate/schemas.js";

const html = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "nested-options.html"),
  "utf-8",
);

const rules = (): Rule[] => parseRequirementTables(html).sections.flatMap((s) => s.rules);
const selectWith = (needle: string) =>
  rules().find((r): r is Extract<Rule, { type: "selectCredits" }> =>
    r.type === "selectCredits" && r.commentRaw.includes(needle),
  );

describe("options indented under a requirement", () => {
  it("collects the indented courses into the requirement itself", () => {
    const rule = selectWith("Select 6 credits of the following");
    expect(rule).toBeDefined();
    expect(rule!.from?.kind).toBe("courses");
    const courses = (rule!.from as { kind: "courses"; courses: string[] }).courses;
    expect(courses).toEqual(expect.arrayContaining(["EDLDR 405", "EDLDR 497", "LLED 497"]));
  });

  it("is not closed by an indented prose row before the courses", () => {
    // "EDTHP at the 400 level" sits between the parent and the courses. It
    // used to close the list, orphaning all three courses.
    const courses = (selectWith("Select 6 credits of the following")!.from as { courses: string[] }).courses;
    expect(courses.length).toBeGreaterThanOrEqual(3);
  });

  it("is closed by the next NON-indented row, so the next requirement's course is not swept in", () => {
    const courses = (selectWith("Select 6 credits of the following")!.from as { courses: string[] }).courses;
    expect(courses).not.toContain("HIST 020");
  });
});

describe("options that name areas rather than courses", () => {
  it("stays empty rather than inventing a list", () => {
    // "American literature" / "American history" are topic areas. No course
    // list exists here, and guessing one would be exactly the fabrication the
    // project's iron rules forbid.
    const rule = selectWith("Select 9 credits in each of two");
    expect(rule).toBeDefined();
    const courses = (rule!.from as { kind: "courses"; courses: string[] }).courses;
    expect(courses).toEqual([]);
  });

  it("surfaces those rows for review rather than dropping them", () => {
    const { needsReview } = parseRequirementTables(html);
    expect(needsReview.map((r) => r.text)).toEqual(expect.arrayContaining(["American literature"]));
  });
});
