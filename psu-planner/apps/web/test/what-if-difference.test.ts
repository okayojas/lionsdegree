/** The line a what-if's tab carries: how it differs from the Plan (#69).
 *
 * A what-if is a whole copy, so what a student comparing tabs needs is what
 * each one comes to. The line must be true, and must not say less than it
 * knows or more.
 */
import { describe, it, expect } from "vitest";
import { buildCatalog, type Course, type PlanContents } from "@psu-planner/engine";
import { differenceFrom, shapeOf, type PlanShape } from "../src/data/whatIfDifference";

const shape = (over: Partial<PlanShape> = {}): PlanShape => ({
  programs: ["computer-science-bs"],
  credits: 120,
  terms: 8,
  skipped: [],
  lastTerm: "Spring 2030",
  ...over,
});

const NAMES: Record<string, string> = {
  "computer-science-bs": "Computer Science, B.S.",
  "data-sciences-bs": "Data Sciences, B.S.",
  "mathematics-minor": "Mathematics Minor",
};
const nameOf = (slug: string) => NAMES[slug] ?? slug;
const said = (whatIf: Partial<PlanShape>, mine: Partial<PlanShape> = {}) =>
  differenceFrom(shape(mine), shape(whatIf), nameOf);

describe("how a what-if differs from the plan", () => {
  it("says so where it does not, yet", () => {
    expect(said({})).toBe("The same as your plan, so far");
  });

  it("names a Program changed, added or dropped, as the student calls it", () => {
    expect(said({ programs: ["data-sciences-bs"] })).toBe("Data Sciences, B.S. instead of Computer Science, B.S.");
    expect(said({ programs: ["computer-science-bs", "mathematics-minor"] })).toBe("adds Mathematics Minor");
    expect(said({ programs: ["computer-science-bs"] }, { programs: ["computer-science-bs", "mathematics-minor"] }))
      .toBe("without Mathematics Minor");
    // A Program the index has no name for is still named, by what there is.
    expect(said({ programs: ["computer-science-bs", "something-new"] })).toBe("adds something-new");
  });

  it("counts credits and Terms of classes, more or fewer, singular and plural", () => {
    expect(said({ credits: 123 })).toBe("3 credits more");
    expect(said({ credits: 119 })).toBe("1 credit fewer");
    expect(said({ terms: 7, lastTerm: "Fall 2029" })).toBe("1 term of classes fewer · ends Fall 2029");
    expect(said({ terms: 10, lastTerm: "Spring 2031" })).toBe("2 terms of classes more · ends Spring 2031");
  });

  it("says a skipped Term is skipped, and not only that there is one fewer", () => {
    // "1 term fewer" alone reads as finishing sooner. The student took a term off.
    expect(said({ skipped: ["Spring 2028"], terms: 7 })).toBe("skips Spring 2028 · 1 term of classes fewer");
    expect(said({ skipped: [] }, { skipped: ["Fall 2027"] })).toBe("uses Fall 2027");
  });

  it("leaves credits out where either total is not known, and says the rest", () => {
    expect(said({ credits: null, terms: 9, lastTerm: "Fall 2030" })).toBe("1 term of classes more · ends Fall 2030");
    expect(said({ credits: 130 }, { credits: null })).toBe("The same as your plan, so far");
  });

  it("puts it all on one line, Programs first", () => {
    expect(said({ programs: ["data-sciences-bs"], credits: 126, terms: 9, lastTerm: "Fall 2030" }))
      .toBe("Data Sciences, B.S. instead of Computer Science, B.S. · 6 credits more · 1 term of classes more · ends Fall 2030");
  });
});

describe("what a plan comes to", () => {
  const course = (code: string, credits: number) =>
    ({ code, display: code, title: code, aliases: [], credits: String(credits), creditsParsed: { min: credits, max: credits } }) as unknown as Course;
  const catalog = buildCatalog([course("MATH 140", 4), course("CMPSC 131", 3), course("ENGL 15", 3)]);
  const contents = (over: Partial<PlanContents> = {}): PlanContents => ({
    programs: ["computer-science-bs"],
    terms: [
      { label: "Fall 2026", items: [{ code: "MATH 140" }, { code: "CMPSC 131" }] },
      { label: "Spring 2027", items: [], gap: true },
      { label: "Fall 2027", items: [{ code: "ENGL 15" }] },
    ],
    completed: {},
    moves: {},
    slotFills: {},
    added: [],
    view: null,
    ...over,
  });

  it("is its Programs, its credits, its Terms of classes, the Terms skipped and where it ends", () => {
    expect(shapeOf(contents(), catalog)).toEqual({
      programs: ["computer-science-bs"],
      credits: 10,
      terms: 2,
      skipped: ["Spring 2027"],
      lastTerm: "Fall 2027",
    });
  });

  it("gives no credit total where the catalog on hand lacks one of its Courses", () => {
    // A total that left a Course out would be a smaller number offered as
    // the answer. The what-if on another tab may name Courses the catalog
    // loaded for this one does not have.
    const withStranger = contents({ added: [{ code: "ART 20", sem: 0 }] });
    expect(shapeOf(withStranger, catalog).credits).toBeNull();
    expect(shapeOf(withStranger, catalog).terms).toBe(2);
  });
});
