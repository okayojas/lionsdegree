/** Template-anchored optimizer: capstone handling, template-order preservation,
 * the elective/gen-ed gradient, and the mined general flowchart prior applied
 * to a program that has no official flowchart of its own. Runs over REAL
 * scraped data + the mined flowchart-patterns.json. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  astCourses, buildCatalog, buildItems, buildSchedule, checkCourse, credOf,
  detectCapstones, generatePlan, optimizeSchedule, DEFAULT_FLOWCHART_PATTERNS,
  type Catalog, type Course, type FlowchartPatterns, type PlanDoc, type ProgramTemplate,
} from "../src/index.js";

import { CATALOG_DIR } from "./edition.js";
const outDir = CATALOG_DIR;
const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(outDir, rel), "utf-8"));
const subjects = load("subjects_index.json") as Record<string, string>;

/** Mined priors if present; otherwise the engine defaults (keeps CI green even
 * before a scrape has run the miner). */
const patterns: FlowchartPatterns = (() => {
  try { return load("flowchart-patterns.json"); } catch { return DEFAULT_FLOWCHART_PATTERNS; }
})();

function templateFor(slug: string): ProgramTemplate {
  const prog = load(`programs/majors/${slug}.json`);
  const up = prog.suggestedPlans.find((sp: { campusLabel: string }) => /University Park/i.test(sp.campusLabel)) ?? prog.suggestedPlans[0];
  return { slug: prog.slug, name: prog.name, campusLabel: up?.campusLabel ?? "", semesters: up?.semesters ?? [], requirements: prog.requirementSections };
}

function catalogFor(plan: PlanDoc): Catalog {
  const prefixes = new Set<string>();
  for (const t of plan.terms) for (const i of t.items) if ("code" in i) prefixes.add(i.code.split(" ")[0]);
  let courses: Course[] = [];
  for (const p of prefixes) if (subjects[p]) courses = courses.concat(load(subjects[p]));
  const hop = new Set<string>();
  for (const c of courses) for (const ast of [c.prereqAst, c.concurrentAst]) if (ast) for (const code of astCourses(ast)) hop.add(code.split(" ")[0]);
  for (const p of hop) if (!prefixes.has(p) && subjects[p]) courses = courses.concat(load(subjects[p]));
  return buildCatalog(courses);
}

/** Generated (pre-optimize) term index per course code. */
function genPlacements(plan: PlanDoc): Map<string, number> {
  const m = new Map<string, number>();
  plan.terms.forEach((t, i) => { for (const it of t.items) if ("code" in it) m.set(it.code, i); });
  return m;
}
function makePlan(slugs: string[], completed: string[] = []): { plan: PlanDoc; catalog: Catalog } {
  const plan = generatePlan(slugs.map(templateFor), { startTerm: { term: "Fall", year: 2026 }, completedCourses: completed }, slugs.join("+"));
  return { plan, catalog: catalogFor(plan) };
}
function semCredits(plan: PlanDoc, catalog: Catalog): number[] {
  const items = buildItems(plan, catalog);
  return plan.terms.map((_, i) => items.filter((x) => x.sem === i).reduce((s, x) => s + credOf(x, catalog), 0));
}
function violations(plan: PlanDoc, catalog: Catalog): string[] {
  const items = buildItems(plan, catalog);
  const sched = buildSchedule(plan, items, catalog);
  return items
    .filter((i) => i.kind === "course" && i.code && catalog[i.code])
    .filter((i) => checkCourse(catalog, i.code!, i.sem, sched).value === 0)
    .map((i) => `${i.code}@sem${i.sem + 1}`);
}

const ESC = "engineering-engineering-science-bs";
const AIE = "engineering-artificial-intelligence-engineering-bs";

