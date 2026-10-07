/** End-to-end over REAL scraped data: generate a CS BS plan the way the web
 * app does, then verify statuses, edges, and search behave sensibly. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  astCourses, buildCatalog, buildItems, buildSchedule, checkCourse, computeEdges,
  defaultOrderKey, generatePlan, layoutColumns, searchCatalog, SAT,
  type Course, type ProgramTemplate,
} from "../src/index.js";

import { CATALOG_DIR } from "./edition.js";
const outDir = CATALOG_DIR;
const csBs = JSON.parse(fs.readFileSync(path.join(outDir, "programs/majors/engineering-computer-science-bs.json"), "utf-8"));

function loadSubjects(prefixes: Set<string>): Course[] {
  const subjects = JSON.parse(fs.readFileSync(path.join(outDir, "subjects_index.json"), "utf-8")) as Record<string, string>;
  let all: Course[] = [];
  for (const p of prefixes) {
    const file = subjects[p];
    if (file) all = all.concat(JSON.parse(fs.readFileSync(path.join(outDir, file), "utf-8")));
  }
  return all;
}

describe("CS BS end-to-end on real scraped data", () => {
  const up = csBs.suggestedPlans[0];
  const template: ProgramTemplate = { slug: csBs.slug, name: csBs.name, campusLabel: up.campusLabel, semesters: up.semesters };

  it("has the University Park plan with 8 semesters and ~127 credits", () => {
    expect(up.campusLabel).toMatch(/University Park/);
    expect(up.semesters.length).toBe(8);
    expect(up.totalCredits).toBeGreaterThanOrEqual(120);
  });

  it("fresh-start plan: every suggested course placement is prereq-clean or externally-dependent (never UNSAT)", () => {
    const plan = generatePlan([template], {
      startTerm: { term: "Fall", year: 2026 }, completedCourses: [], semestersCompleted: 0,
    }, "e2e");
    const codes = plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));
    // Load subjects for plan codes + one prereq hop (mirrors the app's loader)
    const prefixes = new Set(codes.map((c) => c.split(" ")[0]));
    let courses = loadSubjects(prefixes);
    const hop = new Set<string>();
    for (const c of courses) for (const ast of [c.prereqAst, c.concurrentAst]) {
      if (ast) for (const code of astCourses(ast)) hop.add(code.split(" ")[0]);
    }
    for (const p of prefixes) hop.delete(p);
    courses = courses.concat(loadSubjects(hop));
    const catalog = buildCatalog(courses);

    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    const failures: string[] = [];
    for (const it of items) {
      if (it.kind !== "course" || !it.code) continue;
      const chk = checkCourse(catalog, it.code, it.sem, sched);
      if (chk.value === 0) failures.push(`${it.code} (sem ${it.sem + 1})`);
    }
    // The bulletin's own suggested ordering should never violate enforced prereqs.
    expect(failures).toEqual([]);

    // Edges exist and none are red on the suggested ordering.
    const { positions } = layoutColumns(items, plan.terms.length, defaultOrderKey);
    const edges = computeEdges(items, sched, catalog, positions);
    expect(edges.length).toBeGreaterThan(5);
    expect(edges.filter((e) => e.bad)).toEqual([]);

    // MATH 140 sits in semester 1 and is SAT (no in-plan violation).
    const m140 = items.find((i) => i.code === "MATH 140")!;
    expect(m140.sem).toBe(0);
    expect(checkCourse(catalog, "MATH 140", 0, sched).value).not.toBe(0);
  });

  it("mid-degree student: completed first year, MATH 141 satisfied by completion", () => {
    const y1codes = up.semesters.slice(0, 2).flatMap((s: { entries: { type: string; code?: string }[] }) =>
      s.entries.filter((e) => e.type === "course" && e.code).map((e) => e.code!));
    const plan = generatePlan([template], {
      startTerm: { term: "Fall", year: 2027 }, completedCourses: y1codes, semestersCompleted: 2,
    }, "e2e2");
    expect(plan.terms.length).toBe(6);
    const catalog = buildCatalog(loadSubjects(new Set(["MATH", "CMPSC", "PHYS", "ENGL", "STAT", "CMPEN"])));
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    // MATH 230 (or whatever needs MATH 141) should see it as completed -> not UNSAT for that leaf
    const anyWithMath141 = items.find((i) => {
      const c = i.code ? catalog[i.code] : null;
      return c?.enforced?.includes("MATH 141");
    });
    if (anyWithMath141) {
      const chk = checkCourse(catalog, anyWithMath141.code!, anyWithMath141.sem, sched);
      const leaf = chk.leaves.find((l) => l.kind !== "phrase" && "code" in l && l.code === "MATH 141");
      expect(leaf && "v" in leaf ? leaf.v : SAT).toBe(SAT);
    }
  });

  it("search over the full real catalog finds CMPSC 465 by code and by topic", () => {
    const subjects = JSON.parse(fs.readFileSync(path.join(outDir, "subjects_index.json"), "utf-8")) as Record<string, string>;
    const catalog = buildCatalog(loadSubjects(new Set(Object.keys(subjects).filter((k) => !k.includes(":")))));
    expect(Object.keys(catalog).length).toBeGreaterThan(9000);
    expect(searchCatalog(catalog, "CMPSC 465")[0]).toBe("CMPSC 465");
    const dataStructures = searchCatalog(catalog, "data structures and algorithms");
    expect(dataStructures.slice(0, 5)).toContain("CMPSC 465");
  });
});

describe("prereq-ordering repair (AIE STAT 401 case)", () => {
  it("moves STAT 401 to semester 3 like the official department flowchart", async () => {
    const { repairPrereqOrdering, generatePlan, buildCatalog, buildItems, buildSchedule, checkCourse } = await import("../src/index.js");
    const aie = JSON.parse(fs.readFileSync(path.join(outDir, "programs/majors/engineering-artificial-intelligence-engineering-bs.json"), "utf-8"));
    const plan = generatePlan([{
      slug: aie.slug, name: aie.name, campusLabel: "",
      semesters: aie.suggestedPlans[0].semesters, requirements: aie.requirementSections,
    }], { startTerm: { term: "Fall", year: 2026 }, completedCourses: [], semestersCompleted: 0 }, "r");
    const subjects = JSON.parse(fs.readFileSync(path.join(outDir, "subjects_index.json"), "utf-8")) as Record<string, string>;
    const prefixes = new Set<string>();
    for (const t of plan.terms) for (const i of t.items) if ("code" in i) prefixes.add(i.code.split(" ")[0]);
    ["MATH", "PHYS", "ENGL", "STAT", "DS", "ESL"].forEach((p) => prefixes.add(p));
    let courses: Course[] = [];
    for (const p of prefixes) if (subjects[p]) courses = courses.concat(JSON.parse(fs.readFileSync(path.join(outDir, subjects[p]), "utf-8")));
    const catalog = buildCatalog(courses);

    const moves = repairPrereqOrdering(plan, catalog);
    expect(moves.some((m) => m.code === "STAT 401" && m.to === 2)).toBe(true); // semester 3 (0-indexed 2)

    // After repair: no UNSAT placements remain in the whole plan.
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    const bad = items.filter((i) => i.kind === "course" && i.code && checkCourse(catalog, i.code, i.sem, sched).value === 0);
    expect(bad.map((b) => b.code)).toEqual([]);
  });
});

describe("degree audit on real CS BS data", () => {
  it("fresh full plan satisfies most structured requirements; empty plan satisfies none", async () => {
    const { auditProgram, buildPool, generatePlan, buildCatalog } = await import("../src/index.js");
    const subjects = JSON.parse(fs.readFileSync(path.join(outDir, "subjects_index.json"), "utf-8")) as Record<string, string>;
    const up = csBs.suggestedPlans[0];
    const plan = generatePlan([{ slug: csBs.slug, name: csBs.name, campusLabel: up.campusLabel, semesters: up.semesters, requirements: csBs.requirementSections }],
      { startTerm: { term: "Fall", year: 2026 }, completedCourses: [], semestersCompleted: 0 }, "audit");
    const prefixes = new Set<string>();
    for (const t of plan.terms) for (const i of t.items) if ("code" in i) prefixes.add(i.code.split(" ")[0]);
    let courses: Course[] = [];
    for (const p of prefixes) if (subjects[p]) courses = courses.concat(JSON.parse(fs.readFileSync(path.join(outDir, subjects[p]), "utf-8")));
    const catalog = buildCatalog(courses);

    const pool = buildPool(plan, catalog);
    const audit = auditProgram(csBs.requirementSections, pool, catalog);
    expect(audit.totals.done).toBeGreaterThan(10); // prescribed courses covered by the suggested plan
    // Empty pool -> nothing done
    const empty = auditProgram(csBs.requirementSections, [], catalog);
    expect(empty.totals.done).toBe(0);
    expect(empty.totals.todo).toBeGreaterThan(10);
  });
});

describe("major switcher: ME junior -> CS BS with AP Calc BC (course-based onboarding)", () => {
  it("generates a compacted, violation-free plan honoring prior credit", async () => {
    const { generatePlan, buildCatalog, buildItems, buildSchedule, checkCourse, repairPrereqOrdering } = await import("../src/index.js");
    const subjects = JSON.parse(fs.readFileSync(path.join(outDir, "subjects_index.json"), "utf-8")) as Record<string, string>;
    const up = csBs.suggestedPlans[0];
    // Two years of ME + AP: no semesters-completed input, just courses.
    const taken = [
      "MATH 140", "MATH 141", "MATH 250", "PHYS 211", "PHYS 212", "CHEM 110",
      "ENGL 15", "CAS 100A", "EDSGN 100", "ME 201", "KINES 61",
    ];
    const load = (p: string): Course[] => subjects[p] ? JSON.parse(fs.readFileSync(path.join(outDir, subjects[p]), "utf-8")) : [];
    const tagSubjects = new Set(taken.map((c) => c.split(" ")[0]));
    const genEdTags: Record<string, string[]> = {};
    for (const p of tagSubjects) for (const c of load(p)) {
      if (taken.includes(c.code) && c.genEd.length) genEdTags[c.code] = c.genEd;
    }
    const plan = generatePlan([{
      slug: csBs.slug, name: csBs.name, campusLabel: up.campusLabel,
      semesters: up.semesters, requirements: csBs.requirementSections,
    }], { startTerm: { term: "Fall", year: 2026 }, completedCourses: taken, genEdTags }, "switcher");

    // Compaction: taken courses gone, labels sequential from Fall 2026.
    const codes = plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));
    for (const c of taken) expect(codes).not.toContain(c);
    expect(plan.terms[0].label).toBe("Fall 2026");
    expect(plan.terms.length).toBeLessThanOrEqual(8);
    expect(codes).toContain("CMPSC 465"); // still owes the CS core

    // Prior GHW credit (KINES 61) consumed a GHW slot if the template had one.
    const ghwSlots = plan.terms.flatMap((t) => t.items).filter((i) => "slot" in i && i.slot === "GHW");
    const noCredit = generatePlan([{
      slug: csBs.slug, name: csBs.name, campusLabel: up.campusLabel,
      semesters: up.semesters, requirements: csBs.requirementSections,
    }], { startTerm: { term: "Fall", year: 2026 }, completedCourses: taken.filter((c) => c !== "KINES 61") }, "s2");
    const ghwBaseline = noCredit.terms.flatMap((t) => t.items).filter((i) => "slot" in i && i.slot === "GHW");
    if (ghwBaseline.length > 0) expect(ghwSlots.length).toBeLessThan(ghwBaseline.length);

    // Zero violations after repair.
    const prefixes = new Set(codes.map((c) => c.split(" ")[0]));
    for (const t of tagSubjects) prefixes.add(t);
    let courses: Course[] = [];
    for (const p of prefixes) courses = courses.concat(load(p));
    const catalog = buildCatalog(courses);
    repairPrereqOrdering(plan, catalog);
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    const bad = items
      .filter((i) => i.kind === "course" && i.code && catalog[i.code])
      .filter((i) => checkCourse(catalog, i.code!, i.sem, sched).value === 0);
    expect(bad.map((b) => b.code)).toEqual([]);
  });
});

describe("coverage substitution + schedule optimizer (real data)", () => {
  const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(outDir, rel), "utf-8"));
  const coverage = load("coverage.json") as { coveredBy: Record<string, { by: string }[]> };
  const coveredBy: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(coverage.coveredBy)) coveredBy[k] = v.map((x) => x.by);

  it("mined coverage is directional (MATH 251 covers 250+252, not the reverse)", () => {
    expect(coveredBy["MATH 250"]).toContain("MATH 251");
    expect(coveredBy["MATH 252"]).toContain("MATH 251");
    expect(coveredBy["MATH 251"] ?? []).not.toContain("MATH 250");
    expect(coveredBy["EMCH 211"]).toContain("EMCH 210");
  });

  it("completed MATH 251 satisfies template entries for MATH 250 AND 252", async () => {
    const { generatePlan } = await import("../src/index.js");
    const tmpl = {
      slug: "x", name: "X", campusLabel: "",
      semesters: [{ year: 1, term: "Fall", label: "Y1F", credits: 7, entries: [
        { type: "course" as const, code: "MATH 250", credits: 3 },
        { type: "course" as const, code: "MATH 252", credits: 1 },
        { type: "course" as const, code: "CMPSC 360", credits: 3 },
      ]}],
    };
    const plan = generatePlan([tmpl], {
      startTerm: { term: "Fall", year: 2026 }, completedCourses: ["MATH 251"], coveredBy,
    }, "cov");
    const codes = plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));
    expect(codes).not.toContain("MATH 250");
    expect(codes).not.toContain("MATH 252");
    expect(codes).toContain("CMPSC 360");
  });

  it("optimizer: AIE plan compresses for a student with year-1 done; <=19cr/sem; no violations", async () => {
    const { generatePlan, buildCatalog, buildItems, buildSchedule, checkCourse, credOf, repairPrereqOrdering, optimizeSchedule } = await import("../src/index.js");
    const aie = load("programs/majors/engineering-artificial-intelligence-engineering-bs.json");
    const up = aie.suggestedPlans[0];
    const y1 = up.semesters.slice(0, 2).flatMap((s: { entries: { type: string; code?: string }[] }) =>
      s.entries.filter((e) => e.type === "course" && e.code).map((e) => e.code!));
    const plan = generatePlan([{ slug: aie.slug, name: aie.name, campusLabel: "", semesters: up.semesters, requirements: aie.requirementSections }],
      { startTerm: { term: "Fall", year: 2026 }, completedCourses: y1 }, "opt");
    const subjects = load("subjects_index.json") as Record<string, string>;
    const prefixes = new Set<string>(["MATH", "PHYS", "ENGL", "STAT", "CMPSC", "EE", "AI", "AIE", "CAS", "DS", "ESL"]);
    for (const t of plan.terms) for (const i of t.items) if ("code" in i) prefixes.add(i.code.split(" ")[0]);
    let courses: Course[] = [];
    for (const p of prefixes) if (subjects[p]) courses = courses.concat(load(subjects[p]));
    const catalog = buildCatalog(courses);

    repairPrereqOrdering(plan, catalog);
    const before = plan.terms.length;
    const res = optimizeSchedule(plan, catalog, { maxCredits: 19 });
    expect(res.semestersAfter).toBeLessThanOrEqual(before);

    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    // Credit cap respected in every semester.
    for (let i = 0; i < plan.terms.length; i++) {
      const cr = items.filter((it) => it.sem === i).reduce((s, it) => s + credOf(it, catalog), 0);
      expect(cr).toBeLessThanOrEqual(19);
    }
    // No prereq violations introduced.
    const bad = items
      .filter((it) => it.kind === "course" && it.code && catalog[it.code])
      .filter((it) => checkCourse(catalog, it.code!, it.sem, sched).value === 0)
      .map((it) => it.code);
    expect(bad).toEqual([]);
    console.log(`[optimizer] AIE with year 1 done: ${before} -> ${res.semestersAfter} semesters`);
  });
});

describe("dual-major optimizer invariants (the 25-credit incident)", () => {
  const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(outDir, rel), "utf-8"));
  it("ESC+AIE: cap respected, zero violations WITHOUT repair, slots interleaved", async () => {
    const { generatePlan, buildCatalog, buildItems, buildSchedule, checkCourse, credOf, optimizeSchedule, astCourses } = await import("../src/index.js");
    const esc = load("programs/majors/engineering-engineering-science-bs.json");
    const aie = load("programs/majors/engineering-artificial-intelligence-engineering-bs.json");
    const t = (p: { slug: string; name: string; suggestedPlans: { semesters: unknown[] }[]; requirementSections: unknown[] }) =>
      ({ slug: p.slug, name: p.name, campusLabel: "", semesters: p.suggestedPlans[0].semesters, requirements: p.requirementSections }) as never;
    const plan = generatePlan([t(esc), t(aie)], { startTerm: { term: "Fall", year: 2026 }, completedCourses: [] }, "dualopt");
    const subjects = load("subjects_index.json") as Record<string, string>;
    const prefixes = new Set<string>();
    for (const tt of plan.terms) for (const i of tt.items) if ("code" in i) prefixes.add(i.code.split(" ")[0]);
    let courses: Course[] = [];
    for (const p of prefixes) if (subjects[p]) courses = courses.concat(load(subjects[p]));
    const hop = new Set<string>();
    for (const c of courses) for (const ast of [c.prereqAst, c.concurrentAst]) if (ast) for (const code of astCourses(ast)) hop.add(code.split(" ")[0]);
    for (const p of hop) if (!prefixes.has(p) && subjects[p]) courses = courses.concat(load(subjects[p]));
    const catalog = buildCatalog(courses);

    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);

    let geGap = 0;
    const geTotal = items.filter((i) => i.kind === "slot" && i.slot !== "EL").length;
    let geSeen = 0;
    plan.terms.forEach((_, i) => {
      const its = items.filter((x) => x.sem === i);
      // 1. Credit cap — the whole point of the incident.
      const cr = its.reduce((s, x) => s + credOf(x, catalog), 0);
      expect(cr).toBeLessThanOrEqual(19);
      // 2. No all-slot semesters mid-plan (back-loading symptom).
      const nCourse = its.filter((x) => x.kind === "course").length;
      if (i < plan.terms.length - 1) expect(nCourse).toBeGreaterThan(0);
      // 3. Gen eds spread out: never more than 2 consecutive GE-less semesters
      // while gen eds remain unplaced.
      const nGE = its.filter((x) => x.kind === "slot" && x.slot !== "EL").length;
      geSeen += nGE;
      geGap = nGE > 0 ? 0 : geGap + 1;
      if (geSeen < geTotal) expect(geGap).toBeLessThanOrEqual(2);
    });

    // 4. ZERO violations straight out of the optimizer — no repair pass needed.
    const bad = items
      .filter((i) => i.kind === "course" && i.code && catalog[i.code])
      .filter((i) => checkCourse(catalog, i.code!, i.sem, sched).value === 0)
      .map((i) => i.code);
    expect(bad).toEqual([]);
  });
});
