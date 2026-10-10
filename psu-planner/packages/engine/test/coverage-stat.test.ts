/** How much of the catalog actually resolves to named courses.
 *
 * This number goes on the public site, so it has to be computed from the data
 * and it has to be honest about what it excludes. Two failure modes matter
 * more than precision:
 *
 *   - counting Adviser-Defined Requirements as failures would cap the figure
 *     below 100% forever, for requirements that have no list BY DESIGN;
 *   - counting them as successes would inflate it, because nothing resolved.
 *
 * They belong in neither half of the fraction, stated separately instead.
 * A row we simply could not parse is the opposite case: it IS a failure and
 * must stay in the denominator, or the figure silently improves every time
 * the parser gets worse.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { requirementCoverage, type ReqSection } from "../src/index.js";
import { CATALOG_DIR } from "./edition.js";

/** Every program in the shipped catalog for the edition under test. */
function allPrograms(): { slug: string; requirementSections: ReqSection[] }[] {
  const out: { slug: string; requirementSections: ReqSection[] }[] = [];
  for (const kind of ["majors", "minors", "certificates"]) {
    const dir = path.join(CATALOG_DIR, "programs", kind);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      out.push({ slug: p.slug ?? f, requirementSections: p.requirementSections ?? [] });
    }
  }
  return out;
}

describe("the coverage figure", () => {
  const stat = requirementCoverage(allPrograms());

  it("is computed over the whole shipped catalog, not a sample", () => {
    expect(stat.total).toBeGreaterThan(2000);
  });

  it("counts only requirements that resolve to named courses as resolved", () => {
    expect(stat.resolved).toBeLessThanOrEqual(stat.total);
    expect(stat.resolved).toBeGreaterThan(0);
  });

  it("excludes Adviser-Defined Requirements from BOTH halves of the fraction", () => {
    // They are not successes and not failures: the bulletin's answer is "ask
    // your adviser", and there is no list to find.
    expect(stat.adviserDefined).toBeGreaterThan(0);
    expect(stat.total + stat.adviserDefined).toBeLessThanOrEqual(stat.considered);
    expect(stat.considered - stat.adviserDefined).toBe(stat.total);
  });

  it("keeps rows we failed to parse IN the denominator", () => {
    // Otherwise the figure improves every time the parser gets worse, which
    // is the one way this number could lie while staying 'computed'.
    expect(stat.unreadable).toBeGreaterThan(0);
    expect(stat.resolved + stat.unreadable).toBeLessThanOrEqual(stat.total);
  });

  it("reports a percentage consistent with its own counts", () => {
    expect(stat.percent).toBe(Math.round((stat.resolved / stat.total) * 100));
    expect(stat.percent).toBeGreaterThan(0);
    expect(stat.percent).toBeLessThanOrEqual(100);
  });

  it("is a figure worth publishing", () => {
    // A guard against shipping a number that embarrasses the claim. If this
    // ever fails the honest move is to fix the parser, not the threshold.
    expect(stat.percent, `only ${stat.percent}% of requirements resolve`).toBeGreaterThanOrEqual(85);
  });
});

describe("the computation itself", () => {
  const section = (rules: unknown[]): ReqSection =>
    ({ heading: "Requirements", rules } as unknown as ReqSection);

  it("counts a named course list as resolved", () => {
    const stat = requirementCoverage([
      { slug: "x", requirementSections: [section([{ type: "course", code: "MATH 140", credits: 3 }])] },
    ]);
    expect(stat).toMatchObject({ resolved: 1, total: 1, adviserDefined: 0, percent: 100 });
  });

  it("counts an unreadable row as a failure, in the denominator", () => {
    const stat = requirementCoverage([
      { slug: "x", requirementSections: [section([{ type: "unstructured", commentRaw: "Select something" }])] },
    ]);
    expect(stat).toMatchObject({ resolved: 0, total: 1, unreadable: 1, percent: 0 });
  });

  it("puts an adviser-defined requirement in neither half", () => {
    const stat = requirementCoverage([
      {
        slug: "x",
        requirementSections: [
          section([
            { type: "course", code: "MATH 140", credits: 3 },
            { type: "selectCredits", credits: 3, commentRaw: "In consultation with adviser", from: null },
          ]),
        ],
      },
    ]);
    expect(stat.adviserDefined).toBe(1);
    expect(stat.total).toBe(1); // the adviser row is not in the denominator
    expect(stat.percent).toBe(100); // and does not drag the figure down
  });

  it("ignores notes, which are prose rather than requirements", () => {
    const stat = requirementCoverage([
      { slug: "x", requirementSections: [section([{ type: "note", commentRaw: "Select one concentration:" }])] },
    ]);
    expect(stat.considered).toBe(0);
    expect(stat.total).toBe(0);
  });

  it("reports 0% rather than NaN when there is nothing to count", () => {
    const stat = requirementCoverage([]);
    expect(stat.percent).toBe(0);
    expect(Number.isFinite(stat.percent)).toBe(true);
  });
});
