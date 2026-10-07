/** Declared scheduling constraints ("I can't take AI 100 in Fall 2026"):
 * the optimizer must move the course to its earliest legal feasible term,
 * shift dependents, backfill the gap — and NEVER remove anything. This file
 * pins the exact incident that motivated the feature. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  astCourses, buildCatalog, buildItems, buildSchedule, checkCourse, credOf,
  generatePlan, optimizeSchedule,
  type Catalog, type Course, type PlanDoc, type ProgramTemplate,
} from "../src/index.js";

import { CATALOG_DIR } from "./edition.js";
const outDir = CATALOG_DIR;
const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(outDir, rel), "utf-8"));
const subjects = load("subjects_index.json") as Record<string, string>;

const ESC = "engineering-engineering-science-bs";
const AIE = "engineering-artificial-intelligence-engineering-bs";

function makePlan(slugs: string[]): { plan: PlanDoc; catalog: Catalog } {
  const templates: ProgramTemplate[] = slugs.map((slug) => {
    const p = load(`programs/majors/${slug}.json`);
    const up = p.suggestedPlans.find((sp: { campusLabel: string }) => /University Park/i.test(sp.campusLabel)) ?? p.suggestedPlans[0];
    return { slug: p.slug, name: p.name, campusLabel: "", semesters: up.semesters, requirements: p.requirementSections };
  });
  const plan = generatePlan(templates, { startTerm: { term: "Fall", year: 2026 }, completedCourses: [] }, slugs.join("+"));
  const prefixes = new Set<string>();
  for (const t of plan.terms) for (const i of t.items) if ("code" in i) prefixes.add(i.code.split(" ")[0]);
  let courses: Course[] = [];
  for (const pf of prefixes) if (subjects[pf]) courses = courses.concat(load(subjects[pf]));
  const hop = new Set<string>();
  for (const c of courses) for (const ast of [c.prereqAst, c.concurrentAst]) if (ast) for (const code of astCourses(ast)) hop.add(code.split(" ")[0]);
  for (const pf of hop) if (!prefixes.has(pf) && subjects[pf]) courses = courses.concat(load(subjects[pf]));
  return { plan, catalog: buildCatalog(courses) };
}

function placements(plan: PlanDoc): Map<string, number> {
  const m = new Map<string, number>();
  plan.terms.forEach((t, i) => { for (const it of t.items) if ("code" in it) m.set(it.code, i); });
  return m;
}
function violations(plan: PlanDoc, catalog: Catalog): string[] {
  const items = buildItems(plan, catalog);
  const sched = buildSchedule(plan, items, catalog);
  return items
    .filter((i) => i.kind === "course" && i.code && catalog[i.code])
    .filter((i) => checkCourse(catalog, i.code!, i.sem, sched).value === 0)
    .map((i) => `${i.code}@sem${i.sem + 1}`);
}
function allCourses(plan: PlanDoc): Set<string> {
  const removed = plan.removed ?? {};
  return new Set(plan.terms.flatMap((t) => t.items.flatMap((it) => ("code" in it && !removed[it.code] ? [it.code] : []))));
}

describe("THE INCIDENT: 'I can't take AI 100 in Fall 2026' on ESC+AIE", () => {
  it("not-in moves AI 100 later, keeps EVERY course, zero violations, terms stay full-time", () => {
    const { plan, catalog } = makePlan([ESC, AIE]);
    const before = allCourses(plan);
    plan.constraints = [{ code: "AI 100", type: "not-in", termIndex: 0 }];
    const res = optimizeSchedule(plan, catalog, { maxCredits: 19 });

    const place = placements(plan);
    // AI 100 is still in the plan — just not in Fall 2026.
    expect(place.get("AI 100")).toBeGreaterThan(0);
    // NOTHING was removed to satisfy the constraint (the original failure).
    // The only allowed disappearance is the dual-capstone rule's restorable
    // set-aside (AIE 489W), which is declared in the result — never silent.
    const after = allCourses(plan);
    for (const code of before) {
      if (res.droppedCapstone.includes(code)) continue;
      expect(after.has(code), `${code} disappeared`).toBe(true);
    }
    // No prerequisite violations — dependents shifted legally.
    expect(violations(plan, catalog)).toEqual([]);
    // The Fall 2026 gap was backfilled: term 0 still a full-time load.
    const items = buildItems(plan, catalog);
    const t0 = items.filter((x) => x.sem === 0).reduce((s, x) => s + credOf(x, catalog), 0);
    expect(t0).toBeGreaterThanOrEqual(14);
    for (const t of plan.terms.map((_, i) => items.filter((x) => x.sem === i).reduce((s, x) => s + credOf(x, catalog), 0))) {
      expect(t).toBeLessThanOrEqual(19);
    }
  });

  it("constraints are DURABLE: a second optimize still honors them", () => {
    const { plan, catalog } = makePlan([ESC, AIE]);
    plan.constraints = [{ code: "AI 100", type: "not-in", termIndex: 0 }];
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    optimizeSchedule(plan, catalog, { maxCredits: 19 }); // e.g. chat "optimize" again
    expect(placements(plan).get("AI 100")).toBeGreaterThan(0);
    expect(violations(plan, catalog)).toEqual([]);
  });
});

describe("constraint types", () => {
  it("not-before holds a course until the given term", () => {
    const { plan, catalog } = makePlan([ESC]);
    plan.constraints = [{ code: "ECON 102", type: "not-before", termIndex: 3 }];
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    expect(placements(plan).get("ECON 102")).toBeGreaterThanOrEqual(3);
    expect(violations(plan, catalog)).toEqual([]);
  });

  it("pin puts a course exactly where the student demands", () => {
    const { plan, catalog } = makePlan([ESC]);
    plan.constraints = [{ code: "ECON 102", type: "pin", termIndex: 4 }];
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    expect(placements(plan).get("ECON 102")).toBe(4);
    expect(violations(plan, catalog)).toEqual([]);
  });

  it("a constraint on a capstone member shifts the whole contiguous block", () => {
    const { plan, catalog } = makePlan([ESC]);
    // Whatever the packed length is, forbid ESC 410H from its natural
    // second-to-last slot once; the block must stay contiguous and in order.
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    const natural = placements(plan).get("ESC 410H")!;
    const { plan: p2, catalog: c2 } = makePlan([ESC]);
    p2.constraints = [{ code: "ESC 410H", type: "not-in", termIndex: natural }];
    optimizeSchedule(p2, c2, { maxCredits: 19 });
    const pl = placements(p2);
    const s409 = pl.get("ESC 409")!;
    expect(pl.get("ESC 410H")).toBe(s409 + 1);
    expect(pl.get("ESC 411")).toBe(s409 + 2);
    expect(pl.get("ESC 410H")).not.toBe(natural);
    expect(violations(p2, c2)).toEqual([]);
  });

  it("pathological all-blocked constraints never crash or drop courses", () => {
    const { plan, catalog } = makePlan([ESC]);
    // Block MATH 140 from the first six terms — legal but extreme.
    plan.constraints = Array.from({ length: 6 }, (_, i) => ({ code: "MATH 140", type: "not-in" as const, termIndex: i }));
    const before = allCourses(plan);
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    const after = allCourses(plan);
    for (const code of before) expect(after.has(code)).toBe(true);
    expect(placements(plan).get("MATH 140")).toBeGreaterThanOrEqual(6);
  });
});
