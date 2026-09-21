/** Golden tests: the ported engine must reproduce the demo's SAT/UNK/UNSAT
 * statuses for known scenarios built from the demo's own catalog data. */
import { describe, it, expect } from "vitest";
import {
  buildCatalog, buildItems, buildSchedule, checkCourse, computeEdges,
  layoutColumns, defaultOrderKey, columnFromX, generatePlan, searchCatalog,
  SAT, UNK, UNSAT, type Course, type PlanDoc,
} from "../src/index.js";

function mkCourse(over: Partial<Course> & { code: string }): Course {
  const [subject, number] = over.code.split(" ");
  return {
    subject, number,
    display: over.code, title: over.code + " title", credits: "3 Credits",
    creditsParsed: { min: 3, max: 3, repeatableMax: null },
    description: "", enforced: null, concurrent: null, prereqAdvisory: null,
    prereqAst: null, concurrentAst: null, astComplete: true,
    genEd: [], attributes: [], crossListings: [], aliases: [over.code],
    level: "undergraduate", url: "", ...over,
  };
}

const catalog = buildCatalog([
  mkCourse({ code: "MATH 140" }),
  mkCourse({ code: "MATH 141", enforced: "MATH 140" }),
  mkCourse({ code: "PHYS 211", enforced: "MATH 140", concurrent: "MATH 141" }),
  mkCourse({ code: "CMPSC 465", enforced: "CMPSC 360 or MATH 311W" }),
  mkCourse({ code: "AI 100", display: "A-I 100", aliases: ["AI 100", "A-I 100"], title: "Artificial Intelligence" }),
]);

function mkPlan(terms: string[][]): PlanDoc {
  return {
    id: "t", rev: 1, updatedAt: "", programs: [],
    terms: terms.map((codes, i) => ({ label: `T${i}`, items: codes.map((code) => ({ code })) })),
    completed: {}, moves: {}, slotFills: {}, added: [], view: null,
  };
}

describe("prereq evaluation (demo semantics)", () => {
  it("earlier-semester prereq is SAT", () => {
    const plan = mkPlan([["MATH 140"], ["MATH 141"]]);
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    expect(checkCourse(catalog, "MATH 141", 1, sched).value).toBe(SAT);
  });
  it("same-semester enforced prereq is UNSAT, concurrent is SAT", () => {
    const plan = mkPlan([["MATH 140"], ["MATH 141", "PHYS 211"]]);
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    // PHYS 211 enforced=MATH 140 (earlier, SAT) + concurrent=MATH 141 (same sem, SAT because concurrent)
    expect(checkCourse(catalog, "PHYS 211", 1, sched).value).toBe(SAT);
    // But if MATH 141's own prereq (MATH 140) were same-semester it would fail:
    const plan2 = mkPlan([["MATH 140", "MATH 141"]]);
    const items2 = buildItems(plan2, catalog);
    const sched2 = buildSchedule(plan2, items2, catalog);
    expect(checkCourse(catalog, "MATH 141", 0, sched2).value).toBe(UNSAT);
  });
  it("prereq not in plan and not completed is UNK", () => {
    const plan = mkPlan([["CMPSC 465"]]);
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    expect(checkCourse(catalog, "CMPSC 465", 0, sched).value).toBe(UNK);
  });
  it("completed course satisfies regardless of position", () => {
    const plan = mkPlan([["MATH 140", "MATH 141"]]);
    plan.completed["MATH 140"] = true;
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    expect(checkCourse(catalog, "MATH 141", 0, sched).value).toBe(SAT);
  });
  it("aliases register in the schedule (A-I 100 <-> AI 100)", () => {
    const plan = mkPlan([["AI 100"]]);
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    expect(sched["A-I 100"]).toBeTruthy();
    expect(sched["AI 100"]).toBeTruthy();
  });
});

describe("edges + layout", () => {
  it("violated ordering yields a bad edge", () => {
    const plan = mkPlan([["MATH 141"], ["MATH 140"]]); // 141 before its prereq
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    const { positions } = layoutColumns(items, 2, defaultOrderKey);
    const edges = computeEdges(items, sched, catalog, positions);
    expect(edges).toHaveLength(1);
    expect(edges[0].bad).toBe(true);
    expect(edges[0].from).toBe("MATH 140");
    expect(edges[0].to).toBe("MATH 141");
  });
  it("column snap math matches demo", () => {
    // Card left edge exactly at column 1's x
    const x = 50 + 1 * (228 + 84);
    expect(columnFromX(x, 4)).toBe(1);
  });
});

