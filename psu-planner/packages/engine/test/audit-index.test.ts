/** The audit index's rows become Courses, and a wrong field is a wrong answer.
 *
 * Moved here from the web app when the MCP server became a second reader of
 * this index (#31). One hydration, one set of answers about what a Course
 * is -- the bug below is the argument for that.
 *
 * WHY THIS FILE EXISTS. #27 pointed the degree audit at `audit-index.json`
 * instead of the 2.4 MB combined index, and the hydrator that turns those
 * slim rows back into Courses hardcoded `level: "undergraduate"`. The index
 * is built from `courses/` AND `courses/grad/`: 5,126 of 14,615 rows are
 * 500-level or higher. `genEd.ts` and `slotPicks.ts` decide whether a course
 * may fill a General Education or elective slot by reading exactly that
 * field, so the planner would have offered a sophomore a graduate seminar
 * and called the requirement satisfied.
 *
 * That is iron rule 2 inverted. A row the hydrator cannot speak for must
 * come back as the EMPTY value, never a plausible one -- and "undergraduate"
 * is the most plausible wrong answer available, which is what made it
 * invisible for a release. Nothing tested this seam, which is why it shipped.
 */
import { describe, it, expect } from "vitest";
import { hydrateAuditRow } from "../src/auditIndex.js";

describe("hydrating an audit-index row", () => {
  it("keeps a graduate course graduate", () => {
    // The gate the engine actually applies, asserted in the form it applies
    // it: `c.level !== "undergraduate"`.
    const c = hydrateAuditRow({ code: "ABA 500", title: "Science and Behaviorism", level: "graduate" });
    expect(c.level).toBe("graduate");
    expect(c.level !== "undergraduate", "a graduate course would be offered as an undergraduate elective").toBe(true);
  });

  it("treats an absent level as undergraduate", () => {
    // The pipeline drops the common case to keep the boot-path index small,
    // so ABSENT means undergraduate here. This is a real default, not a
    // guess: the field is omitted BECAUSE it holds that value.
    expect(hydrateAuditRow({ code: "MATH 140", title: "Calculus I" }).level).toBe("undergraduate");
  });

  it("invents nothing it was not given", () => {
    // The rest of the Course shape is filled with EMPTY values, not plausible
    // ones. An empty description is visibly missing; a fabricated prerequisite
    // tree is not. `astComplete: false` is the load-bearing one -- it is what
    // makes the audit say "verify manually" instead of "satisfied".
    const c = hydrateAuditRow({ code: "MATH 140", title: "Calculus I" });
    expect(c.description).toBe("");
    expect(c.url).toBe("");
    expect(c.prereqAst).toBeNull();
    expect(c.enforced).toBeNull();
    expect(c.astComplete, "a row with no parsed prerequisites claimed to have complete ones").toBe(false);
  });

  it("derives subject and number from the code", () => {
    // Not stored -- the pipeline asserts the split reproduces them for every
    // course, so storing them would be weight on every student's boot path.
    const c = hydrateAuditRow({ code: "CMPSC 465", title: "Data Structures and Algorithms" });
    expect([c.subject, c.number]).toEqual(["CMPSC", "465"]);
  });
});

describe("a Course whose prerequisites were never read", () => {
  /** FOUND BY REVIEW, NOT BY A TEST. `checkCourse` returned SAT whenever a
   * Course had no prerequisite data — which was harmless while every
   * Course arrived fully loaded, and became a wrong answer the moment the
   * MCP server started hydrating from the audit index on demand (#31).
   *
   * An unhydrated Course looks exactly like a Course with no
   * prerequisites. `astComplete` is what tells them apart, and nothing
   * read it. */
  it("is reported as unverifiable, not as satisfied", async () => {
    const { checkCourse, buildCatalog, UNK, SAT } = await import("../src/index.js");
    const slim = buildCatalog([hydrateAuditRow({ code: "CMPSC 465", title: "Data Structures" })]);
    const r = checkCourse(slim, "CMPSC 465", 0, {});
    expect(r.value, "an unread prerequisite tree was reported satisfied").not.toBe(SAT);
    expect(r.value).toBe(UNK);
    expect(r.leaves[0]?.v).toBe(UNK);
  });

  it("says so in words a student can act on", async () => {
    const { checkCourse, buildCatalog } = await import("../src/index.js");
    const slim = buildCatalog([hydrateAuditRow({ code: "CMPSC 465" })]);
    const leaf = checkCourse(slim, "CMPSC 465", 0, {}).leaves[0];
    expect(leaf && "text" in leaf ? leaf.text : "").toMatch(/verify manually/i);
  });

  it("still reports a genuinely prerequisite-free Course as satisfied", async () => {
    // The guard keys on `astComplete`, so a real Course that simply has no
    // prerequisites must not be dragged into "cannot determine" with it --
    // 6,094 Courses in one Edition are in exactly that position.
    const { checkCourse, buildCatalog, SAT } = await import("../src/index.js");
    const real = buildCatalog([
      { ...hydrateAuditRow({ code: "ART 100", title: "Intro" }), astComplete: true },
    ] as never);
    expect(checkCourse(real, "ART 100", 0, {}).value).toBe(SAT);
  });
});
