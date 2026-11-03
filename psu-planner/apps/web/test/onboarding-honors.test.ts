/** The course checklist shows a Scholar the courses a Scholar takes.
 *
 * THE BUG, reported from the page itself. Onboarding asked about
 * Schreyer in step 7 and listed "which of these have you already taken"
 * in step 4 — three steps ABOVE the answer that governs it. A Schreyer
 * first-year was shown ENGL 15 and CAS 100A, two courses they never
 * took, with no way to record the ENGL 137H and CAS 138T they did. They
 * then got a plan scheduling requirements they had already met.
 *
 * Two halves, and this file is the second. The engine half — that
 * passing ENGL 137H discharges the ENGL 15 requirement — is tested at
 * the engine in `rcl-sequence.test.ts`, where it belongs. What is tested
 * here is that the PAGE offers the substitution at all: a student who
 * cannot tick the box never reaches the engine rule.
 *
 * Driven through the same `forScholar` the component calls, rather than
 * by rendering React. The question is which courses the list contains
 * and why, which is a function of the student's answers — not of the
 * DOM — and asserting it through a renderer would be asserting the
 * renderer.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, hydrateAuditRow, type Catalog } from "@psu-planner/engine";
import { forScholar, type TrackEntry } from "../src/components/Onboarding";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "catalog");
const LATEST = (JSON.parse(fs.readFileSync(path.join(ROOT, "editions.json"), "utf-8")) as { latest: string }).latest;

/** The real audit index, which is the object the component loads. A stub
 * that answered "yes" for every `X + H` would certify chips for courses
 * that do not exist. */
let auditIndex: Catalog | null = null;
function catalog(): Catalog {
  if (!auditIndex) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, LATEST, "audit-index.json"), "utf-8")) as {
      courses: Parameters<typeof hydrateAuditRow>[0][];
    };
    auditIndex = buildCatalog(raw.courses.map(hydrateAuditRow));
  }
  return auditIndex;
}

const entry = (code: string, alternatives: string[] = []): TrackEntry => ({ code, alternatives });

describe("a student who is not in Schreyer", () => {
  it("sees the list exactly as the program publishes it", () => {
    const e = entry("ENGL 15");
    expect(forScholar(e, null, catalog()), "a non-Scholar's checklist was rewritten").toEqual(e);
  });

  it("is not offered honors sections they have no reason to have taken", () => {
    expect(forScholar(entry("MATH 140"), null, catalog()).alternatives).toEqual([]);
  });
});

describe("a Schreyer first-year admit", () => {
  it("is shown ENGL 137H, not ENGL 15", () => {
    // The headline. This is the course they actually sat.
    const out = forScholar(entry("ENGL 15"), 1, catalog());
    expect(out.code, "the checklist still asks a Scholar about ENGL 15").toBe("ENGL 137H");
  });

  it("is shown CAS 138T, not CAS 100A", () => {
    expect(forScholar(entry("CAS 100A"), 1, catalog()).code).toBe("CAS 138T");
  });

  it("is told why the course changed", () => {
    // A silent substitution is indistinguishable from a bug, and this one
    // is a claim about what the student took.
    const out = forScholar(entry("ENGL 15"), 1, catalog());
    expect(out.note, "the substitution happened silently").toBeTruthy();
    expect(out.note!).toMatch(/ENGL 15/);
    expect(out.note!).toMatch(/schreyer/i);
  });

  it("can still tick the standard course, for a late admit", () => {
    // Somebody who switched into Schreyer after passing ENGL 15 has to be
    // able to say so. Replacing without offering the original back would
    // make their real transcript unrecordable.
    const out = forScholar(entry("ENGL 15"), 1, catalog());
    expect(out.alternatives, "the course the student may actually have taken is gone").toContain("ENGL 15");
  });

  it("can tick the cross-listed code, because it is the same course", () => {
    expect(forScholar(entry("ENGL 15"), 1, catalog()).alternatives).toContain("CAS 137H");
    expect(forScholar(entry("CAS 100A"), 1, catalog()).alternatives).toContain("ENGL 138T");
  });

  it("keeps the alternatives the program already offered", () => {
    const out = forScholar(entry("CAS 100A", ["CAS 100B"]), 1, catalog());
    expect(out.alternatives, "a substitution dropped the program's own alternatives").toContain("CAS 100B");
  });
});

describe("a Gateway admit", () => {
  it("is NOT switched onto the honors RCL sequence", () => {
    // Second- and third-year admits were not in Schreyer during their
    // first two semesters, so they took the standard pair. Substituting
    // for them would be the original bug with the sign flipped.
    for (const admit of [2, 3] as const) {
      expect(forScholar(entry("ENGL 15"), admit, catalog()).code, `a year-${admit} admit was shown ENGL 137H`).toBe("ENGL 15");
      expect(forScholar(entry("CAS 100A"), admit, catalog()).code).toBe("CAS 100A");
    }
  });

  it("is still offered honors sections for everything else", () => {
    // They are Scholars; they have honors credits to earn.
    expect(forScholar(entry("MATH 140"), 2, catalog()).alternatives).toContain("MATH 140H");
  });
});

describe("the honors twin chips", () => {
  it("are offered beside a course that has one", () => {
    // OFFERED, not assumed: whether a Scholar sat MATH 140 or MATH 140H
    // is a fact only they have.
    const out = forScholar(entry("MATH 140"), 1, catalog());
    expect(out.code, "the plain course was replaced rather than kept").toBe("MATH 140");
    expect(out.alternatives, "the honors section the student may have taken is not offered").toContain("MATH 140H");
  });

  it("are not offered for a course with no honors section", () => {
    // A chip for a course the bulletin does not have is the
    // fabricated-course failure in miniature.
    const noTwin = "ESC 261M";
    expect(catalog()[`${noTwin}H`], `${noTwin}H exists, so this test cannot detect an invented chip`).toBeUndefined();
    expect(forScholar(entry(noTwin), 1, catalog()).alternatives).toEqual([]);
  });

  it("are not offered at all until the catalog has loaded", () => {
    // The index is 2.1 MB and is fetched only once a student says they
    // are a Scholar. Until it arrives there is nothing to check an
    // honors section against, and guessing one would invent a course.
    expect(forScholar(entry("MATH 140"), 1, null).alternatives).toEqual([]);
  });

  it("do not duplicate a twin the program already listed", () => {
    expect(forScholar(entry("MATH 140", ["MATH 140H"]), 1, catalog()).alternatives).toEqual(["MATH 140H"]);
  });
});