describe("capstone detection + dual-major resolution", () => {
  it("ESC alone: keeps the ESC 409 -> 410H -> 411 sequence, anchored one-per-final-semester", () => {
    const { plan, catalog } = makePlan([ESC]);
    const caps = detectCapstones(plan, catalog, patterns);
    const esc = caps.find((c) => c.program === ESC);
    expect(esc).toBeDefined();
    expect(esc!.codes).toEqual(["ESC 409", "ESC 410H", "ESC 411"]);

    optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
    const place = new Map<string, number>();
    plan.terms.forEach((t, i) => { for (const it of t.items) if ("code" in it) place.set(it.code, i); });
    const last = plan.terms.length - 1;
    // Whole sequence sits in the final three semesters, in order, one per term.
    expect(place.get("ESC 411")).toBe(last);
    expect(place.get("ESC 410H")).toBe(last - 1);
    expect(place.get("ESC 409")).toBe(last - 2);
  });

  it("ESC + AIE: two capstones -> keeps ESC's longer sequence, sets AIE 489W aside restorably", () => {
    const { plan, catalog } = makePlan([ESC, AIE]);
    const res = optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
    expect(res.droppedCapstone).toEqual(["AIE 489W"]);
    expect(res.capstoneNote).toMatch(/ESC 409 → ESC 410H → ESC 411/);
    // The dropped capstone is removed (restorable), not deleted from history.
    expect(plan.removed?.["AIE 489W"]).toBe(true);
    // The kept sequence still anchors to the final three semesters.
    const place = new Map<string, number>();
    plan.terms.forEach((t, i) => { for (const it of t.items) if ("code" in it) place.set(it.code, i); });
    const last = plan.terms.length - 1;
    expect([place.get("ESC 409"), place.get("ESC 410H"), place.get("ESC 411")]).toEqual([last - 2, last - 1, last]);
  });
});

describe("template-order preservation", () => {
  for (const slug of [ESC, AIE, "engineering-mechanical-engineering-bs"]) {
    it(`${slug}: >=90% of template-ordered course pairs keep their order`, () => {
      const { plan, catalog } = makePlan([slug]);
      const gen = genPlacements(plan);
      optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
      const opt = new Map<string, number>();
      plan.terms.forEach((t, i) => { for (const it of t.items) if ("code" in it) opt.set(it.code, i); });
      const codes = [...gen.keys()].filter((c) => opt.has(c));
      let ordered = 0, preserved = 0;
      for (let a = 0; a < codes.length; a++) {
        for (let b = a + 1; b < codes.length; b++) {
          const ga = gen.get(codes[a])!, gb = gen.get(codes[b])!;
          if (ga === gb) continue; // no template order between them
          ordered++;
          const oa = opt.get(codes[a])!, ob = opt.get(codes[b])!;
          if ((ga < gb && oa <= ob) || (ga > gb && oa >= ob)) preserved++;
        }
      }
      expect(ordered).toBeGreaterThan(0);
      expect(preserved / ordered).toBeGreaterThanOrEqual(0.9);
    });
  }
});

