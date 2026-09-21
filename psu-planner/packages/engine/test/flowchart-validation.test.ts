/** Flowchart validation harness: the Engineering Advising Center's official
 * prerequisite flowcharts (advising.engr.psu.edu, spatially parsed by the
 * pipeline's scripts/parse_flowcharts.py into parsed.json) are the quality
 * gate for every engineering major:
 *   GATE 1 — our generated plan, after repairPrereqOrdering, has ZERO
 *            prerequisite violations.
 *   GATE 2 — most courses the official flowchart places are in our plan too
 *            (options legitimately diverge, so the bar is shared-majority).
 *   GATE 3 — known regressions pinned exactly (AIE STAT 401, ESC 410H).
 * Placement differences beyond that are reported informationally — the
 * flowcharts sometimes deviate from the bulletin by department preference. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  astCourses, buildCatalog, buildItems, buildSchedule, checkCourse, generatePlan,
  repairPrereqOrdering, type Catalog, type Course, type PlanDoc, type ProgramTemplate,
} from "../src/index.js";

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/catalog");
// parsed.json is force-added to the repo (the source PDFs are not redistributed —
// see NOTICE), so this stays anchored to the pipeline rather than derived from outDir.
const flowDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../psu-catalog-pipeline/data/flowcharts");
const parsed: Record<string, Record<string, string[]>> = JSON.parse(fs.readFileSync(path.join(flowDir, "parsed.json"), "utf-8"));
const subjectsIndex: Record<string, string> = JSON.parse(fs.readFileSync(path.join(outDir, "subjects_index.json"), "utf-8"));

/** flowchart pdf name -> bulletin program slug. EMET excluded: its chart is a
 * prerequisite web with no semester columns. */
const MAP: Record<string, string> = {
  AERSP: "engineering-aerospace-engineering-bs",
  AIE: "engineering-artificial-intelligence-engineering-bs",
  "BE-ag-option": "engineering-biological-engineering-bs",
  "BE-food-bio-option": "engineering-biological-engineering-bs",
  "BE-natural-resource-option": "engineering-biological-engineering-bs",
  "BME---Biomaterials-Option": "engineering-biomedical-engineering-bs",
  "BME---Biomechanics-Option": "engineering-biomedical-engineering-bs",
  "BME---Med-Dev-Design-Option-2025-Vizio": "engineering-biomedical-engineering-bs",
  "BME---Med-Imag-and-Dev-Option": "engineering-biomedical-engineering-bs",
  "BME---Med-Imaging-Option-2025-Vizio": "engineering-biomedical-engineering-bs",
  "BME-Biochemical-Option1": "engineering-biomedical-engineering-bs",
  "BME-Biopharm-Option": "engineering-biomedical-engineering-bs",
  "BME-biomechanics-option": "engineering-biomedical-engineering-bs",
  CE: "engineering-civil-engineering-bs",
  CHE: "engineering-chemical-engineering-bs",
  CMPEN: "engineering-computer-engineering-bs",
  "CMPSC---Computer-Science-1": "engineering-computer-science-bs",
  "CMPSC-2026": "engineering-computer-science-bs",
  EE: "engineering-electrical-engineering-bs",
  ESC: "engineering-engineering-science-bs",
  IE: "engineering-industrial-engineering-bs",
  "IE-SSE-Option": "engineering-industrial-engineering-bs",
  SURE: "engineering-surveying-engineering-bs",
};

function loadSubjectsFor(codes: Iterable<string>): Course[] {
  const prefixes = new Set<string>();
  for (const c of codes) prefixes.add(c.split(" ")[0]);
  let courses: Course[] = [];
  for (const p of prefixes) {
    if (subjectsIndex[p]) courses = courses.concat(JSON.parse(fs.readFileSync(path.join(outDir, subjectsIndex[p]), "utf-8")));
  }
  // one prereq hop
  const hop = new Set<string>();
  for (const c of courses) {
    for (const ast of [c.prereqAst, c.concurrentAst]) {
      if (ast) for (const code of astCourses(ast)) {
        const p = code.split(" ")[0];
        if (!prefixes.has(p)) hop.add(p);
      }
    }
  }
  for (const p of hop) {
    if (subjectsIndex[p]) courses = courses.concat(JSON.parse(fs.readFileSync(path.join(outDir, subjectsIndex[p]), "utf-8")));
  }
  return courses;
}

