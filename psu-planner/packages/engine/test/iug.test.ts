/** IUG attach: fold a scraped master's onto an undergrad plan as grad-phase
 * terms, double-count per GCAC-210, and survive re-optimization. Runs over the
 * real ESM IUG (scripts/scrapeIug.ts output) + a real ESC undergrad plan. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  astCourses, attachIug, auditIug, buildCatalog, buildItems, buildSchedule, checkCourse,
  detachIug, generatePlan, optimizeSchedule, pickTrack,
  type Catalog, type Course, type IugSpec, type PlanDoc, type ProgramTemplate,
} from "../src/index.js";

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/catalog");
const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(outDir, rel), "utf-8"));
const subjects = load("subjects_index.json") as Record<string, string>;
const iugAvailable = fs.existsSync(path.join(outDir, "iug/esm-esc-bs-ms.json"));

function loadCoursesFor(codes: Iterable<string>): Course[] {
  const prefixes = new Set<string>();
  for (const c of codes) prefixes.add(c.split(" ")[0]);
  let courses: Course[] = [];
  for (const p of prefixes) {
    for (const key of [p, `${p}:grad`]) if (subjects[key]) courses = courses.concat(load(subjects[key]));
  }
  return courses;
}

function escPlan(): { plan: PlanDoc; catalog: Catalog } {
  const p = load("programs/majors/engineering-engineering-science-bs.json");
  const up = p.suggestedPlans.find((sp: { campusLabel: string }) => /University Park/i.test(sp.campusLabel)) ?? p.suggestedPlans[0];
  const tmpl: ProgramTemplate = { slug: p.slug, name: p.name, campusLabel: "", semesters: up.semesters, requirements: p.requirementSections };
  const plan = generatePlan([tmpl], { startTerm: { term: "Fall", year: 2026 }, completedCourses: [] }, "iug-esc");
  const codes = new Set<string>();
  for (const t of plan.terms) for (const i of t.items) if ("code" in i) codes.add(i.code);
  let courses = loadCoursesFor(codes);
  const hop = new Set<string>();
  for (const c of courses) for (const ast of [c.prereqAst, c.concurrentAst]) if (ast) for (const code of astCourses(ast)) hop.add(code.split(" ")[0]);
  courses = courses.concat(loadCoursesFor([...hop].map((p) => `${p} 1`)));
  return { plan, catalog: buildCatalog(courses) };
}

describe.skipIf(!iugAvailable)("ESM Engineering Science IUG attach (real data)", () => {
  const spec: IugSpec = iugAvailable ? load("iug/esm-esc-bs-ms.json") : ({} as IugSpec);
  const gradCatalog = iugAvailable ? buildCatalog(loadCoursesFor([
    ...spec.gradTracks.flatMap((t) => t.sections.flatMap((s) => s.rules.flatMap((r) =>
      r.type === "course" ? [r.code] : "options" in r ? r.options : []))),
    ...spec.doubleCount.eligible,
  ])) : {};

  it("pickTrack picks the leanest master's track (not an 81-credit block)", () => {
    const t = pickTrack(spec);
    const cr = spec.gradTracks[t].totalCredits;
    expect(cr).not.toBeNull();
    expect(cr!).toBeLessThanOrEqual(35); // M.S. ~31-32, never a doctoral block
  });

  it("attaches grad terms after the bachelor's, double-counts eligible in-plan courses, keeps UG capstone last in the UG phase", () => {
    const { plan, catalog } = escPlan();
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    const ugTermCount = plan.terms.length;
    const fullCat = { ...catalog, ...gradCatalog };

    const res = attachIug(plan, spec, fullCat);
    // Grad terms appended, all after the undergrad terms.
    const gradTerms = plan.terms.filter((t) => t.phase === "grad");
    expect(gradTerms.length).toBeGreaterThan(0);
    expect(plan.terms.slice(0, ugTermCount).every((t) => t.phase !== "grad")).toBe(true);
    expect(plan.terms.slice(ugTermCount).every((t) => t.phase === "grad")).toBe(true);
    expect(plan.iug?.slug).toBe("esm-esc-bs-ms");

    // ESC 404 and EMCH 400 are on ESM's double-count-eligible list AND in the
    // ESC undergrad plan → they must be double-counted, not re-scheduled.
    const gradCourseCodes = gradTerms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));
    for (const dc of res.doubleCounted) expect(gradCourseCodes).not.toContain(dc);
    expect(res.doubleCounted.length).toBeGreaterThan(0);
    // GCAC-210 program cap honored.
    const dcCredits = res.doubleCounted.reduce((s, c) => s + (fullCat[c]?.creditsParsed?.min ?? 3), 0);
    expect(dcCredits).toBeLessThanOrEqual(spec.doubleCount.maxCredits);

    // Undergrad capstone still sits in the undergrad phase (grad thesis is separate).
    const escCap = plan.terms.findIndex((t) => t.items.some((i) => "code" in i && i.code === "ESC 411"));
    expect(plan.terms[escCap].phase).not.toBe("grad");
  });

  it("re-optimizing after attach preserves the grad terms and stays violation-free", () => {
    const { plan, catalog } = escPlan();
    const fullCat = { ...catalog, ...gradCatalog };
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    attachIug(plan, spec, fullCat);
    const gradBefore = plan.terms.filter((t) => t.phase === "grad").length;

    optimizeSchedule(plan, fullCat, { maxCredits: 19 });
    expect(plan.terms.filter((t) => t.phase === "grad").length).toBe(gradBefore);
    // Undergrad half still has no prereq violations.
    const items = buildItems(plan, fullCat);
    const sched = buildSchedule(plan, items, fullCat);
    const ugTerms = new Set(plan.terms.map((t, i) => (t.phase === "grad" ? -1 : i)).filter((i) => i >= 0));
    const bad = items
      .filter((i) => i.kind === "course" && i.code && fullCat[i.code] && ugTerms.has(i.sem))
      .filter((i) => checkCourse(fullCat, i.code!, i.sem, sched).value === 0)
      .map((i) => i.code);
    expect(bad).toEqual([]);
  });

  it("detachIug returns a plain bachelor's", () => {
    const { plan, catalog } = escPlan();
    const fullCat = { ...catalog, ...gradCatalog };
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    const ugCount = plan.terms.length;
    attachIug(plan, spec, fullCat);
    detachIug(plan);
    expect(plan.iug).toBeUndefined();
    expect(plan.terms.every((t) => t.phase !== "grad")).toBe(true);
    expect(plan.terms.length).toBe(ugCount);
  });

  it("auditIug reports credits and the GCAC-210 application gate", () => {
    const { plan, catalog } = escPlan();
    const fullCat = { ...catalog, ...gradCatalog };
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    attachIug(plan, spec, fullCat);
    const audit = auditIug(plan, spec, fullCat)!;
    expect(audit.attached).toBe(true);
    expect(audit.gradDegree).toMatch(/Engineering Science/);
    expect(audit.doubleCountCredits).toBeLessThanOrEqual(audit.maxDoubleCount);
    expect(audit.notes.some((n) => /60 credits/.test(n))).toBe(true);
  });
});
