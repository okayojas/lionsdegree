/** What a Slot shows when its Pool is NOT a plain list of courses.
 *
 * Two cases, both about telling a student where an answer came from. A list
 * read off a department page is not the bulletin and should not look like it.
 * And a requirement settled by a conversation has no list at all -- the
 * absence is the requirement's content, so showing an empty list would say
 * something false. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildCatalog,
  hydrateSearchIndex,
  fingerprintRequirement,
  poolFromRule,
  rankSlotPicks,
  type Catalog,
  type Registry,
} from "../src/index.js";
import { CATALOG_DIR, fullIndexDir } from "./edition.js";

const catalog: Catalog = buildCatalog(
  hydrateSearchIndex(JSON.parse(fs.readFileSync(path.join(fullIndexDir(), "search-index.json"), "utf-8"))),
);
const base = { exclude: new Set<string>(), majorPrefixes: new Set<string>(), needUS: false, needIL: false };

const adviserRule = {
  type: "selectCredits" as const,
  credits: 6,
  commentRaw: "In consultation with adviser, select 6 credits in art history",
  from: null,
};

function registryFor(prose: string, over: Partial<Registry["entries"][0]> = {}): Registry {
  return {
    entries: [
      {
        entryId: "e1",
        programSlug: "p",
        edition: "2026-2027",
        fingerprint: "", // filled by the caller via fingerprintRequirement
        courses: ["ART 100", "ARTH 111U"],
        sourceUrl: "https://example.psu.edu/approved-list",
        fetchedAt: "2026-09-01",
        campusScope: "university-park",
        confirmedBy: "html-parse",
        ...over,
      },
    ],
  };
}

describe("an Adviser-Defined Requirement", () => {
  const r = () => rankSlotPicks(catalog, poolFromRule(adviserRule), base);

  it("shows the requirement's own wording", () => {
    expect(r().poolNote).toContain("In consultation with adviser");
  });

  it("names the adviser as the authority", () => {
    expect(r().poolNote).toMatch(/adviser/i);
    expect(r().provenance.source).toBe("adviser");
  });

  it("shows no list at all — not a ranked one, not an empty one", () => {
    // An empty list reads as "no course qualifies", which is false: the
    // courses exist, we simply are not the ones who decide which.
    expect(r().picks).toEqual([]);
    expect(r().provenance.source).not.toBe("bulletin");
  });

  it("offers a catalog search scoped by whatever the prose DOES constrain", () => {
    // "6 credits in art history" constrains the topic even though it names no
    // courses. Leaving the student with nothing to click is worse than
    // handing them the search the requirement implies.
    const { searchHint } = r();
    expect(searchHint).toBeTruthy();
    expect(searchHint!.toLowerCase()).toContain("art history");
    // Not the boilerplate around it.
    expect(searchHint!.toLowerCase()).not.toContain("select");
    expect(searchHint!.toLowerCase()).not.toContain("consultation");
  });
});

describe("a Pool sourced from the Registry", () => {
  const ctxFor = (reg: Registry) => ({ programSlug: "p", edition: "2026-2027", registry: reg });
  // The engine keys entries on a hash of the wording; the test must match.
  const withFingerprint = (reg: Registry) => {
    reg.entries[0].fingerprint = fingerprintRequirement(adviserRule.commentRaw);
    return reg;
  };

  it("says where the list was read from, and when", () => {
    const reg = withFingerprint(registryFor(adviserRule.commentRaw));
    const res = rankSlotPicks(catalog, poolFromRule(adviserRule, ctxFor(reg)), base);
    expect(res.provenance.source).toBe("department-list");
    expect(res.provenance.readFrom?.url).toBe("https://example.psu.edu/approved-list");
    expect(res.provenance.readFrom?.fetchedAt).toBe("2026-09-01");
    expect(res.picks.length).toBeGreaterThan(0);
  });

  it("distinguishes a list a person checked from one a parser produced", () => {
    const parsed = withFingerprint(registryFor(adviserRule.commentRaw, { confirmedBy: "html-parse" }));
    const human = withFingerprint(registryFor(adviserRule.commentRaw, { confirmedBy: "human" }));
    expect(rankSlotPicks(catalog, poolFromRule(adviserRule, ctxFor(parsed)), base).provenance.humanChecked).toBe(false);
    expect(rankSlotPicks(catalog, poolFromRule(adviserRule, ctxFor(human)), base).provenance.humanChecked).toBe(true);
  });

  it("tells a branch-campus student when the list speaks for University Park", () => {
    const reg = withFingerprint(registryFor(adviserRule.commentRaw, { campusScope: "university-park" }));
    const res = rankSlotPicks(catalog, poolFromRule(adviserRule, ctxFor(reg)), { ...base, campus: "abington" });
    expect(res.provenance.campusCaveat).toBeTruthy();
    expect(res.provenance.campusCaveat).toMatch(/University Park/i);
    expect(res.provenance.campusCaveat).toMatch(/adviser/i);
  });

  it("says nothing about campus when the list is the student's own", () => {
    const reg = withFingerprint(registryFor(adviserRule.commentRaw, { campusScope: "abington" }));
    const res = rankSlotPicks(catalog, poolFromRule(adviserRule, ctxFor(reg)), { ...base, campus: "abington" });
    expect(res.provenance.campusCaveat).toBeUndefined();
  });
});

describe("with an entirely empty Registry", () => {
  it("behaves exactly as if none were supplied", () => {
    const empty = rankSlotPicks(catalog, poolFromRule(adviserRule, { programSlug: "p", edition: "2026-2027", registry: { entries: [] } }), base);
    const none = rankSlotPicks(catalog, poolFromRule(adviserRule), base);
    expect(empty.provenance).toEqual(none.provenance);
    expect(empty.poolNote).toBe(none.poolNote);
  });
});

describe("a list the bulletin itself publishes", () => {
  it("is marked as coming from the bulletin, with nothing to caveat", () => {
    const pool = poolFromRule({
      type: "selectCredits",
      credits: 3,
      commentRaw: "Select 3 credits from the following:",
      from: { kind: "courses", courses: ["MATH 140", "MATH 141"] },
    });
    const res = rankSlotPicks(catalog, pool, { ...base, campus: "abington" });
    expect(res.provenance.source).toBe("bulletin");
    expect(res.provenance.readFrom).toBeUndefined();
    expect(res.provenance.campusCaveat).toBeUndefined();
  });
});
