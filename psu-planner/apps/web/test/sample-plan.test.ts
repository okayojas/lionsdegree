/** The landing page's sample Plan is built from real Courses, and this is
 * what keeps it that way.
 *
 * The page puts 48 Course codes on the front of the site, and the same file
 * holds 48 more for the scene to show (#65). A code that stops resolving
 * after a Bulletin sync is a confident wrong statement in front of a student,
 * which is the one failure this project is built to avoid (iron rule 2). So
 * the data is checked against the latest Edition before every build, and a
 * mismatch stops the build. The old landing page's journey had the same
 * guard, for the same reason; this replaces it.
 *
 * What the page then PRINTS (eight Terms in order, six Courses in each, none
 * of the others) is the browser suite's to say: e2e/landing.spec.ts.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COURSES_PER_TERM,
  SAMPLE_PLAN,
  SAMPLE_PLAN_MARKER,
  TERM_COUNT,
  assertSamplePlan,
  samplePlanProblems,
  type EditionLookup,
  type SamplePlan,
} from "../src/landing/sample-plan.js";
import { courseCodes, latestEdition, programSlugs } from "../scripts/catalog-programs.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The latest shipped Edition, through the loader the build's check uses. */
function latest(): EditionLookup {
  const edition = latestEdition();
  const courses = courseCodes(edition);
  const programs = programSlugs(edition);
  if (courses.size < 1000) throw new Error(`only ${courses.size} Courses read from ${edition}: run \`pnpm --filter web sync-catalog\``);
  return { edition, hasCourse: (code) => courses.has(code), hasProgram: (id) => programs.has(id) };
}

/** The real Plan with one Term's Courses changed. */
const withTerm = (index: number, courses: string[]): SamplePlan => ({
  ...SAMPLE_PLAN,
  terms: SAMPLE_PLAN.terms.map((term, i) => (i === index ? { ...term, courses } : term)),
});

describe("the sample Plan, against the latest Edition", () => {
  it("names only Courses the Edition has, and a Program it has", () => {
    expect(samplePlanProblems(SAMPLE_PLAN, latest())).toEqual([]);
  });

  it("is eight Terms of six, with as many other Courses again", () => {
    expect(SAMPLE_PLAN.terms).toHaveLength(TERM_COUNT);
    for (const term of SAMPLE_PLAN.terms) expect(term.courses, term.name).toHaveLength(COURSES_PER_TERM);
    expect(SAMPLE_PLAN.others).toHaveLength(TERM_COUNT * COURSES_PER_TERM);
    expect(SAMPLE_PLAN.terms.map((t) => t.name)).toEqual([
      "Fall 1", "Spring 1", "Fall 2", "Spring 2", "Fall 3", "Spring 3", "Fall 4", "Spring 4",
    ]);
  });
});

describe("a sample Plan the Edition does not back", () => {
  // CMPSC 999 is not a Course. If Penn State ever creates it, pick another.
  const GHOST = "CMPSC 999";

  it("is refused over a Course in the Plan that does not exist", () => {
    const plan = withTerm(2, [GHOST, ...SAMPLE_PLAN.terms[2].courses.slice(1)]);
    const edition = latest();
    expect(samplePlanProblems(plan, edition)).toEqual([
      `${GHOST} (Fall 2) is not a Course in the ${edition.edition} Edition`,
    ]);
    expect(() => assertSamplePlan(plan, edition)).toThrow(GHOST);
  });

  it("is refused over one among the other Courses, which the page never lists", () => {
    // They will be on screen all the same: the scene labels every sphere.
    const plan = { ...SAMPLE_PLAN, others: [...SAMPLE_PLAN.others.slice(1), GHOST] };
    expect(() => assertSamplePlan(plan, latest())).toThrow(`${GHOST} (the other Courses)`);
  });

  it("is refused when the Program is gone", () => {
    expect(() => assertSamplePlan({ ...SAMPLE_PLAN, program: "engineering-alchemy-bs" }, latest())).toThrow(
      /Program "engineering-alchemy-bs" is not in/,
    );
  });

  it("is refused when the shape is not the one the page promises", () => {
    const edition = latest();
    const short = withTerm(0, SAMPLE_PLAN.terms[0].courses.slice(0, 5));
    expect(samplePlanProblems(short, edition)).toContain("Fall 1 has 5 Courses, not 6");
    expect(samplePlanProblems({ ...SAMPLE_PLAN, terms: SAMPLE_PLAN.terms.slice(0, 7) }, edition)).toContain("7 Terms, not 8");
  });

  it("is refused when a Course is on the page twice", () => {
    // Twice in the Plan, or once in it and once among the ones that fall
    // away: either way one sphere is caught and its twin is not.
    const twice = { ...SAMPLE_PLAN, others: [SAMPLE_PLAN.terms[0].courses[0], ...SAMPLE_PLAN.others.slice(1)] };
    expect(samplePlanProblems(twice, latest())).toEqual(["MATH 140 is listed twice (again in the other Courses)"]);
  });
});

