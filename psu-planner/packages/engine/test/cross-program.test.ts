/** Cross-program fulfillment on REAL data: ESC + AIE double major — AIE
 * curriculum courses should absorb ESC's Foundational/Technical Elective
 * slots, per the ESM department elective lists. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePlan, resolveSlotPool, type ProgramTemplate } from "../src/index.js";

import { CATALOG_DIR } from "./edition.js";
const outDir = CATALOG_DIR;
const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(outDir, rel), "utf-8"));

const esc = load("programs/majors/engineering-engineering-science-bs.json");
const aie = load("programs/majors/engineering-artificial-intelligence-engineering-bs.json");

const toTemplate = (p: any, planIdx = 0): ProgramTemplate => ({
  slug: p.slug, name: p.name, campusLabel: p.suggestedPlans[planIdx]?.campusLabel ?? "",
  semesters: p.suggestedPlans[planIdx]?.semesters ?? [], requirements: p.requirementSections,
});

describe("ESC slot pools from department overrides", () => {
  it("Foundational Elective pool has the ESM list (72 courses)", () => {
    const pool = resolveSlotPool("Foundational Elective", esc.requirementSections);
    expect(pool.courses.size).toBeGreaterThanOrEqual(70);
    expect(pool.courses.has("CMPSC 221")).toBe(true);
    expect(pool.courses.has("EE 330")).toBe(true);
  });
  it("Technical Elective pool has the ESM list (227 verified courses)", () => {
    const pool = resolveSlotPool("Technical Elective", esc.requirementSections);
    expect(pool.courses.size).toBe(227); // deterministic parse of esm.psu.edu 2026-07-11; the earlier ~275 included LLM-fabricated codes
    expect(pool.courses.has("CMPSC 465")).toBe(true);
  });
});

describe("ESC + AIE double major", () => {
  const gen = (progs: ProgramTemplate[]) => generatePlan(progs, {
    startTerm: { term: "Fall", year: 2026 }, completedCourses: [], semestersCompleted: 0,
  }, "t");
  const soloEsc = gen([toTemplate(esc)]);
  const soloAie = gen([toTemplate(aie)]);
  const dual = gen([toTemplate(esc), toTemplate(aie)]);

  const slotCount = (p: typeof dual, match: RegExp) =>
    p.terms.flatMap((t) => t.items).filter((i) => "slot" in i && match.test((i as { label?: string }).label ?? "")).length;

  it("dual electives are far fewer than the two solos combined, and ESC slots got absorbed", () => {
    const el = (p: typeof dual) => slotCount(p, /Elective/i);
    // Merging + cross-fulfillment must beat naive stacking...
    expect(el(dual)).toBeLessThan(el(soloEsc) + el(soloAie));
    // ...and AIE courses specifically absorb ESC Foundational Elective slots.
    expect(slotCount(dual, /Foundational Elective/i)).toBeLessThan(slotCount(soloEsc, /Foundational Elective/i));
  });

  it("gen-ed slots are the max of the two programs, not the sum", () => {
    const ge = (p: typeof dual) => slotCount(p, /General Education/i);
    expect(ge(dual)).toBe(Math.max(ge(soloEsc), ge(soloAie)));
  });

  it("no duplicate course cards", () => {
    const codes = dual.terms.flatMap((t) => t.items.filter((i) => "code" in i).map((i: any) => i.code));
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("plan-less minor contributes requirements", () => {
  const mathMinor = load("programs/minors/eberly-science-information-sciences-technology-mathematics-minor.json");
  it("adds prescribed courses / slots for a minor without a plan grid", () => {
    const minorTemplate: ProgramTemplate = {
      slug: mathMinor.slug, name: mathMinor.name, campusLabel: "",
      semesters: [], requirements: mathMinor.requirementSections,
    };
    const dual = generatePlan([toTemplate(esc), minorTemplate], {
      startTerm: { term: "Fall", year: 2026 }, completedCourses: [], semestersCompleted: 0,
    }, "m");
    const minorItems = dual.terms.flatMap((t) => t.items).filter(
      (i) => ("program" in i && i.program === mathMinor.slug) || ("code" in i && false),
    );
    const allItems = dual.terms.flatMap((t) => t.items);
    const soloItems = generatePlan([toTemplate(esc)], {
      startTerm: { term: "Fall", year: 2026 }, completedCourses: [], semestersCompleted: 0,
    }, "s").terms.flatMap((t) => t.items);
    expect(allItems.length).toBeGreaterThan(soloItems.length); // the minor added something
    void minorItems;
  });
});
