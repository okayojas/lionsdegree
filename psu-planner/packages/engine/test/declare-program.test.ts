/** The sequence both surfaces run when a Program is declared (#47).
 *
 * `program-merge.test.ts` covers the MERGE: what survives, what counts
 * once, what is reported. This covers the four steps around it, which
 * are what turns a merged Plan into one a student could follow — and
 * which, until this file, were written out in the planner's store and
 * again in the connector.
 *
 * WHY THAT MATTERED ENOUGH TO BE ITS OWN MODULE. The acceptance criterion
 * is that a Program declared through the connector is indistinguishable
 * from one declared in the planner. Two copies of an ordering are not
 * indistinguishable, they are identical-for-now: the failure is not that
 * one is wrong on the day it is written, it is that six months later
 * somebody improves one of them and a student gets a different plan
 * depending on which surface they used. One function, called twice, is
 * the only version of that claim that keeps being true.
 *
 * So what is asserted here is the ORDER and the completeness of the
 * sequence, at the one place it now exists.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCatalog,
  declareProgram,
  generatePlan,
  templateCourseCodes,
  withdrawProgram,
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
const MATH_MINOR = "eberly-science-mathematics-minor";

function templateFor(slug: string, kind: "majors" | "minors"): ProgramTemplate {
  const p = read(`programs/${kind}/${slug}.json`);
  const grid = (p.suggestedPlans ?? []).find((s: { semesters?: unknown[] }) => (s.semesters?.length ?? 0) > 0);
  return {
    slug: p.slug,
    name: p.name,
    campusLabel: grid?.campusLabel ?? "",
    semesters: grid?.semesters ?? [],
    requirements: p.requirementSections ?? [],
  };
}

const codesIn = (plan: PlanDoc) => plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));

/** What a card costs, by the optimizer's own rule (`creditsOf`).
 *
 * `Course.credits` is the bulletin's STRING ("3" but also "1-6"); the
 * number is in `creditsParsed.min`, and a Slot carries its own. Summing
 * the string is how the first version of this file managed to assert a
 * credit ceiling against NaN and pass — `NaN > 19` is false, so every
 * term looked compliant. A ceiling test that cannot fail is worse than
 * no ceiling test. */
const creditsOf = (item: PlanDoc["terms"][number]["items"][number], catalog: Catalog): number =>
  "slot" in item ? Number(item.credits) || 3 : catalog[item.code]?.creditsParsed?.min ?? 3;

const loadOf = (plan: PlanDoc, catalog: Catalog): number[] =>
  plan.terms.map((t) => t.items.reduce((n, it) => n + creditsOf(it, catalog), 0));

function catalogFor(codes: string[]): Catalog {
  let courses: Course[] = [];
  for (const pf of new Set(codes.map((c) => c.split(" ")[0]))) {
    if (subjects[pf]) courses = courses.concat(read(subjects[pf]));
  }
  return buildCatalog(courses);
}

function seed(): { plan: PlanDoc; catalog: Catalog; minor: ProgramTemplate } {
  const plan = generatePlan([templateFor(ESC, "majors")], {
    startTerm: { term: "Fall", year: 2026 },
    completedCourses: ["MATH 140", "CHEM 110"],
  }, "declare");
  const minor = templateFor(MATH_MINOR, "minors");
  return { plan, catalog: catalogFor([...codesIn(plan), ...templateCourseCodes(minor)]), minor };
}

