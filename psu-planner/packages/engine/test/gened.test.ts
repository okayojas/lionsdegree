/** Gen Ed framework: audit arithmetic, double-count optimization, slot
 * refinement (category naming + excess dropping + US/IL hints), and
 * suggestion ranking. Synthetic units + ESC real-data scenario. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditGenEd, buildCatalog, countableCourses, generatePlan, majorDeptPrefixes,
  optimizeSchedule, rankGenEdPicks, refineGenEdSlots, astCourses,
  GENED_BUCKETS, IL_ATTR, US_ATTR, INTERDOMAIN_ATTR,
  type Catalog, type Course, type PlanDoc, type ProgramTemplate,
} from "../src/index.js";

import { CATALOG_DIR } from "./edition.js";
const outDir = CATALOG_DIR;
const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(outDir, rel), "utf-8"));

function course(code: string, genEd: string[], attributes: string[] = [], credits = 3): Course {
  const [subject, number] = code.split(" ");
  return {
    code, subject, number, display: code, title: code, credits: String(credits),
    creditsParsed: { min: credits, max: credits, repeatableMax: null },
    description: "", enforced: null, concurrent: null, prereqAdvisory: null,
    prereqAst: null, concurrentAst: null, astComplete: true,
    genEd, attributes, crossListings: [], aliases: [], level: "undergraduate", url: "",
  };
}

describe("gen-ed audit arithmetic", () => {
  it("assigns courses most-constrained-first and never double-fills a bucket", () => {
    const cat = buildCatalog([
      course("ENGL 15", ["GWS"]), course("CAS 100", ["GWS"]), course("ENGL 202C", ["GWS"]),
      course("MATH 140", ["GQ"], [], 4), course("MATH 141", ["GQ"], [], 4),
      course("CHEM 110", ["GN"]), course("PHYS 211", ["GN"], [], 4), course("PHYS 212", ["GN"], [], 4),
      course("PHYS 214", ["GN"], [], 2), course("ECON 102", ["GS"]),
    ]);
    const cc = Object.keys(cat).map((code) => ({ code, endorsed: true }));
    const audit = auditGenEd(cc, cat, new Set());
    const by = Object.fromEntries(audit.buckets.map((b) => [b.key, b]));
    expect(by.GWS.got).toBe(9);
    expect(by.GQ.got).toBe(8); // two 4-credit courses, both needed to pass 6
    expect(by.GN.got).toBeGreaterThanOrEqual(3);
    expect(by.EXPGN.got).toBeGreaterThanOrEqual(3);
    expect(by.GS.got).toBe(3);
    // GN family (domain + exploration GN + flexible exploration) fully covered
    // by the sciences — the double-count payoff.
    expect(by.EXP.got).toBeGreaterThanOrEqual(6);
    // Still remaining: GHW, GA, GH, INTER.
    const rem = audit.remaining.map((r) => r.key);
    expect(rem).toEqual(["GHW", "GA", "GH", "INTER"]);
  });

  it("inter-domain courses fill Integrative Studies, not single domains", () => {
    const cat = buildCatalog([course("ENGL 115N", ["GA", "GH", INTERDOMAIN_ATTR])]);
    const audit = auditGenEd([{ code: "ENGL 115N", endorsed: true }], cat, new Set());
    const by = Object.fromEntries(audit.buckets.map((b) => [b.key, b]));
    expect(by.INTER.got).toBe(3);
    expect(by.GA.got).toBe(0);
    expect(by.GH.got).toBe(0);
  });

  it("dept restriction blocks non-endorsed own-dept courses from Knowledge Domains but not Foundations/Integrative", () => {
    const cat = buildCatalog([
      course("ESC 261M", ["GN"]), // hypothetical own-dept GN course, user-added
      course("ESC 100N", ["GN", "GS", INTERDOMAIN_ATTR]),
      course("ESC 140", ["GQ"]),
    ]);
    const prefixes = new Set(["ESC"]);
    const audit = auditGenEd(
      [{ code: "ESC 261M", endorsed: false }, { code: "ESC 100N", endorsed: false }, { code: "ESC 140", endorsed: false }],
      cat, prefixes,
    );
    const by = Object.fromEntries(audit.buckets.map((b) => [b.key, b]));
    expect(by.GN.got).toBe(0); // restricted
    expect(by.INTER.got).toBe(3); // Integrative Studies exempt
    expect(by.GQ.got).toBe(3); // Foundations exempt
    // Endorsed template courses DO count everywhere.
    const audit2 = auditGenEd([{ code: "ESC 261M", endorsed: true }], cat, prefixes);
    expect(Object.fromEntries(audit2.buckets.map((b) => [b.key, b])).GN.got).toBe(3);
  });

  it("US/IL overlay: double-counts with anything, but one course cannot cover both", () => {
    const both = course("HIST 10", ["GH"], [US_ATTR, IL_ATTR]);
    const cat1 = buildCatalog([both]);
    const a1 = auditGenEd([{ code: "HIST 10", endorsed: true }], cat1, new Set());
    // Only one of the two overlays may claim the single dual-designated course.
    expect([a1.us.remaining, a1.il.remaining].filter((r) => r).length).toBe(1);

    const cat2 = buildCatalog([both, course("HIST 3", ["GH"], [US_ATTR])]);
    const a2 = auditGenEd([{ code: "HIST 10", endorsed: true }, { code: "HIST 3", endorsed: true }], cat2, new Set());
    // Single-designation US course takes US, dual course is free for IL.
    expect(a2.us.remaining).toBe(false);
    expect(a2.il.remaining).toBe(false);
    expect(a2.us.satisfiedBy).toBe("HIST 3");
    expect(a2.il.satisfiedBy).toBe("HIST 10");
  });
});

describe("suggestion ranking", () => {
  it("filters by category, excludes own-dept, ranks needed-IL carriers first", () => {
    const cat = buildCatalog([
      course("ART 20", ["GA"]),
      course("MUSIC 5", ["GA"], [IL_ATTR]),
      course("ESC 21", ["GA"]), // own dept — excluded for restricted GA
      course("PHIL 10", ["GH"]), // wrong category
    ]);
    const picks = rankGenEdPicks(cat, "GA", { majorPrefixes: new Set(["ESC"]), needUS: false, needIL: true, exclude: new Set() });
    expect(picks.map((p) => p.course.code)).toEqual(["MUSIC 5", "ART 20"]);
    expect(picks[0].bonuses).toContain("also fulfills IL");
  });
});

describe("ESC real data: slot refinement end-to-end", () => {
  const subjects = load("subjects_index.json") as Record<string, string>;
  function makeEsc(): { plan: PlanDoc; catalog: Catalog } {
    const p = load("programs/majors/engineering-engineering-science-bs.json");
    const up = p.suggestedPlans.find((sp: { campusLabel: string }) => /University Park/i.test(sp.campusLabel)) ?? p.suggestedPlans[0];
    const tmpl: ProgramTemplate = { slug: p.slug, name: p.name, campusLabel: "", semesters: up.semesters, requirements: p.requirementSections };
    const plan = generatePlan([tmpl], { startTerm: { term: "Fall", year: 2026 }, completedCourses: [] }, "gened-esc");
    const prefixes = new Set<string>();
    for (const t of plan.terms) for (const i of t.items) if ("code" in i) prefixes.add(i.code.split(" ")[0]);
    let courses: Course[] = [];
    for (const pf of prefixes) if (subjects[pf]) courses = courses.concat(load(subjects[pf]));
    const hop = new Set<string>();
    for (const c of courses) for (const ast of [c.prereqAst, c.concurrentAst]) if (ast) for (const code of astCourses(ast)) hop.add(code.split(" ")[0]);
    for (const pf of hop) if (!prefixes.has(pf) && subjects[pf]) courses = courses.concat(load(subjects[pf]));
    return { plan, catalog: buildCatalog(courses) };
  }

  it("names every generic GE slot by category, drops covered ones, hints IL/US", () => {
    const { plan, catalog } = makeEsc();
    const before = plan.terms.flatMap((t) => t.items).filter((it) => "slot" in it && it.slot !== "EL").length;
    const res = refineGenEdSlots(plan, catalog);
    const removed = plan.removed ?? {};
    const live = plan.terms.flatMap((t) => t.items)
      .filter((it): it is Extract<typeof it, { slot: string }> => "slot" in it && it.slot !== "EL" && !removed[it.id]);
    // No anonymous "GE" cards remain — every live slot carries a framework category.
    const keys = new Set(GENED_BUCKETS.map((b) => b.key));
    for (const s of live) expect(keys.has(s.slot)).toBe(true);
    // The sciences/econ in the major cover GN + Exploration + GS -> fewer cards
    // than the template's generic set.
    expect(live.length).toBeLessThan(before);
    expect(res.dropped.length).toBeGreaterThan(0);
    // ESC's template has no IL course -> exactly one slot carries the IL hint.
    const hinted = live.filter((s) => /carries IL/.test(s.label ?? ""));
    expect(hinted.length).toBe(1);
    // Framework must remain fully satisfiable: remaining buckets all have slots.
    const audit = auditGenEd(countableCourses(plan), catalog, majorDeptPrefixes(plan));
    for (const r of audit.remaining) {
      const slotCr = live.filter((s) => s.slot === r.key).reduce((sum, s) => sum + (Number(s.credits) || 3), 0);
      expect(slotCr).toBeGreaterThanOrEqual(r.credits);
    }
  });

  it("is idempotent and survives the optimizer", () => {
    const { plan, catalog } = makeEsc();
    refineGenEdSlots(plan, catalog);
    const snapshot = JSON.stringify(plan.terms) + JSON.stringify(plan.removed);
    const res2 = refineGenEdSlots(plan, catalog);
    expect(res2.dropped).toEqual([]);
    expect(res2.added).toEqual([]);
    expect(JSON.stringify(plan.terms) + JSON.stringify(plan.removed)).toBe(snapshot);
    // Optimizer keeps the named categories on the cards.
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    const live = plan.terms.flatMap((t) => t.items)
      .filter((it) => "slot" in it && it.slot !== "EL" && !(plan.removed ?? {})[("slot" in it ? it.id : "")]);
    const keys = new Set(GENED_BUCKETS.map((b) => b.key));
    for (const s of live) if ("slot" in s) expect(keys.has(s.slot)).toBe(true);
  });
});
