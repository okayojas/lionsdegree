/** The honors Rhetoric & Civic Life pair satisfies what it replaces.
 *
 * THE BUG. A Schreyer first-year takes ENGL 137H and CAS 138T in their
 * first two semesters, in place of ENGL 15 and CAS 100 — the honors
 * college requires exactly that sequence. `applyHonorsUpgrades` has
 * always known this and swaps a Scholar's plan onto those courses.
 * `generatePlan` did not: a Scholar who recorded the courses they had
 * actually passed was still handed a plan telling them to go and take
 * ENGL 15.
 *
 * It slipped through because `honorsTwinDone` covers the SUFFIX case —
 * MATH 140H satisfies MATH 140 — and the RCL pair is not a suffix. ENGL
 * 137H is not "ENGL 15" + "H", so nothing matched and the requirement
 * stayed open.
 *
 * GROUNDED, NOT ASSERTED. All four honors codes carry GWS in the shipped
 * bulletin, exactly as ENGL 15 and CAS 100A/B/C do, which is what makes
 * the substitution safe for the gen-ed audit. The sequence is
 * cross-listed, so ENGL 137H and CAS 137H are one course under two
 * codes.
 *
 * DIRECTIONAL (iron rule 4). Taking ENGL 137H satisfies the ENGL 15
 * requirement. Taking ENGL 15 does NOT discharge a Scholar's RCL
 * requirement, and reading the relation backwards would quietly tell a
 * Scholar they were done when they were not.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePlan, rclSatisfied, RCL_SEQUENCE, type PlanDoc, type ProgramTemplate } from "../src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "web", "public", "catalog");
const LATEST = (JSON.parse(fs.readFileSync(path.join(ROOT, "editions.json"), "utf-8")) as { latest: string }).latest;
const DIR = path.join(ROOT, LATEST);
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(DIR, rel), "utf-8"));

const ESC = "engineering-engineering-science-bs";

function escTemplate(): ProgramTemplate {
  const p = read(`programs/majors/${ESC}.json`);
  const grid = (p.suggestedPlans ?? []).find((s: { semesters?: unknown[] }) => (s.semesters?.length ?? 0) > 0);
  return { slug: p.slug, name: p.name, campusLabel: "", semesters: grid.semesters, requirements: p.requirementSections };
}

const codesIn = (plan: PlanDoc) => plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));
const planWith = (completedCourses: string[]) =>
  codesIn(generatePlan([escTemplate()], { startTerm: { term: "Fall", year: 2026 }, completedCourses }, "rcl"));

describe("the relation itself", () => {
  it("accepts the honors course for the requirement it replaces", () => {
    const taken = (c: string) => c === "ENGL 137H";
    expect(rclSatisfied("ENGL 15", taken), "ENGL 137H does not satisfy ENGL 15").toBe(true);
  });

  it("accepts the cross-listing, because it is the same course", () => {
    // The sequence is published under both prefixes. A student who sat it
    // as CAS 137H sat ENGL 137H.
    expect(rclSatisfied("ENGL 15", (c) => c === "CAS 137H")).toBe(true);
    expect(rclSatisfied("CAS 100A", (c) => c === "ENGL 138T")).toBe(true);
  });

  it("covers every variant of the requirement the bulletin publishes", () => {
    for (const req of ["ENGL 15", "ENGL 30"]) {
      expect(rclSatisfied(req, (c) => c === "ENGL 137H"), `${req} is not covered`).toBe(true);
    }
    for (const req of ["CAS 100", "CAS 100A", "CAS 100B", "CAS 100C"]) {
      expect(rclSatisfied(req, (c) => c === "CAS 138T"), `${req} is not covered`).toBe(true);
    }
  });

  it("DOES NOT READ BACKWARDS", () => {
    // Iron rule 4. A Scholar who took the standard sequence still owes
    // the honors one, and saying otherwise would tell them they had
    // finished a requirement they had not started.
    expect(rclSatisfied("ENGL 137H", (c) => c === "ENGL 15"), "the standard course discharged the honors requirement").toBe(false);
    expect(rclSatisfied("CAS 138T", (c) => c === "CAS 100A")).toBe(false);
  });

  it("does not match a requirement it has nothing to do with", () => {
    expect(rclSatisfied("MATH 140", (c) => c === "ENGL 137H")).toBe(false);
    expect(rclSatisfied("ENGL 202C", (c) => c === "ENGL 137H")).toBe(false);
  });

  it("matches nothing when the student has taken nothing", () => {
    expect(rclSatisfied("ENGL 15", () => false)).toBe(false);
  });
});

describe("the courses it names are real, and interchangeable", () => {
  it("every one is in the shipped bulletin", () => {
    // The substitution is only safe because these exist. A rule naming a
    // course the catalog does not have would silently never fire.
    const subjects = read("subjects_index.json") as Record<string, string>;
    const rows = [...read(subjects["ENGL"]), ...read(subjects["CAS"])] as { code: string; genEd: string[] }[];
    for (const r of RCL_SEQUENCE) {
      for (const code of r.honors) {
        expect(rows.find((x) => x.code === code), `${code} is not in the ${LATEST} catalog`).toBeTruthy();
      }
    }
  });

  it("carries the same gen-ed designation as the course it replaces", () => {
    // THE REASON THE SWAP IS SAFE, asserted rather than trusted: if an
    // honors section ever stopped carrying GWS, substituting it would
    // quietly cost the student a general-education requirement.
    const subjects = read("subjects_index.json") as Record<string, string>;
    const rows = [...read(subjects["ENGL"]), ...read(subjects["CAS"])] as { code: string; genEd: string[] }[];
    const genEd = (c: string) => rows.find((x) => x.code === c)?.genEd ?? [];
    expect(genEd("ENGL 15"), "the fixture course lost its gen-ed, so this test compares nothing").toContain("GWS");
    for (const r of RCL_SEQUENCE) {
      for (const code of r.honors) {
        expect(genEd(code), `${code} does not carry GWS, so substituting it would cost a requirement`).toContain("GWS");
      }
    }
  });
});

describe("a Scholar recording what they actually took", () => {
  it("is not told to take ENGL 15 after passing ENGL 137H", () => {
    // The reported shape of the bug, end to end through plan generation.
    expect(planWith([]), "the base plan does not schedule ENGL 15, so this proves nothing").toContain("ENGL 15");
    expect(planWith(["ENGL 137H"]), "a Scholar who passed ENGL 137H is still being sent to ENGL 15").not.toContain("ENGL 15");
  });

  it("is not told to take CAS 100A after passing CAS 138T", () => {
    expect(planWith([]), "the base plan does not schedule CAS 100A").toContain("CAS 100A");
    expect(planWith(["CAS 138T"]), "a Scholar who passed CAS 138T is still being sent to CAS 100A").not.toContain("CAS 100A");
  });

  it("clears both when they took the whole sequence", () => {
    const codes = planWith(["ENGL 137H", "CAS 138T"]);
    expect(codes).not.toContain("ENGL 15");
    expect(codes).not.toContain("CAS 100A");
  });

  it("clears it when they sat the sequence under its other prefix", () => {
    expect(planWith(["CAS 137H"]), "the cross-listed code did not satisfy the requirement").not.toContain("ENGL 15");
  });

  it("leaves the rest of the plan alone", () => {
    // A substitution that discharged more than it should would be the
    // same bug pointing the other way, and much harder to notice.
    const codes = planWith(["ENGL 137H", "CAS 138T"]);
    for (const still of ["MATH 140", "CHEM 110", "PHYS 211"]) {
      expect(codes, `${still} vanished from a plan that only recorded the RCL pair`).toContain(still);
    }
  });
});

describe("a student who is not a Scholar", () => {
  it("still clears the requirement with the standard course", () => {
    // The path that always worked, asserted so the new rule cannot
    // displace it.
    expect(planWith(["ENGL 15"])).not.toContain("ENGL 15");
    expect(planWith(["CAS 100A"])).not.toContain("CAS 100A");
  });

  it("gets the same credit for the honors course if they took it", () => {
    // The relation is about the COURSE, not about membership: ENGL 137H
    // carries GWS for whoever sat it. Gating it on `plan.honors` would
    // refuse a non-Scholar credit for a course they passed.
    expect(planWith(["ENGL 137H"])).not.toContain("ENGL 15");
  });
});