interface Generated { plan: PlanDoc; catalog: Catalog }
const cache = new Map<string, Generated>();
function generateFor(slug: string): Generated {
  const hit = cache.get(slug);
  if (hit) return hit;
  const prog = JSON.parse(fs.readFileSync(path.join(outDir, `programs/majors/${slug}.json`), "utf-8"));
  const up = prog.suggestedPlans.find((sp: { campusLabel: string }) => /University Park/i.test(sp.campusLabel)) ?? prog.suggestedPlans[0];
  const template: ProgramTemplate = {
    slug: prog.slug, name: prog.name, campusLabel: up.campusLabel,
    semesters: up.semesters, requirements: prog.requirementSections,
  };
  const plan = generatePlan([template], {
    startTerm: { term: "Fall", year: 2026 }, completedCourses: [], semestersCompleted: 0,
  }, slug);
  const codes = plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));
  const catalog = buildCatalog(loadSubjectsFor(codes));
  repairPrereqOrdering(plan, catalog);
  const gen = { plan, catalog };
  cache.set(slug, gen);
  return gen;
}

function planPlacements(plan: PlanDoc): Map<string, number> {
  const m = new Map<string, number>();
  plan.terms.forEach((t, i) => {
    for (const it of t.items) if ("code" in it) m.set(it.code, i + 1); // 1-indexed like flowcharts
  });
  return m;
}

const slugs = [...new Set(Object.values(MAP))];

describe("GATE 1: zero prereq violations after repair, every engineering major", () => {
  for (const slug of slugs) {
    it(slug, () => {
      const { plan, catalog } = generateFor(slug);
      const items = buildItems(plan, catalog);
      const sched = buildSchedule(plan, items, catalog);
      const bad = items
        .filter((i) => i.kind === "course" && i.code && catalog[i.code])
        .filter((i) => checkCourse(catalog, i.code!, i.sem, sched).value === 0)
        .map((i) => `${i.code}@sem${i.sem + 1}`);
      expect(bad).toEqual([]);
    });
  }
});

describe("GATE 2: official flowchart courses are covered by our plan", () => {
  for (const [pdf, slug] of Object.entries(MAP)) {
    const chart = parsed[pdf];
    if (!chart) continue;
    const chartCourses = Object.values(chart).flat();
    if (chartCourses.length < 15) continue; // parse too sparse to judge
    it(`${pdf} -> ${slug}`, () => {
      const { plan, catalog } = generateFor(slug);
      const placements = planPlacements(plan);
      const inPlanOrAlternative = (code: string) => {
        if (placements.has(code)) return true;
        // Flowcharts list specific options ("CMPSC 121") where our plan holds
        // the default of the same alternatives group.
        for (const t of plan.terms) {
          for (const it of t.items) {
            if ("code" in it && (it.alternatives ?? []).includes(code)) return true;
          }
        }
        return false;
      };
      // Judge only codes the catalog knows — flowchart parse noise and
      // discontinued codes shouldn't count against coverage.
      const considered = chartCourses.filter((c) => catalog[c]);
      const covered = considered.filter(inPlanOrAlternative);
      const ratio = considered.length ? covered.length / considered.length : 1;
      if (ratio < 0.6) {
        console.log(`  [coverage:${pdf}] missing from our plan:`, considered.filter((c) => !inPlanOrAlternative(c)).join(", "));
      }
      expect(ratio).toBeGreaterThanOrEqual(0.6);
    });
  }
});

describe("GATE 3: pinned regressions from the investigations", () => {
  it("AIE: STAT 401 sits in semester 3 (official flowchart placement)", () => {
    const { plan } = generateFor(MAP.AIE);
    expect(planPlacements(plan).get("STAT 401")).toBe(3);
    expect(parsed.AIE["3"]).toContain("STAT 401");
  });
  it("ESC: dept flowchart says ESC 410H (confirming the bulletin-typo fix) and we schedule it", () => {
    const flowSem = Number(Object.entries(parsed.ESC).find(([, v]) => v.includes("ESC 410H"))?.[0]);
    expect(flowSem).toBeGreaterThan(0);
    const { plan } = generateFor(MAP.ESC);
    expect(planPlacements(plan).get("ESC 410H")).toBeDefined();
  });
});

describe("informational placement diff report", () => {
  it("prints diffs >=2 semesters between our plans and the official flowcharts", () => {
    const lines: string[] = [];
    for (const [pdf, slug] of Object.entries(MAP)) {
      const chart = parsed[pdf];
      if (!chart) continue;
      const { plan } = generateFor(slug);
      const placements = planPlacements(plan);
      for (const [sem, codes] of Object.entries(chart)) {
        for (const code of codes) {
          const ours = placements.get(code);
          if (ours && Math.abs(ours - Number(sem)) >= 2) {
            lines.push(`${pdf}: ${code} flowchart=sem${sem} ours=sem${ours}`);
          }
        }
      }
    }
    console.log(`[flowchart-diff] ${lines.length} placement differences >=2 semesters:`);
    for (const l of lines.slice(0, 40)) console.log("  " + l);
    expect(true).toBe(true);
  });
});
