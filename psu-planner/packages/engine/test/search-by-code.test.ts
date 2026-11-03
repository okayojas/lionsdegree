/** Finding a course by typing its code.
 *
 * THE BUG, reported from the "courses I've taken" box: MUSIC 4 was not
 * there. It is in the bulletin — "Film Music", 3 credits, GA — and
 * searching its title found it immediately. Searching its CODE did not.
 *
 * `qterms` dropped every one-character token, so "MUSIC 4" became
 * "music" and answered with the first eight MUSIC courses in score order:
 * MUSIC 101, 106, 109, 11, 110, 113, 114, 119. The box shows eight. The
 * course the student named was not among them, and typing the number on
 * its own returned nothing at all, because a query of no terms
 * short-circuits to an empty list.
 *
 * WHO IT HURT is the reason this is more than a ranking nit. Penn State
 * numbers first-year seminars and introductory gen-eds with one digit —
 * AA 1, AERSP 1, ANTH 1, ART 1, PSU 1, MUSIC 4 — so the 176 courses
 * nobody could find by code were disproportionately the ones a first-year
 * student has actually taken and is trying to record. 91 of them carry a
 * gen-ed designation.
 *
 * Making the digit survive was half of it. `code.includes(t)` cannot tell
 * "MUSIC 4" from "MUSIC 114", so the moment single digits were searchable
 * every course whose number merely CONTAINED the digit scored the same —
 * and there are many more of those, so MUSIC 4 came back sixth of six.
 * Two more signals fix that: a term that IS the course's number, and the
 * whole query being the course's code.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, qterms, searchCatalog, type Catalog, type Course } from "../src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "web", "public", "catalog");
const LATEST = (JSON.parse(fs.readFileSync(path.join(ROOT, "editions.json"), "utf-8")) as { latest: string }).latest;
const DIR = path.join(ROOT, LATEST);
const subjects = JSON.parse(fs.readFileSync(path.join(DIR, "subjects_index.json"), "utf-8")) as Record<string, string>;

/** Real subjects off the shipped catalog, not a fixture. A search that
 * works against six invented courses proves nothing about a bulletin
 * where 255 share the prefix the student typed. */
function catalogOf(...prefixes: string[]): Catalog {
  let rows: Course[] = [];
  for (const p of prefixes) {
    if (!subjects[p]) throw new Error(`${p} is not a subject in the ${LATEST} catalog`);
    rows = rows.concat(JSON.parse(fs.readFileSync(path.join(DIR, subjects[p]), "utf-8")));
  }
  return buildCatalog(rows);
}

/** THE BOX SHOWS EIGHT. Ranking is not a tie-breaker here — a course
 * below the eighth result does not exist as far as the student is
 * concerned, which is exactly how MUSIC 4 went missing. */
const VISIBLE = 8;

describe("the number in a course code", () => {
  it("is not thrown away for being one digit", () => {
    expect(qterms("MUSIC 4"), "the digit was dropped, so this searches for every MUSIC course").toEqual([
      "music",
      "4",
    ]);
  });

  it("is still thrown away when it is a stray letter", () => {
    // The length filter exists for a reason. A digit is never noise in a
    // course search; a lone letter usually is.
    expect(qterms("history of a nation")).toEqual(["history", "nation"]);
  });

  it("is a query all by itself", () => {
    // A query that reduces to no terms short-circuits to an empty list,
    // so "4" used to return nothing whatsoever.
    expect(qterms("4"), "a bare course number is not a searchable query").toEqual(["4"]);
  });
});