describe("plan generation", () => {
  const template = {
    slug: "cs-bs", name: "CS", campusLabel: "UP",
    semesters: [
      { year: 1, term: "Fall", label: "Y1 Fall", credits: 16, entries: [
        { type: "course" as const, code: "MATH 140", credits: 4 },
        { type: "genEd" as const, label: "General Education Course", domain: null, credits: 3 },
      ]},
      { year: 1, term: "Spring", label: "Y1 Spring", credits: 15, entries: [
        { type: "course" as const, code: "MATH 141", credits: 4 },
        { type: "course" as const, code: "PHYS 211", credits: 4 },
      ]},
    ],
  };
  it("skips completed semesters, pulls owed courses forward, marks completed", () => {
    const plan = generatePlan([template], {
      startTerm: { term: "Spring", year: 2027 },
      completedCourses: ["MATH 140"],
      semestersCompleted: 1,
    }, "p1");
    expect(plan.terms).toHaveLength(1);
    expect(plan.terms[0].label).toBe("Spring 2027");
    const codes = plan.terms[0].items.filter((i) => "code" in i).map((i) => (i as { code: string }).code);
    expect(codes).toContain("MATH 141");
    expect(codes).toContain("PHYS 211");
    expect(codes).not.toContain("MATH 140"); // completed, not owed
    expect(plan.completed["MATH 140"]).toBe(true);
  });
  it("double major shares ONE set of gen-ed/elective slots (max, not sum)", () => {
    const second = { ...template, slug: "other" };
    const plan = generatePlan([template, second], {
      startTerm: { term: "Fall", year: 2026 }, completedCourses: [], semestersCompleted: 0,
    }, "p3");
    const slots = plan.terms.flatMap((t) => t.items.filter((i) => "slot" in i));
    // Each program's template has exactly 1 gen-ed slot -> merged plan must have 1, not 2.
    expect(slots).toHaveLength(1);
  });
  it("completed ALTERNATIVE satisfies an or-entry (CMPSC 121 or 131)", () => {
    const tmpl = {
      slug: "cs", name: "CS", campusLabel: "UP",
      semesters: [{ year: 1, term: "Fall", label: "Y1F", credits: 3, entries: [
        { type: "course" as const, code: "CMPSC 121", credits: 3, alternatives: ["CMPSC 131"] },
        { type: "course" as const, code: "MATH 140", credits: 4 },
      ]}],
    };
    const plan = generatePlan([tmpl], {
      startTerm: { term: "Spring", year: 2027 }, completedCourses: ["CMPSC 131"], semestersCompleted: 1,
    }, "p4");
    const codes = plan.terms.flatMap((t) => t.items.filter((i) => "code" in i).map((i) => (i as { code: string }).code));
    expect(codes).not.toContain("CMPSC 121"); // satisfied via the completed alternative
    expect(codes).toContain("MATH 140"); // still owed
  });
  it("dedupes shared courses across two programs", () => {
    const second = { ...template, slug: "other", semesters: [template.semesters[0]] };
    const plan = generatePlan([template, second], {
      startTerm: { term: "Fall", year: 2026 }, completedCourses: [], semestersCompleted: 0,
    }, "p2");
    const codes = plan.terms.flatMap((t) => t.items.filter((i) => "code" in i).map((i) => (i as { code: string }).code));
    expect(codes.filter((c) => c === "MATH 140")).toHaveLength(1);
  });
});

describe("search", () => {
  it("finds by code and by title words", () => {
    expect(searchCatalog(catalog, "AI 100")).toContain("AI 100");
    expect(searchCatalog(catalog, "artificial intelligence")[0]).toBe("AI 100");
  });
});

describe("course-based generation (no semesters dropdown)", () => {
  const tmpl = {
    slug: "cs", name: "CS", campusLabel: "UP",
    semesters: [
      { year: 1, term: "Fall", label: "Y1F", credits: 7, entries: [
        { type: "course" as const, code: "MATH 140", credits: 4 },
        { type: "course" as const, code: "CMPSC 131", credits: 3 },
      ]},
      { year: 1, term: "Spring", label: "Y1S", credits: 8, entries: [
        { type: "course" as const, code: "MATH 141", credits: 4 },
        { type: "course" as const, code: "PHYS 211", credits: 4 },
      ]},
      { year: 2, term: "Fall", label: "Y2F", credits: 3, entries: [
        { type: "course" as const, code: "CMPSC 360", credits: 3 },
        { type: "genEd" as const, label: "General Education Course (GHW)", domain: "GHW", credits: 1.5 },
      ]},
    ],
  };
  it("fully-completed semesters compact away and labels restart at startTerm", () => {
    const plan = generatePlan([tmpl], {
      startTerm: { term: "Fall", year: 2026 },
      completedCourses: ["MATH 140", "CMPSC 131", "MATH 141", "PHYS 211"],
    }, "c1");
    expect(plan.terms).toHaveLength(1);
    expect(plan.terms[0].label).toBe("Fall 2026");
    const codes = plan.terms[0].items.filter((i) => "code" in i).map((i) => (i as { code: string }).code);
    expect(codes).toEqual(["CMPSC 360"]);
  });
  it("major-switcher: scattered completion pulls leftovers forward compactly", () => {
    const plan = generatePlan([tmpl], {
      startTerm: { term: "Spring", year: 2027 },
      completedCourses: ["MATH 140", "MATH 141"], // e.g. came from ME
    }, "c2");
    // Y1F leftover CMPSC 131, Y1S leftover PHYS 211, Y2F CMPSC 360 -> 3 non-empty terms
    expect(plan.terms.map((t) => t.label)).toEqual(["Spring 2027", "Fall 2027", "Spring 2028"]);
    const first = plan.terms[0].items.filter((i) => "code" in i).map((i) => (i as { code: string }).code);
    expect(first).toEqual(["CMPSC 131"]);
  });
  it("completed gen-ed-tagged transfer course consumes the matching GE slot", () => {
    const withTag = generatePlan([tmpl], {
      startTerm: { term: "Fall", year: 2026 },
      completedCourses: ["KINES 61"], // a GHW course from another college
      genEdTags: { "KINES 61": ["GHW"] },
    }, "c3");
    const slots = withTag.terms.flatMap((t) => t.items.filter((i) => "slot" in i));
    expect(slots).toHaveLength(0); // the GHW slot was consumed
    const without = generatePlan([tmpl], {
      startTerm: { term: "Fall", year: 2026 },
      completedCourses: ["KINES 61"],
    }, "c4");
    expect(without.terms.flatMap((t) => t.items.filter((i) => "slot" in i))).toHaveLength(1);
  });
});