describe("declaring a program leaves a schedule a student could follow", () => {
  it("respects the credit ceiling it was given", () => {
    // THE OPTIMIZER RAN, AND RAN LAST (iron rule 5). Without it the
    // merged courses sit wherever the merge put them, which routinely
    // means a term over the cap — a plan the registrar would refuse.
    const { plan, catalog, minor } = seed();
    declareProgram(plan, minor, { catalog, maxCredits: 19 });

    const load = loadOf(plan, catalog);
    // The measurement is real before it is judged. Every number finite
    // and at least one term carrying actual work, or "nothing is over the
    // cap" is a statement about nothing.
    expect(load.every(Number.isFinite), `a term's credit load did not compute: ${load.join(", ")}`).toBe(true);
    expect(Math.max(...load), "every term is empty, so the ceiling is untested").toBeGreaterThan(9);
    expect(load.filter((c) => c > 19), `terms over the 19-credit cap: ${load.join(", ")}`).toEqual([]);
  });

  it("honours a lower ceiling, so the number is the caller's and not the engine's", () => {
    // Guards against the cap being hard-coded somewhere inside the
    // sequence, which would make the option a lie.
    const { plan, catalog, minor } = seed();
    declareProgram(plan, minor, { catalog, maxCredits: 14 });
    const load = loadOf(plan, catalog);
    expect(load.every(Number.isFinite), `a term's credit load did not compute: ${load.join(", ")}`).toBe(true);
    expect(Math.max(...load), "a lower credit ceiling was ignored").toBeLessThanOrEqual(14);
  });

  it("names the general-education slots it leaves, instead of leaving them generic", () => {
    // REFINEMENT RAN, against the whole merged plan. `refineGenEdSlots`
    // reads the university framework and gives each remaining slot the
    // DOMAIN it stands for — "GH: Humanities" rather than a bare "GE" —
    // so a student is told what to look for.
    //
    // NOT "the slot count did not grow", which was the first version of
    // this and survived deleting the entire step: a minor brings no
    // gen-eds of its own, so the count is unchanged whether or not
    // anything reconciled them. A test that cannot fail is not a test.
    const { plan, catalog, minor } = seed();
    const slotKinds = (p: PlanDoc) =>
      p.terms
        .flatMap((t) => t.items)
        .filter((i): i is typeof i & { slot: string; id: string } => "slot" in i)
        .filter((s) => !p.removed?.[s.id])
        .map((s) => s.slot);

    expect(slotKinds(plan), "the base plan has no generic gen-ed slot, so refinement cannot be observed").toContain("GE");

    declareProgram(plan, minor, { catalog });
    const after = slotKinds(plan);
    expect(after, "a generic GE slot survived refinement, so the student is still not told what to look for").not.toContain("GE");
    expect(
      after.some((k) => k !== "EL"),
      `every slot became an elective placeholder: ${[...new Set(after)].join(", ")}`,
    ).toBe(true);
  });

  it("upgrades a Scholar's sections, and only a Scholar's", () => {
    // THE HONORS STEP RAN, and it is the one most easily dropped from a
    // second copy of the sequence because it does nothing for the 95% of
    // students who are not Scholars.
    //
    // COMPARED AGAINST A NON-SCHOLAR RATHER THAN AGAINST ZERO. Engineering
    // Science's own published grid names EMCH 210H and three others
    // outright, so "this plan contains an H section" is true before
    // anything upgrades anything. What the step actually does is add MORE
    // of them, for a Scholar only.
    const honorsIn = (p: PlanDoc) => new Set(codesIn(p).filter((c) => /H$/.test(c)));

    const plain = seed();
    declareProgram(plain.plan, plain.minor, { catalog: plain.catalog });

    const scholar = seed();
    scholar.plan.honors = { admit: 1 };
    declareProgram(scholar.plan, scholar.minor, { catalog: scholar.catalog });

    const extra = [...honorsIn(scholar.plan)].filter((c) => !honorsIn(plain.plan).has(c));
    expect(
      extra.length,
      "a Scholar's plan has exactly the honors sections a non-Scholar's does, so the upgrade never ran",
    ).toBeGreaterThan(0);
  });

  it("changes nothing at all when the program is already declared", () => {
    // Re-flowing a plan nobody altered would move cards for no reason and
    // hand the student a revision they did not ask for.
    const { plan, catalog, minor } = seed();
    declareProgram(plan, minor, { catalog });
    const settled = JSON.stringify(plan);

    const again = declareProgram(plan, minor, { catalog });
    expect(again.alreadyPresent, "declaring the same program twice was not reported as a no-op").toBe(true);
    expect(JSON.stringify(plan), "a second declaration of the same program re-flowed the plan").toBe(settled);
  });

  it("keeps the student's completed courses through the whole sequence", () => {
    // Asserted here as well as at the merge: the four steps run AFTER it,
    // and the optimizer is perfectly capable of putting a completed
    // course back on the chart if something upstream forgets.
    const { plan, catalog, minor } = seed();
    declareProgram(plan, minor, { catalog });
    expect(plan.completed["MATH 140"], "a completed course was reset by the declare sequence").toBe(true);
    expect(codesIn(plan), "a course the student has already passed was scheduled again").not.toContain("MATH 140");
  });
});

describe("withdrawing a program", () => {
  it("re-flows what is left, inside the ceiling", () => {
    const { plan, catalog, minor } = seed();
    declareProgram(plan, minor, { catalog });
    const r = withdrawProgram(plan, MATH_MINOR, { catalog, maxCredits: 19, remaining: [templateFor(ESC, "majors")] });

    expect(r.refusal, `withdrawing refused: ${r.refusal}`).toBeNull();
    expect(plan.programs, "the program is still on the plan").not.toContain(MATH_MINOR);
    const load = loadOf(plan, catalog);
    expect(load.every(Number.isFinite), `a term's credit load did not compute: ${load.join(", ")}`).toBe(true);
    expect(load.filter((c) => c > 19), `withdrawing left a term over the ceiling: ${load.join(", ")}`).toEqual([]);
  });

  it("leaves the plan untouched when it refuses", () => {
    // A refusal that had already re-flowed would be a change the student
    // was told did not happen.
    const { plan, catalog } = seed();
    const before = JSON.stringify(plan);
    const r = withdrawProgram(plan, MATH_MINOR, { catalog });
    expect(r.refusal, "withdrawing a program the plan does not have was not refused").toBeTruthy();
    expect(JSON.stringify(plan), "a refused withdrawal re-flowed the plan anyway").toBe(before);
  });
});

describe("the codes a Template names", () => {
  it("includes the alternatives a grid offers, not only the courses it prescribes", () => {
    // These decide which subject files a caller loads. A Course the
    // catalog never read has no prerequisite structure, so the plan
    // answers "cannot be checked" about a course we hold (iron rule 2,
    // from the understating side).
    const esc = templateFor(ESC, "majors");
    const codes = templateCourseCodes(esc);
    const alts = esc.semesters.flatMap((s) => s.entries.flatMap((e) => e.alternatives ?? []));
    expect(alts.length, "this program's grid offers no alternatives, so the test proves nothing").toBeGreaterThan(0);
    for (const a of alts) expect(codes, `${a} is offered by the grid but not in the codes to load`).toContain(a);
  });

  it("includes the options of a choice group", () => {
    // A choice group's options are candidates for a Slot, and ranking
    // candidates is the next thing the plan will be asked to do.
    const minor = templateFor(MATH_MINOR, "minors");
    const options = (minor.requirements ?? []).flatMap((s) =>
      s.rules.flatMap((r) => (r.type === "oneOf" || r.type === "chooseN" ? r.options : [])),
    );
    const codes = templateCourseCodes(minor);
    for (const o of options) expect(codes, `${o} is a choice-group option but not in the codes to load`).toContain(o);
  });
});