describe("searching a single-digit course by its code", () => {
  it("finds MUSIC 4, the course this was reported for", () => {
    const hits = searchCatalog(catalogOf("MUSIC"), "MUSIC 4", VISIBLE);
    expect(hits, `MUSIC 4 is not in the ${VISIBLE} results a student can see: ${hits.join(", ")}`).toContain("MUSIC 4");
    expect(hits[0], `the course the student named is not the first result: ${hits.join(", ")}`).toBe("MUSIC 4");
  });

  it("is not buried under every course whose number merely contains that digit", () => {
    // MUSIC 114, 240, 241, 341, 345 all contain a 4. With only the
    // tokenizer fixed they outranked MUSIC 4, because a substring match
    // on the code scores the same as the course itself.
    const hits = searchCatalog(catalogOf("MUSIC"), "MUSIC 4", VISIBLE);
    const substringOnly = hits.filter((h) => h !== "MUSIC 4" && h.includes("4"));
    expect(substringOnly.length, "this subject has no near-miss numbers, so the ordering proves nothing")
      .toBeGreaterThan(0);
    expect(
      hits.indexOf("MUSIC 4"),
      `courses that merely contain a 4 came first: ${hits.join(", ")}`,
    ).toBeLessThan(hits.indexOf(substringOnly[0]));
  });

  it("works for the first-year seminars this mostly affected", () => {
    // The population that made this worth fixing: single-digit numbers
    // are where the introductory courses live.
    const cat = catalogOf("ART", "PSU", "ANTH");
    for (const code of ["ART 1", "PSU 1", "ANTH 1"]) {
      const hits = searchCatalog(cat, code, VISIBLE);
      expect(hits[0], `"${code}" did not find ${code} first: ${hits.join(", ")}`).toBe(code);
    }
  });

  it("finds the courses numbered 4 when that is all the student types", () => {
    const hits = searchCatalog(catalogOf("MUSIC", "MATH", "ENGL"), "4", VISIBLE);
    expect(hits, `a bare number found nothing numbered 4: ${hits.join(", ")}`).toContain("MUSIC 4");
    // Ahead of the longer numbers that merely contain it.
    expect(hits.indexOf("MUSIC 4")).toBeLessThan(VISIBLE);
  });
});

describe("typing a full course code", () => {
  it("puts that exact course first, whatever else mentions it", () => {
    // "MUSIC 50" used to answer MUSIC 462W, MUSIC 464W, MUSIC 50 — in
    // that order. There is no reading of the query that wants that.
    const hits = searchCatalog(catalogOf("MUSIC"), "MUSIC 50", VISIBLE);
    expect(hits[0], `an exact code was outranked: ${hits.join(", ")}`).toBe("MUSIC 50");
  });

  it("puts the plain course ahead of its own suffixed variants", () => {
    // MATH 140 has 140B, 140E, 140G and 140H beside it, and ENGL 15 has
    // 15A, 15E, 15S. A student typing the plain code means the plain one.
    const cat = catalogOf("MATH", "ENGL");
    expect(searchCatalog(cat, "MATH 140", VISIBLE)[0]).toBe("MATH 140");
    expect(searchCatalog(cat, "ENGL 15", VISIBLE)[0]).toBe("ENGL 15");
  });

  it("does not care how the code is spaced or cased", () => {
    const cat = catalogOf("MUSIC");
    for (const q of ["music 4", "MUSIC   4", "Music 4"]) {
      expect(searchCatalog(cat, q, VISIBLE)[0], `"${q}" did not find MUSIC 4 first`).toBe("MUSIC 4");
    }
  });

  it("still finds a suffixed code when that is what was typed", () => {
    const cat = catalogOf("ANTH", "CAS");
    expect(searchCatalog(cat, "ANTH 2N", VISIBLE)[0]).toBe("ANTH 2N");
    expect(searchCatalog(cat, "CAS 100A", VISIBLE)[0]).toBe("CAS 100A");
  });
});

describe("searching by title still works", () => {
  it("finds MUSIC 4 by name, as it always did", () => {
    // The half that was never broken, asserted so the code-matching
    // bonuses cannot be tuned until they swamp the title signal.
    const hits = searchCatalog(catalogOf("MUSIC", "ENGL"), "film music", VISIBLE);
    expect(hits[0], `"film music" no longer finds MUSIC 4 first: ${hits.join(", ")}`).toBe("MUSIC 4");
  });

  it("still answers a plain subject search with that subject's courses", () => {
    const hits = searchCatalog(catalogOf("MUSIC"), "music", VISIBLE);
    expect(hits.length).toBe(VISIBLE);
    expect(hits.every((h) => h.startsWith("MUSIC ")), `a subject search drifted: ${hits.join(", ")}`).toBe(true);
  });
});
