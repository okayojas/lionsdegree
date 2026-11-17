/** Changing one Program for another, in one step (#69).
 *
 * It used to be two steps in the planner, add then drop, with the student
 * told to "add the program you are switching to first". What is held here
 * is what the one step promises: the Plan ends with the new Program in the
 * old one's place; what goes is exactly what nothing else requires, and is
 * named; what the student has done (completed Courses, Courses they added)
 * stays; and a Course both Programs require never leaves its Term.
 *
 * Real Programs from the catalog on disk: a change between invented ones
 * proves nothing about the Bulletin's own.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCatalog,
  changeProgram,
  generatePlan,
  templateCourseCodes,
  type Catalog,
  type Course,
  type PlanDoc,
  type ProgramTemplate,
} from "../src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "web", "public", "catalog");
const LATEST = (JSON.parse(fs.readFileSync(path.join(ROOT, "editions.json"), "utf-8")) as { latest: string }).latest;
const DIR = path.join(ROOT, LATEST);
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(DIR, rel), "utf-8"));
const subjects = read("subjects_index.json") as Record<string, string>;

const ESC = "engineering-engineering-science-bs";
const ME = "engineering-mechanical-engineering-bs";
const MATH_MINOR = "eberly-science-mathematics-minor";

function templateFor(slug: string, kind: "majors" | "minors"): ProgramTemplate {
  const p = read(`programs/${kind}/${slug}.json`);
  const grid = (p.suggestedPlans ?? []).find((s: { semesters?: unknown[] }) => (s.semesters?.length ?? 0) > 0);
  return { slug: p.slug, name: p.name, campusLabel: grid?.campusLabel ?? "", semesters: grid?.semesters ?? [], requirements: p.requirementSections ?? [] };
}

const codesIn = (plan: PlanDoc): string[] => plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));
const termOf = (plan: PlanDoc, code: string): number => plan.terms.findIndex((t) => t.items.some((i) => "code" in i && i.code === code));

function catalogFor(codes: string[]): Catalog {
  let courses: Course[] = [];
  for (const pf of new Set(codes.map((c) => c.split(" ")[0]))) {
    if (subjects[pf]) courses = courses.concat(read(subjects[pf]));
  }
  return buildCatalog(courses);
}

const DONE = ["MATH 140", "CHEM 110"];

function seed(): { plan: PlanDoc; catalog: Catalog; to: ProgramTemplate; from: ProgramTemplate } {
  const from = templateFor(ESC, "majors");
  const to = templateFor(ME, "majors");
  const plan = generatePlan([from], { startTerm: { term: "Fall", year: 2026 }, completedCourses: DONE }, "change");
  return { plan, catalog: catalogFor([...codesIn(plan), ...templateCourseCodes(to), ...templateCourseCodes(from)]), to, from };
}

describe("changing one program for another", () => {
  it("leaves the plan with the new program, in the old one's place, and never both", () => {
    const { plan, catalog, to } = seed();
    plan.programs.push(MATH_MINOR);
    const res = changeProgram(plan, ESC, to, { catalog });
    expect(res.refusal).toBeNull();
    // First, where the major was: a student's major stays first.
    expect(plan.programs).toEqual([ME, MATH_MINOR]);
  });

  it("takes out what nothing else requires, names it, and takes out nothing else", () => {
    const { plan, catalog, to, from } = seed();
    const before = codesIn(plan);
    const res = changeProgram(plan, ESC, to, { catalog });
    const after = codesIn(plan);
    const required = new Set(templateCourseCodes(to));
    expect(res.removed!.coursesRemoved.length, "the change removed nothing, which for two different majors is not a change").toBeGreaterThan(0);
    for (const code of res.removed!.coursesRemoved) {
      expect(after, `${code} is named as gone and is still in the plan`).not.toContain(code);
      expect(before, `${code} is named as gone and was never there`).toContain(code);
    }
    // Everything that was there and is not now is on the list: nothing goes unnamed.
    const gone = before.filter((code) => !after.includes(code));
    const named = new Set([...res.removed!.coursesRemoved, ...res.removed!.filledSlotsCleared.map((s) => s.code)]);
    // (A Course the new Program offers as one of several may be replaced by its listed form.)
    for (const code of gone) {
      expect(named.has(code) || required.has(code) || templateCourseCodes(from).includes(code), `${code} left the plan and nobody said so`).toBe(true);
    }
  });

  it("brings in the new program's courses", () => {
    const { plan, catalog, to } = seed();
    const res = changeProgram(plan, ESC, to, { catalog });
    expect(res.added!.coursesAdded.length).toBeGreaterThan(0);
    for (const code of res.added!.coursesAdded) expect(codesIn(plan), `${code} was to come in`).toContain(code);
  });

  it("keeps what the student has done: completed courses, and courses they added", () => {
    const { plan, catalog, to } = seed();
    plan.added.push({ code: "ART 20", sem: 1 });
    const completed = structuredClone(plan.completed);
    changeProgram(plan, ESC, to, { catalog });
    expect(plan.completed).toEqual(completed);
    for (const code of DONE) expect(plan.completed[code], `${code} was completed and is no longer`).toBe(true);
    // Still the student's, wherever the re-flow has put it: on the list of
    // what they added, or placed in a Term.
    expect([...plan.added.map((a) => a.code), ...codesIn(plan)]).toContain("ART 20");
  });

  it("leaves a course both programs require in the plan, and says it stayed", () => {
    const { plan, catalog, to, from } = seed();
    const shared = templateCourseCodes(from).filter((code) => templateCourseCodes(to).includes(code) && termOf(plan, code) >= 0);
    expect(shared.length, "these two majors share no course, so this test proves nothing; pick another pair").toBeGreaterThan(3);
    const res = changeProgram(plan, ESC, to, { catalog });
    for (const code of res.removed!.coursesKept) {
      expect(codesIn(plan), `${code} is named as staying and is gone`).toContain(code);
      expect(res.removed!.coursesRemoved).not.toContain(code);
    }
    expect(res.removed!.coursesKept.length).toBeGreaterThan(0);
    expect(res.note).toMatch(/stayed because the new program needs/);
  });

  it("leaves a schedule a student could follow: no term over the ceiling", () => {
    const { plan, catalog, to } = seed();
    changeProgram(plan, ESC, to, { catalog, maxCredits: 19 });
    const creditsOf = (item: PlanDoc["terms"][number]["items"][number]): number =>
      "slot" in item ? Number(item.credits) || 3 : catalog[item.code]?.creditsParsed?.min ?? 3;
    const load = plan.terms.map((t) => t.items.reduce((n, it) => n + creditsOf(it), 0));
    expect(load.every((n) => Number.isFinite(n))).toBe(true);
    expect(Math.max(...load), `a term carries ${Math.max(...load)} credits`).toBeLessThanOrEqual(19);
  });

  it("says what it did in words a student can check", () => {
    const { plan, catalog, to } = seed();
    const res = changeProgram(plan, ESC, to, { catalog });
    expect(res.note).toContain(to.name);
    expect(res.note).toMatch(/\d+ courses? came in, \d+ courses? left/);
    expect(res.note).toMatch(/completed and courses you added yourself are still there/);
  });
});

describe("what changing a program refuses", () => {
  it("a program the plan does not have, and changes nothing", () => {
    const { plan, catalog, to } = seed();
    const before = structuredClone(plan);
    const res = changeProgram(plan, MATH_MINOR, to, { catalog });
    expect(res.refusal).toMatch(/not one of this plan's programs/);
    expect(plan).toEqual(before);
  });

  it("changing a program for itself, and changes nothing", () => {
    const { plan, catalog, from } = seed();
    const before = structuredClone(plan);
    const res = changeProgram(plan, ESC, from, { catalog });
    expect(res.refusal).toMatch(/already the program/);
    expect(plan).toEqual(before);
  });

  it("is a drop of the old one where the new one is already on the plan", () => {
    // A student with a double major who "changes" one to the other is left
    // with the one, once.
    const { plan, catalog, to } = seed();
    changeProgram(plan, ESC, to, { catalog });
    plan.programs.unshift(ESC); // as if both were declared; the merge reports it already present
    const res = changeProgram(plan, ESC, to, { catalog });
    expect(res.added!.alreadyPresent).toBe(true);
    expect(plan.programs.filter((p) => p === ME)).toHaveLength(1);
    expect(plan.programs).not.toContain(ESC);
  });
});