describe("the build's own check", () => {
  /** The script `npm run build` runs first, run for real. The cases above
   * show the CHECK refusing a bad Plan; these show the BUILD stopping, which
   * is a different claim: a script that caught the error and carried on would
   * pass every one of them. */
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const check = (...args: string[]) =>
    spawnSync(process.execPath, [tsx, path.join(web, "scripts", "sample-plan.mts"), ...args], { cwd: web, encoding: "utf-8" });

  it("passes against the shipped catalog", () => {
    const run = check();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/96 Courses, all in the \d{4}-\d{4} Edition/);
  });

  it("exits non-zero, naming the Course, when the Edition has lost one", () => {
    // The realistic failure: nobody edits the Plan, and a Bulletin sync
    // drops a Course out from under it. A catalog like the shipped one,
    // without CMPSC 461.
    const RETIRED = "CMPSC 461";
    const edition = latestEdition();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-catalog-"));
    try {
      fs.mkdirSync(path.join(dir, edition));
      fs.writeFileSync(path.join(dir, "editions.json"), JSON.stringify({ latest: edition }));
      fs.writeFileSync(
        path.join(dir, edition, "audit-index.json"),
        JSON.stringify([...courseCodes(edition)].filter((code) => code !== RETIRED).map((code) => ({ code }))),
      );
      fs.writeFileSync(
        path.join(dir, edition, "programs_index.json"),
        JSON.stringify([...programSlugs(edition)].map((slug) => ({ slug }))),
      );
      const run = check("--catalog", dir);
      expect(run.status, "the check passed a Plan naming a Course the catalog does not have").not.toBe(0);
      expect(run.stderr).toContain(`${RETIRED} (Spring 3) is not a Course in the ${edition} Edition`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is run by every build, before anything is built", () => {
    // A guard the build can skip is not one. `build` and `dev` both start
    // with `prepage`.
    const scripts = JSON.parse(fs.readFileSync(path.join(web, "package.json"), "utf-8")).scripts as Record<string, string>;
    expect(scripts.build).toMatch(/^npm run prepage && /);
    expect(scripts.dev).toMatch(/^npm run prepage && /);
    expect(scripts.prepage.split(" && ")).toContain("npm run sample-plan");
    expect(scripts["sample-plan"]).toBe("tsx scripts/sample-plan.mts");
  });
});

describe("the sample Plan in the landing document", () => {
  it("is written in by the build, not typed in", () => {
    const source = fs.readFileSync(path.join(web, "index.html"), "utf-8");
    expect(source.split(SAMPLE_PLAN_MARKER), "the landing document has no place for the Plan").toHaveLength(2);
    // The body. The <head> describes the preview image in words, and names
    // three courses in doing so.
    const body = source.slice(source.indexOf("<body"));
    const typed = SAMPLE_PLAN.terms.flatMap((t) => t.courses).filter((code) => body.includes(code));
    expect(typed, "Course codes typed into the landing document by hand").toEqual([]);
  });
});