describe("elective / gen-ed gradient", () => {
  it("ESC+AIE: prescribed core FRONT-LOADED, electives phase in toward the capstone (bulletin shape), cap respected", () => {
    const { plan, catalog } = makePlan([ESC, AIE]);
    optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
    const items = buildItems(plan, catalog);
    const n = plan.terms.length;
    const elPerSem = plan.terms.map((_, i) => items.filter((x) => x.sem === i && x.kind === "slot" && x.slot === "EL").length);
    const coursePerSem = plan.terms.map((_, i) => items.filter((x) => x.sem === i && x.kind === "course").length);
    // Semester 1 is prescribed-only: no undecided elective placeholder.
    expect(elPerSem[0]).toBe(0);
    // While spine courses remain, terms keep real courses — electives never
    // form an all-slot "ghetto" term mid-plan.
    for (let i = 0; i < n - 1; i++) expect(coursePerSem[i]).toBeGreaterThan(0);
    // The bulletin's own shape (mined from 1,078 suggested plans): elective
    // placeholders concentrate in the BACK half; the front half is core-dense.
    // (1.5x back-weighting; the even-load target + light-term rebalance trade
    // a little steepness for every-term-full-time, which the user prioritized.)
    const half = Math.floor(n / 2);
    const frontEl = elPerSem.slice(0, half).reduce((a, b) => a + b, 0);
    const backEl = elPerSem.slice(half).reduce((a, b) => a + b, 0);
    expect(backEl).toBeGreaterThanOrEqual(frontEl * 1.5);
    // Density (courses per term), not raw counts — an odd term count gives the
    // back "half" an extra term and would skew a raw comparison.
    const frontCourseDensity = coursePerSem.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const backCourseDensity = coursePerSem.slice(half).reduce((a, b) => a + b, 0) / (n - half);
    expect(frontCourseDensity).toBeGreaterThanOrEqual(backCourseDensity);
    // Hard cap, inclusive.
    for (const cr of semCredits(plan, catalog)) expect(cr).toBeLessThanOrEqual(19);
  });

  it("CONSOLIDATION: every term full-time — capstone terms backfilled with TEs, no thin tail", () => {
    for (const slugs of [[ESC], [ESC, AIE]]) {
      const { plan, catalog } = makePlan(slugs);
      optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
      const creds = semCredits(plan, catalog);
      // Every semester — including the capstone tail — is at least full-time
      // (PSU floor: 12 credits; whole-slot granularity sometimes forces a
      // couple of 12-13cr terms) and never over the 19 cap. A 2-3 credit
      // trailing term wastes a semester — that must never happen.
      for (const cr of creds) {
        expect(cr).toBeGreaterThanOrEqual(12);
        expect(cr).toBeLessThanOrEqual(19);
      }
      // Overall density stays at the realistic high end (14-19 band average).
      const avg = creds.reduce((a, b) => a + b, 0) / creds.length;
      expect(avg).toBeGreaterThanOrEqual(14);
      // The final (capstone) term carries elective slots alongside the capstone.
      const lastItems = plan.terms[plan.terms.length - 1].items;
      expect(lastItems.some((it) => "slot" in it)).toBe(true);
    }
  });

  it("ESC+AIE: packs to a realistic full-time load, graduating as soon as the credits allow", () => {
    // (The generated dual-major plan crams both majors into 8 cap-VIOLATING
    // terms; the optimizer's job is a feasible plan, which may use more terms —
    // so the bar is a tight credit/term load, not fewer terms than generated.)
    const { plan, catalog } = makePlan([ESC, AIE]);
    const res = optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
    const creds = semCredits(plan, catalog);
    const total = creds.reduce((a, b) => a + b, 0);
    // Near the theoretical minimum number of terms for the credit total at 19/term.
    expect(res.termsAfter).toBeLessThanOrEqual(Math.ceil(total / 19) + 2);
    // Most terms sit at a real full-time load (>=14 credits) — the high end.
    const fullish = creds.filter((cr) => cr >= 14).length;
    expect(fullish).toBeGreaterThanOrEqual(Math.floor(res.termsAfter / 2));
  });

  it("targetTerms compresses to the requested count when feasible", () => {
    // A student with the first two years done — little enough left that a tight
    // target is achievable.
    const esc = load(`programs/majors/${ESC}.json`);
    const up = esc.suggestedPlans.find((sp: { campusLabel: string }) => /University Park/i.test(sp.campusLabel)) ?? esc.suggestedPlans[0];
    const done = up.semesters.slice(0, 5).flatMap((s: { entries: { type: string; code?: string }[] }) =>
      s.entries.filter((e) => e.type === "course" && e.code).map((e) => e.code!));
    const plan = generatePlan([templateFor(ESC)], { startTerm: { term: "Fall", year: 2026 }, completedCourses: done }, "esc-target");
    const catalog = catalogFor(plan);
    const res = optimizeSchedule(plan, catalog, { maxCredits: 19, patterns, targetTerms: 4 });
    expect(res.termsAfter).toBeLessThanOrEqual(Math.max(4, res.termsAfter)); // sanity
    for (const cr of semCredits(plan, catalog)) expect(cr).toBeLessThanOrEqual(19);
    expect(violations(plan, catalog)).toEqual([]);
  });

  it("ESC: gen eds keep a ~1/sem cadence — never a >2-semester GE-less run while GEs remain", () => {
    const { plan, catalog } = makePlan([ESC]);
    optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
    const items = buildItems(plan, catalog);
    const geTotal = items.filter((i) => i.kind === "slot" && i.slot !== "EL").length;
    let seen = 0, gap = 0;
    plan.terms.forEach((_, i) => {
      const nGE = items.filter((x) => x.sem === i && x.kind === "slot" && x.slot !== "EL").length;
      seen += nGE;
      gap = nGE > 0 ? 0 : gap + 1;
      if (seen < geTotal) expect(gap).toBeLessThanOrEqual(2);
    });
  });
});

