/** Opt-in summer sessions: sequencing (between Spring and Fall), lower credit
 * ceiling, capstone never in summer, honors academic-year mapping, and the
 * consolidation payoff (a summer shortens the calendar). */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUMMER_MAX_CREDITS, academicYearOf, astCourses, buildCatalog, buildItems, buildSchedule,
  checkCourse, credOf, generatePlan, optimizeSchedule, parseTermLabel, termSequence,
  type Catalog, type Course, type PlanDoc, type ProgramTemplate,
} from "../src/index.js";

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/catalog");
const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(outDir, rel), "utf-8"));
const subjects = load("subjects_index.json") as Record<string, string>;

function makeEsc(summerYears: number[]): { plan: PlanDoc; catalog: Catalog } {
  const p = load("programs/majors/engineering-engineering-science-bs.json");
  const up = p.suggestedPlans.find((sp: { campusLabel: string }) => /University Park/i.test(sp.campusLabel)) ?? p.suggestedPlans[0];
  const tmpl: ProgramTemplate = { slug: p.slug, name: p.name, campusLabel: "", semesters: up.semesters, requirements: p.requirementSections };
  const plan = generatePlan([tmpl], { startTerm: { term: "Fall", year: 2026 }, completedCourses: [] }, "summer-esc");
  plan.summerYears = summerYears;
  const prefixes = new Set<string>();
  for (const t of plan.terms) for (const i of t.items) if ("code" in i) prefixes.add(i.code.split(" ")[0]);
  let courses: Course[] = [];
  for (const pf of prefixes) if (subjects[pf]) courses = courses.concat(load(subjects[pf]));
  const hop = new Set<string>();
  for (const c of courses) for (const ast of [c.prereqAst, c.concurrentAst]) if (ast) for (const code of astCourses(ast)) hop.add(code.split(" ")[0]);
  for (const pf of hop) if (!prefixes.has(pf) && subjects[pf]) courses = courses.concat(load(subjects[pf]));
  return { plan, catalog: buildCatalog(courses) };
}

describe("term sequencing", () => {
  it("summer sits between Spring and Fall of its year", () => {
    const seq = termSequence({ term: "Fall", year: 2026 }, 6, [2027]).map((t) => t.label);
    expect(seq).toEqual(["Fall 2026", "Spring 2027", "Summer 2027", "Fall 2027", "Spring 2028", "Fall 2028"]);
  });
  it("academic years close with the summer (Schreyer counting)", () => {
    const first = parseTermLabel("Fall 2026")!;
    expect(academicYearOf(parseTermLabel("Spring 2027")!, first)).toBe(1);
    expect(academicYearOf(parseTermLabel("Summer 2027")!, first)).toBe(1);
    expect(academicYearOf(parseTermLabel("Fall 2027")!, first)).toBe(2);
  });
});

describe("optimizer with a summer session", () => {
  it("labels the summer correctly, caps it, keeps everything legal, and shortens the calendar", () => {
    const base = makeEsc([]);
    optimizeSchedule(base.plan, base.catalog, { maxCredits: 19 });
    const baseRegularTerms = base.plan.terms.length;

    const { plan, catalog } = makeEsc([2027]);
    optimizeSchedule(plan, catalog, { maxCredits: 19 });

    // Sequence: Summer 2027 sits exactly between Spring 2027 and Fall 2027.
    const labels = plan.terms.map((t) => t.label);
    const si = labels.indexOf("Summer 2027");
    expect(si).toBeGreaterThan(0);
    expect(labels[si - 1]).toBe("Spring 2027");
    expect(labels[si + 1]).toBe("Fall 2027");

    const items = buildItems(plan, catalog);
    const creditsAt = (i: number) => items.filter((x) => x.sem === i).reduce((s, x) => s + credOf(x, catalog), 0);
    // Summer respects its lower ceiling and actually gets used.
    expect(creditsAt(si)).toBeGreaterThan(0);
    expect(creditsAt(si)).toBeLessThanOrEqual(SUMMER_MAX_CREDITS);
    // Regular terms still respect the 19 cap.
    plan.terms.forEach((t, i) => { if (!/^Summer/.test(t.label)) expect(creditsAt(i)).toBeLessThanOrEqual(19); });
    // No prereq violations.
    const sched = buildSchedule(plan, items, catalog);
    const bad = items
      .filter((x) => x.kind === "course" && x.code && catalog[x.code])
      .filter((x) => checkCourse(catalog, x.code!, x.sem, sched).value === 0);
    expect(bad).toEqual([]);
    // Consolidation payoff: extra summer capacity means no MORE regular
    // semesters than before (usually fewer).
    const regularAfter = plan.terms.filter((t) => !/^Summer/.test(t.label)).length;
    expect(regularAfter).toBeLessThanOrEqual(baseRegularTerms);
    // Capstone never lands in a summer.
    const place = new Map(items.filter((x) => x.kind === "course").map((x) => [x.code!, x.sem] as const));
    for (const code of ["ESC 409", "ESC 410H", "ESC 411"]) {
      const sem = place.get(code);
      expect(sem).toBeDefined();
      expect(/^Summer/.test(plan.terms[sem!].label)).toBe(false);
    }
  });

  it("a pin constraint can put a specific course into the summer", () => {
    const { plan, catalog } = makeEsc([2027]);
    // Find where the summer will sit: Fall26, Spr27 -> index 2.
    plan.constraints = [{ code: "ECON 102", type: "pin", termIndex: 2 }];
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    expect(plan.terms[2].label).toBe("Summer 2027");
    const items = buildItems(plan, catalog);
    const econ = items.find((x) => x.kind === "course" && x.code === "ECON 102");
    expect(econ?.sem).toBe(2);
  });
});
