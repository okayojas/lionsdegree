/** Schreyer Honors College: detection, requirement-window math per admit
 * cohort, completed-credit pooling, honors-section upgrades, thesis detection,
 * and the H-twin prereq stand-in. Synthetic units + ESC real-data e2e. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyHonorsUpgrades, astCourses, auditHonors, buildCatalog, buildItems, buildSchedule,
  checkCourse, generatePlan, honorsWindows, isHonorsCourse, optimizeSchedule,
  type Catalog, type Course, type PlanDoc, type ProgramTemplate,
} from "../src/index.js";

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/catalog");
const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(outDir, rel), "utf-8"));
const subjects = load("subjects_index.json") as Record<string, string>;

function course(code: string, opts: { credits?: number; attrs?: string[]; title?: string; enforced?: string } = {}): Course {
  const [subject, number] = code.split(" ");
  const credits = opts.credits ?? 3;
  return {
    code, subject, number, display: code, title: opts.title ?? code, credits: String(credits),
    creditsParsed: { min: credits, max: credits, repeatableMax: null },
    description: "", enforced: opts.enforced ?? null, concurrent: null, prereqAdvisory: null,
    prereqAst: null, concurrentAst: null, astComplete: true,
    genEd: [], attributes: opts.attrs ?? [], crossListings: [], aliases: [], level: "undergraduate", url: "",
  };
}

function basePlan(over: Partial<PlanDoc>): PlanDoc {
  return {
    id: "t", rev: 1, updatedAt: "", programs: [], terms: [], completed: {}, moves: {},
    slotFills: {}, added: [], removed: {}, view: null, ...over,
  };
}

describe("honors detection + windows", () => {
  it("detects the Honors attribute and H/M suffixes", () => {
    expect(isHonorsCourse(course("AERSP 204", { attrs: ["Honors"] }))).toBe(true);
    expect(isHonorsCourse(course("BMB 494H"))).toBe(true); // suffix, no attr
    expect(isHonorsCourse(course("ESC 414M"))).toBe(true);
    expect(isHonorsCourse(course("MATH 140"))).toBe(false);
  });

  it("windows per admit cohort match shc.psu.edu", () => {
    expect(honorsWindows(1).map((w) => w.credits)).toEqual([21, 14]);
    expect(honorsWindows(2).map((w) => w.credits)).toEqual([9, 14]);
    expect(honorsWindows(3).map((w) => w.credits)).toEqual([14]);
  });

  it("pools completed honors credits into the earliest window first (Gateway junior case)", () => {
    // First-year admit, now a junior (60+ credits done): 21 completed honors
    // credits fill the years-1-2 window; they must NOT leak into years 3-4.
    const honorsDone = Array.from({ length: 7 }, (_, i) => course(`HON ${100 + i}H`, { credits: 3 }));
    const filler = Array.from({ length: 14 }, (_, i) => course(`GEN ${i + 1}`, { credits: 3 }));
    const cat = buildCatalog([...honorsDone, ...filler]);
    const completed: Record<string, boolean> = {};
    for (const c of [...honorsDone, ...filler]) completed[c.code] = true; // 63 credits -> year 3
    const plan = basePlan({ honors: { admit: 1 }, completed, terms: [{ label: "Fall 2026", items: [] }] });
    const audit = auditHonors(plan, cat);
    expect(audit.currentYear).toBe(3);
    expect(audit.windows[0].shortfall).toBe(0); // 21 pooled into years 1-2
    expect(audit.windows[1].have).toBe(0); // nothing leaked into years 3-4
    expect(audit.windows[1].shortfall).toBe(14);
  });
});

describe("honors upgrades (synthetic)", () => {
  it("swaps to H-twins until the window is met, keeps originals as alternatives", () => {
    const cat = buildCatalog([
      course("MATH 140", { credits: 4 }), course("MATH 140H", { credits: 4, attrs: ["Honors"] }),
      course("CHEM 110"), course("CHEM 110H", { attrs: ["Honors"] }),
      course("PHIL 10"), // no twin
      course("ENGL 137H", { attrs: ["Honors"] }), course("CAS 138T", { attrs: ["Honors"] }),
      course("ENGL 15"), course("CAS 100A"),
    ]);
    const plan = basePlan({
      honors: { admit: 1 },
      terms: [
        { label: "Fall 2026", items: [{ code: "MATH 140" }, { code: "ENGL 15" }, { code: "PHIL 10" }] },
        { label: "Spring 2027", items: [{ code: "CHEM 110" }, { code: "CAS 100A" }] },
      ],
    });
    const res = applyHonorsUpgrades(plan, cat);
    const codes = plan.terms.flatMap((t) => t.items).map((it) => ("code" in it ? it.code : ""));
    expect(codes).toContain("ENGL 137H"); // RCL swap
    expect(codes).toContain("CAS 138T");
    expect(codes).toContain("MATH 140H");
    expect(codes).toContain("CHEM 110H");
    expect(codes).not.toContain("ENGL 15");
    // Originals preserved as alternatives for one-click swap-back.
    const math = plan.terms[0].items.find((it) => "code" in it && it.code === "MATH 140H");
    expect(math && "alternatives" in math ? math.alternatives : []).toContain("MATH 140");
    expect(res.upgrades.length).toBeGreaterThanOrEqual(4);
    // Idempotent: a second run changes nothing.
    expect(applyHonorsUpgrades(plan, cat).upgrades).toEqual([]);
  });

  it("upgraded honors section still satisfies the base course's prereq (schedule stand-in)", () => {
    const cat = buildCatalog([
      course("MATH 140", { credits: 4 }), course("MATH 140H", { credits: 4, attrs: ["Honors"] }),
      { ...course("MATH 141", { credits: 4, enforced: "MATH 140" }), prereqAst: { op: "course", code: "MATH 140" } as never },
    ]);
    const plan = basePlan({
      terms: [
        { label: "Fall 2026", items: [{ code: "MATH 140H" }] },
        { label: "Spring 2027", items: [{ code: "MATH 141" }] },
      ],
    });
    const items = buildItems(plan, cat);
    const sched = buildSchedule(plan, items, cat);
    expect(checkCourse(cat, "MATH 141", 1, sched).value).toBe(2); // SAT via the H twin
  });
});

describe("ESC first-year Schreyer admit: real-data end-to-end", () => {
  function makeEsc(): { plan: PlanDoc; catalog: Catalog } {
    const p = load("programs/majors/engineering-engineering-science-bs.json");
    const up = p.suggestedPlans.find((sp: { campusLabel: string }) => /University Park/i.test(sp.campusLabel)) ?? p.suggestedPlans[0];
    const tmpl: ProgramTemplate = { slug: p.slug, name: p.name, campusLabel: "", semesters: up.semesters, requirements: p.requirementSections };
    const plan = generatePlan([tmpl], { startTerm: { term: "Fall", year: 2026 }, completedCourses: [] }, "honors-esc");
    plan.honors = { admit: 1 };
    const prefixes = new Set<string>(["ENGL", "CAS"]);
    for (const t of plan.terms) for (const i of t.items) if ("code" in i) prefixes.add(i.code.split(" ")[0]);
    let courses: Course[] = [];
    for (const pf of prefixes) if (subjects[pf]) courses = courses.concat(load(subjects[pf]));
    const hop = new Set<string>();
    for (const c of courses) for (const ast of [c.prereqAst, c.concurrentAst]) if (ast) for (const code of astCourses(ast)) hop.add(code.split(" ")[0]);
    for (const pf of hop) if (!prefixes.has(pf) && subjects[pf]) courses = courses.concat(load(subjects[pf]));
    return { plan, catalog: buildCatalog(courses) };
  }

  it("full pipeline (upgrade -> optimize -> upgrade) meets every window ON THE PACKED LAYOUT; RCL in first two terms; thesis = ESC honors sequence", () => {
    const { plan, catalog } = makeEsc();
    const before = auditHonors(plan, catalog);
    expect(before.scholar).toBe(true);
    // The store's pipeline: pre-pack upgrades (RCL pin), optimize, post-pack
    // upgrades (packing shifts academic years — the second pass tops up the
    // final layout's windows with H-twins).
    applyHonorsUpgrades(plan, catalog);
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    applyHonorsUpgrades(plan, catalog);
    const after = auditHonors(plan, catalog);
    expect(after.windows[0].shortfall).toBe(0);
    expect(after.windows[1].shortfall).toBe(0);
    expect(after.rcl?.met).toBe(true);
    expect(after.thesis.met).toBe(true);
    expect(after.thesis.by).toMatch(/ESC/);
    // RCL pair sits in the first two terms (the requirement's wording), not
    // merely somewhere in the plan.
    const firstTwo = plan.terms.slice(0, 2).flatMap((t) => t.items).map((it) => ("code" in it ? it.code : ""));
    expect(firstTwo.some((c) => c === "ENGL 137H" || c === "CAS 137H")).toBe(true);
    expect(firstTwo.some((c) => c === "ENGL 138T" || c === "CAS 138T")).toBe(true);
    // Cap still respected after the RCL pin + swaps.
    const items = buildItems(plan, catalog);
    plan.terms.forEach((_, i) => {
      const cr = items.filter((x) => x.sem === i).reduce((s, x) => s + (x.kind === "slot" ? Number(x.credits) || 0 : catalog[x.code!]?.creditsParsed?.min ?? 3), 0);
      expect(cr).toBeLessThanOrEqual(19);
    });
  });

  it("upgraded plan has zero prereq violations (H-twins keep the chain intact)", () => {
    const { plan, catalog } = makeEsc();
    applyHonorsUpgrades(plan, catalog);
    optimizeSchedule(plan, catalog, { maxCredits: 19 });
    applyHonorsUpgrades(plan, catalog);
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    const bad = items
      .filter((i) => i.kind === "course" && i.code && catalog[i.code])
      .filter((i) => checkCourse(catalog, i.code!, i.sem, sched).value === 0)
      .map((i) => `${i.code}@sem${i.sem + 1}`);
    expect(bad).toEqual([]);
  });
});