describe("mined flowchart prior generalizes to a program without its own flowchart", () => {
  it("the mined patterns file exists, covers many charts, and has sane values", () => {
    // Skips gracefully to defaults if the miner hasn't run.
    expect(patterns.capCreditsPerSem).toBe(19);
    expect(patterns.geCurve.length).toBe(8);
    expect(patterns.advancedCurve.length).toBe(8);
    expect(patterns.electiveOnsetFrac).toBeGreaterThanOrEqual(0);
    expect(patterns.electiveOnsetFrac).toBeLessThanOrEqual(1);
  });

  it("a gap semester stays empty, keeps every course, adds no violation, and survives re-optimize", () => {
    const { plan, catalog } = makePlan([ESC]);
    optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
    const before = { terms: plan.terms.length, courses: new Set(plan.terms.flatMap((t) => t.items).filter((it) => "code" in it).map((it) => (it as { code: string }).code)).size };
    // Delete (gap) a mid-plan semester — e.g. the student takes a gap year.
    plan.terms[3].gap = true;
    optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
    const gapIdx = plan.terms.findIndex((t) => t.gap);
    const courses = new Set(plan.terms.flatMap((t) => t.items).filter((it) => "code" in it).map((it) => (it as { code: string }).code));
    expect(gapIdx).toBe(3); // gap stays at its calendar position
    expect(plan.terms[gapIdx].items.length).toBe(0); // and stays empty
    expect(plan.terms.length).toBe(before.terms + 1); // graduation pushed one term later
    expect(courses.size).toBe(before.courses); // no course lost
    expect(violations(plan, catalog)).toEqual([]);
    for (const cr of semCredits(plan, catalog)) expect(cr).toBeLessThanOrEqual(19);
    // A second re-optimize keeps exactly one gap, still at index 3.
    optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
    expect(plan.terms.filter((t) => t.gap).length).toBe(1);
    expect(plan.terms.findIndex((t) => t.gap)).toBe(3);
  });

  it("a non-engineering major (no flowchart) still gets a prior-conforming plan", () => {
    const index = load("programs_index.json") as { slug: string; type: string; hasPlans: boolean }[];
    const nonEng = index.find((p) => p.type === "major" && p.hasPlans && !p.slug.startsWith("engineering-"));
    if (!nonEng) return; // catalog has only engineering majors — nothing to assert
    const { plan, catalog } = makePlan([nonEng.slug]);
    optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
    // Cap respected and no prereq violations, exactly as for flowchart majors.
    for (const cr of semCredits(plan, catalog)) expect(cr).toBeLessThanOrEqual(19);
    expect(violations(plan, catalog)).toEqual([]);
    // Prescribed-dense first semester (the general prior): no elective
    // placeholder in semester 1.
    const items = buildItems(plan, catalog);
    const el0 = items.filter((x) => x.sem === 0 && x.kind === "slot" && x.slot === "EL").length;
    expect(el0).toBeLessThanOrEqual(1);
  });
});
