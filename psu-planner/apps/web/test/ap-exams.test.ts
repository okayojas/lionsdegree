/** What a list of AP exams and scores is worth (setup, step 5).
 *
 * The student chooses an exam and a score; the Courses it counts for are
 * ticked in the list of classes. What decides that is here, and it reads
 * the Edition's own AP table off disk: an award asserted against an
 * invented table proves nothing about the Bulletin's.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apOutcomes } from "../src/components/CreditPickers";
import type { ApExam } from "../src/data/catalogClient";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "catalog");
const LATEST = (JSON.parse(fs.readFileSync(path.join(ROOT, "editions.json"), "utf-8")) as { latest: string }).latest;
const TABLE = (JSON.parse(fs.readFileSync(path.join(ROOT, LATEST, "ap_credits.json"), "utf-8")) as { exams: ApExam[] }).exams;

/** An exam whose top score counts for at least one Course, read from the
 * table and not typed here: the table changes between bulletins. */
const WITH_COURSES = TABLE.find((x) => x.awards.some((a) => a.courses.length > 0))!;
const top = (exam: ApExam) => [...exam.awards].reverse().find((a) => a.courses.length > 0)!;
/** An exam with a score that earns no Course. */
const WITH_NOTHING = TABLE.find((x) => x.awards.some((a) => !a.courses.length && !a.credits))!;
const nothingAt = (exam: ApExam) => exam.awards.find((a) => !a.courses.length && !a.credits)!.minScore;

describe("what AP exams count for", () => {
  it("is nothing until the score is given: an exam alone credits no class", () => {
    const [o] = apOutcomes([{ exam: WITH_COURSES.exam, score: null }], TABLE);
    expect(o!.courses).toEqual([]);
    expect(o!.says).toBe("Choose your score.");
  });

  it("is the Courses Penn State's table gives for that score, and says which", () => {
    const award = top(WITH_COURSES);
    const [o] = apOutcomes([{ exam: WITH_COURSES.exam, score: award.minScore }], TABLE);
    expect(o!.courses).toEqual(award.courses);
    for (const code of award.courses) expect(o!.says).toContain(code);
    expect(o!.says).toMatch(/^Counts as /);
  });

  it("takes the award for the score given, not the best one: a lower score can earn less", () => {
    // The row just below the first that earns Courses, where there is one.
    const lower = WITH_NOTHING;
    const [o] = apOutcomes([{ exam: lower.exam, score: nothingAt(lower) }], TABLE);
    expect(o!.courses).toEqual([]);
    expect(o!.says).toMatch(/earns no course credit at Penn State/);
  });

  it("says a score below every row earns nothing", () => {
    const [o] = apOutcomes([{ exam: WITH_COURSES.exam, score: 1 }], TABLE);
    expect(o!.courses).toEqual([]);
    expect(o!.says).toMatch(/earns no course credit/);
  });

  it("gives a Course two exams both count for once, under the first", () => {
    const award = top(WITH_COURSES);
    const out = apOutcomes(
      [
        { exam: WITH_COURSES.exam, score: award.minScore },
        { exam: WITH_COURSES.exam, score: award.minScore },
      ],
      TABLE,
    );
    expect(out[0]!.courses).toEqual(award.courses);
    expect(out[1]!.courses).toEqual([]);
  });

  it("says so where the bulletin's table has no such exam, and credits nothing", () => {
    const [o] = apOutcomes([{ exam: "Underwater Basket Weaving", score: 5 }], TABLE);
    expect(o!.courses).toEqual([]);
    expect(o!.says).toMatch(/not in this bulletin's AP table/);
  });

  it("is one outcome for each choice, in the order chosen", () => {
    const out = apOutcomes([{ exam: WITH_NOTHING.exam, score: 5 }, { exam: WITH_COURSES.exam, score: null }], TABLE);
    expect(out.map((o) => o.exam)).toEqual([WITH_NOTHING.exam, WITH_COURSES.exam]);
  });
});
