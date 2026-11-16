/** The landing page's sample Plan is built from real Courses, and this is
 * what keeps it that way.
 *
 * The page puts 48 Course codes on the front of the site and has 48 more
 * falling past them. A code that stops resolving after a Bulletin sync is a
 * confident wrong statement in front of a student, which is the one failure
 * this project is built to avoid (iron rule 2). So the data is checked
 * against the latest Edition before every build, and a mismatch stops the
 * build. The old landing page's journey had the same guard, for the same
 * reason; this replaces it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COURSES_PER_TERM,
  SAMPLE_PLAN,
  SAMPLE_PLAN_SLOT,
  TERMS,
  assertSamplePlan,
  samplePlanHtml,
  samplePlanProblems,
  type EditionLookup,
  type SamplePlan,
} from "../src/landing/sample-plan.js";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = path.join(web, "public", "catalog");

/** The latest shipped Edition, read the way the build's own check reads it. */
function latest(): EditionLookup {
  const edition = JSON.parse(fs.readFileSync(path.join(catalog, "editions.json"), "utf-8")).latest as string;
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(catalog, edition, file), "utf-8"));
  const list = (raw: unknown, key: string): Record<string, unknown>[] =>
    Array.isArray(raw) ? raw : ((raw as Record<string, unknown[]>)[key] ?? []);
  const courses = new Set(list(read("audit-index.json"), "courses").map((c) => String(c.code)));
  const programs = new Set(list(read("programs_index.json"), "programs").map((p) => String(p.slug)));
  if (courses.size < 1000) throw new Error(`only ${courses.size} Courses read from ${edition}: run \`pnpm --filter web sync-catalog\``);
  return { edition, hasCourse: (code) => courses.has(code), hasProgram: (id) => programs.has(id) };
}

/** The real Plan with one thing changed. */
const withTerm = (index: number, courses: string[]): SamplePlan => ({
  ...SAMPLE_PLAN,
  terms: SAMPLE_PLAN.terms.map((term, i) => (i === index ? { ...term, courses } : term)),
});

describe("the sample Plan, against the latest Edition", () => {
  it("names only Courses the Edition has, and a Program it has", () => {
    expect(samplePlanProblems(SAMPLE_PLAN, latest())).toEqual([]);
  });

  it("is eight Terms of six, with as many other Courses again", () => {
    expect(SAMPLE_PLAN.terms).toHaveLength(TERMS);
    for (const term of SAMPLE_PLAN.terms) expect(term.courses, term.name).toHaveLength(COURSES_PER_TERM);
    expect(SAMPLE_PLAN.others).toHaveLength(TERMS * COURSES_PER_TERM);
    expect(SAMPLE_PLAN.terms.map((t) => t.name)).toEqual([
      "Fall 1", "Spring 1", "Fall 2", "Spring 2", "Fall 3", "Spring 3", "Fall 4", "Spring 4",
    ]);
  });
});

describe("a sample Plan the Edition does not back", () => {
  // CMPSC 999 is not a Course. If Penn State ever creates it, pick another.
  const GHOST = "CMPSC 999";

  it("stops the build over a Course in the Plan that does not exist", () => {
    const plan = withTerm(2, [GHOST, ...SAMPLE_PLAN.terms[2].courses.slice(1)]);
    const edition = latest();
    expect(samplePlanProblems(plan, edition)).toEqual([
      `${GHOST} (Fall 2) is not a Course in the ${edition.edition} Edition`,
    ]);
    // What the build's script calls. Uncaught, this is a non-zero exit.
    expect(() => assertSamplePlan(plan, edition)).toThrow(GHOST);
  });

  it("stops it over one among the other Courses, which the page never even lists", () => {
    // They are on screen all the same: the scene labels every sphere.
    const plan = { ...SAMPLE_PLAN, others: [...SAMPLE_PLAN.others.slice(1), GHOST] };
    expect(() => assertSamplePlan(plan, latest())).toThrow(`${GHOST} (the other Courses)`);
  });

  it("stops it when the Program is gone", () => {
    expect(() => assertSamplePlan({ ...SAMPLE_PLAN, program: "engineering-alchemy-bs" }, latest())).toThrow(
      /Program "engineering-alchemy-bs" is not in/,
    );
  });

  it("stops it when the shape is not the one the page promises", () => {
    const edition = latest();
    const short = withTerm(0, SAMPLE_PLAN.terms[0].courses.slice(0, 5));
    expect(samplePlanProblems(short, edition)).toContain("Fall 1 has 5 Courses, not 6");
    expect(samplePlanProblems({ ...SAMPLE_PLAN, terms: SAMPLE_PLAN.terms.slice(0, 7) }, edition)).toContain("7 Terms, not 8");
  });

  it("stops it when a Course is on the page twice", () => {
    // Twice in the Plan, or once in it and once among the ones that fall
    // away: either way one sphere is caught and its twin is not.
    const twice = { ...SAMPLE_PLAN, others: [SAMPLE_PLAN.terms[0].courses[0], ...SAMPLE_PLAN.others.slice(1)] };
    expect(samplePlanProblems(twice, latest())).toEqual(["MATH 140 is listed twice (again in the other Courses)"]);
  });

  it("is run by every build, before anything is built", () => {
    // The check is only a guard if the build cannot skip it. `build` and
    // `dev` both start with `prepage`.
    const scripts = JSON.parse(fs.readFileSync(path.join(web, "package.json"), "utf-8")).scripts as Record<string, string>;
    expect(scripts.build).toMatch(/^npm run prepage && /);
    expect(scripts.dev).toMatch(/^npm run prepage && /);
    expect(scripts.prepage.split(" && ")).toContain("npm run sample-plan");
    expect(scripts["sample-plan"]).toBe("tsx scripts/sample-plan.mts");
  });
});

describe("the sample Plan as the page prints it", () => {
  const html = samplePlanHtml(SAMPLE_PLAN);
  const text = (fragment: string) => fragment.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

  it("is a list of the eight Terms in order, six Courses in each", () => {
    const terms = html.split('<li class="plan-term">').slice(1);
    expect(terms).toHaveLength(TERMS);
    terms.forEach((term, i) => {
      expect(text(/<h3>([^<]+)<\/h3>/.exec(term)![0])).toBe(SAMPLE_PLAN.terms[i].name);
      const courses = [...term.matchAll(/<li class="course[^"]*">([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
      // As a reader, a screen reader and find-in-page meet them: "MATH 140",
      // one code, with its space.
      expect(courses).toEqual(SAMPLE_PLAN.terms[i].courses);
    });
  });

  it("does not print the Courses that fall away", () => {
    for (const code of SAMPLE_PLAN.others) expect(text(html)).not.toContain(code);
  });

  it("is written into the page by the build, not typed into it", () => {
    // The body. The <head> describes the preview image in words, and that
    // picture is of three other courses.
    const source = fs.readFileSync(path.join(web, "index.html"), "utf-8");
    const page = source.slice(source.indexOf("<body"));
    expect(page.split(SAMPLE_PLAN_SLOT), "the landing document has no place for the Plan").toHaveLength(2);
    const typed = SAMPLE_PLAN.terms.flatMap((t) => t.courses).filter((code) => page.includes(code));
    expect(typed, "Course codes typed into the landing document by hand").toEqual([]);
  });
});
