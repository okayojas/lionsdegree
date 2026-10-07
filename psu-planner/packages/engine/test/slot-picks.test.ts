/** Clicking a Slot shows a student real courses they could take, ranked for
 * their Plan.
 *
 * Gen-ed Slots and elective Slots used to run down separate paths. They are
 * one path now, which is why the gen-ed behaviour is asserted here too: a
 * refactor that quietly weakened it would otherwise go unnoticed. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildCatalog,
  buildItems,
  checkCourse,
  buildSchedule,
  generatePlan,
  hydrateSearchIndex,
  majorDeptPrefixes,
  poolFromRule,
  rankSlotPicks,
  resolveSlotPool,
  type Catalog,
  type ProgramTemplate,
  type ReqSection,
} from "../src/index.js";
import { CATALOG_DIR } from "./edition.js";

const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, rel), "utf-8"));
const esc = load("programs/majors/engineering-engineering-science-bs.json");

const catalog: Catalog = buildCatalog(hydrateSearchIndex(load("search-index.json")));

const template: ProgramTemplate = {
  slug: esc.slug,
  name: esc.name,
  campusLabel: esc.suggestedPlans[0]?.campusLabel ?? "",
  semesters: esc.suggestedPlans[0]?.semesters ?? [],
  requirements: esc.requirementSections,
};
const plan = generatePlan([template], { startTerm: { term: "Fall", year: 2026 }, completedCourses: [] }, "t");
const items = buildItems(plan, catalog);
const sched = buildSchedule(plan, items, catalog);

const base = {
  exclude: new Set<string>(),
  majorPrefixes: majorDeptPrefixes(plan),
  needUS: true,
  needIL: true,
  sched,
  termIndex: plan.terms.length - 1,
};

describe("an elective Slot", () => {
  const pool = resolveSlotPool("Technical Elective", esc.requirementSections);

  it("offers the courses on its published list, where a blank card used to be", () => {
    const { picks } = rankSlotPicks(catalog, pool, base);
    expect(picks.length).toBeGreaterThan(20);
    const codes = picks.map((p) => p.course.code);
    expect(codes).toContain("CMPSC 465");
  });

  it("marks a course ready only when the plan really does satisfy it", () => {
    // Asserting that ready courses sort first would only test the comparator:
    // the flag adds +10 and the sort is by score, so it is true by
    // construction. Check the FLAG against an independent evaluation instead.
    // Checked at several terms, because readiness legitimately changes as the
    // plan fills: early on, nothing with prerequisites is satisfied yet.
    let everReady = 0;
    for (const term of [1, Math.floor(plan.terms.length / 2), plan.terms.length - 1]) {
      const { picks } = rankSlotPicks(catalog, pool, { ...base, termIndex: term });
      for (const p of picks.filter((x) => x.ready)) {
        everReady++;
        expect(checkCourse(catalog, p.course.code, term, sched).value, `${p.course.code} @${term}`).toBe(2);
        // And only claimed where there was something to satisfy.
        expect(!!(p.course.prereqAst ?? p.course.enforced), p.course.code).toBe(true);
      }
    }
    expect(everReady, "the readiness signal never fired at any term").toBeGreaterThan(0);
  });

  it("does not claim prerequisites are met on a course that has none", () => {
    const { picks } = rankSlotPicks(catalog, pool, base);
    const noPrereqs = picks.filter((p) => !(p.course.prereqAst ?? p.course.enforced));
    expect(noPrereqs.length).toBeGreaterThan(0);
    expect(noPrereqs.every((p) => !p.ready)).toBe(true);
  });

  it("never offers a course already in the plan", () => {
    const inPlan = new Set(items.filter((i) => i.kind === "course").map((i) => i.code!));
    const { picks } = rankSlotPicks(catalog, pool, { ...base, exclude: inPlan });
    expect(picks.filter((p) => inPlan.has(p.course.code))).toEqual([]);
  });

  it("says plainly that we cannot see which semesters a course runs", () => {
    // LionPATH disallows crawling, so no suggestion may imply availability.
    const { offeringsNote } = rankSlotPicks(catalog, pool, base);
    expect(offeringsNote).toMatch(/LionPATH/);
  });
});

describe("a patterned Slot", () => {
  const pool = poolFromRule({
    type: "selectCredits",
    credits: 9,
    commentRaw: "Select 9 credits of 400-level BMB, BIOL, BIOTC, or MICRB courses",
    from: { kind: "pattern", subjects: ["BMB", "BIOL", "BIOTC", "MICRB"], minLevel: 400 },
  });

  it("offers courses from every subject the requirement names", () => {
    const { picks } = rankSlotPicks(catalog, pool, base);
    const subjects = new Set(picks.map((p) => p.course.subject));
    // Holding only the first subject was the bug that made these pools wrong.
    expect(subjects.size).toBeGreaterThan(1);
    expect(picks.every((p) => parseInt(p.course.number, 10) >= 400)).toBe(true);
  });

  it("describes what qualifies, not only what it happens to list", () => {
    // A pattern admits courses the catalog may add later, so the panel has to
    // state the rule rather than implying the list is exhaustive.
    const { poolNote } = rankSlotPicks(catalog, pool, base);
    expect(poolNote).toMatch(/400/);
    expect(poolNote).toMatch(/BIOL/);
  });
});

describe("a General Education Slot keeps its behaviour, through the same path", () => {
  const pool = poolFromRule({ type: "genEd", domain: "GA", credits: 3, commentRaw: "Select 3 credits of GA" });

  it("offers only courses carrying that designation", () => {
    const { picks } = rankSlotPicks(catalog, pool, base);
    expect(picks.length).toBeGreaterThan(10);
    expect(picks.every((p) => p.course.genEd.includes("GA"))).toBe(true);
  });

  it("ranks a course that also closes an unmet US or IL requirement above one that does not", () => {
    const { picks } = rankSlotPicks(catalog, pool, base);
    const withOverlay = picks.findIndex((p) => p.bonuses.some((b) => /also fulfills (US|IL)/.test(b)));
    const without = picks.findIndex((p) => !p.bonuses.some((b) => /also fulfills (US|IL)/.test(b)));
    expect(withOverlay).toBeGreaterThanOrEqual(0);
    expect(withOverlay).toBeLessThan(without);
  });

  it("excludes the student's own department where the framework restricts it", () => {
    const prefixes = majorDeptPrefixes(plan);
    const { picks } = rankSlotPicks(catalog, pool, base);
    expect(picks.filter((p) => prefixes.has(p.course.subject))).toEqual([]);
  });

  it("ranks an honors twin above its base course for a Scholar", () => {
    const { picks } = rankSlotPicks(catalog, pool, { ...base, preferHonors: true });
    const honors = picks.findIndex((p) => p.bonuses.includes("honors credits"));
    const plain = picks.findIndex((p) => !p.bonuses.includes("honors credits"));
    expect(honors).toBeGreaterThanOrEqual(0);
    expect(honors).toBeLessThan(plain);
  });
});

describe("a Slot with no derivable list", () => {
  it("offers nothing and says why, rather than an empty list", () => {
    const pool = poolFromRule({
      type: "selectCredits",
      credits: 6,
      commentRaw: "In consultation with adviser, select 6 credits from departmental lists",
      from: null,
    });
    const { picks, poolNote } = rankSlotPicks(catalog, pool, base);
    expect(picks).toEqual([]);
    expect(poolNote).toMatch(/adviser/i);
    // The requirement's own wording is the answer.
    expect(poolNote).toMatch(/In consultation with adviser/);
  });
});

describe("every requirement section of a real program", () => {
  it("resolves without throwing", () => {
    for (const s of esc.requirementSections as ReqSection[]) {
      for (const r of s.rules) {
        expect(() => rankSlotPicks(catalog, poolFromRule(r), base)).not.toThrow();
      }
    }
  });
});
