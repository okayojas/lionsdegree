/** Discovery: an interest in plain words, a combination of real credentials.
 *
 * The thing nothing else does. The Bulletin lists programs; it does not tell
 * a student that two of them overlap by fourteen credits.
 *
 * Two properties carry the whole feature and both are tested against the real
 * shipped catalog:
 *
 *  1. Every credential returned is a REAL program. Iron rule 1 says no model
 *     output is ever written into the dataset, and a recommendation engine
 *     that invents a plausible-sounding minor is that failure wearing a
 *     different hat.
 *  2. The overlap figure is COMPUTED, not asserted. "14 credits double-count"
 *     is the single most load-bearing number in the feature — it is the
 *     reason to take the combination — and a student will plan a year around
 *     it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildCatalog,
  discover,
  programSearchText,
  sharedCredits,
  type Catalog,
  type Course,
  type ProgramRequirements,
} from "../src/index.js";
import { CATALOG_DIR } from "./edition.js";

const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, rel), "utf-8"));
const requirements = load("program-requirements.json") as Record<string, ProgramRequirements>;
const subjects = load("subjects_index.json") as Record<string, string>;

/** The whole catalog: discovery ranges over every program, so it cannot be
 * given a subject-filtered slice the way a single-plan test can. */
const catalog: Catalog = buildCatalog(
  [...new Set(Object.values(subjects))].flatMap((rel) => load(rel) as Course[]),
);

const slugs = Object.keys(requirements);

describe("what a program is about", () => {
  it("includes the titles of the courses it requires, not just its name", () => {
    // The point of the whole matcher. A student typing "machine learning"
    // will never match "Artificial Intelligence, B.S." on its name -- the
    // phrase lives in the TITLES of the courses that program requires.
    const ai = slugs.find((s) => /artificial-intelligence/.test(s) && /bs$/.test(s));
    expect(ai, "no AI major in the catalog to test against").toBeTruthy();
    const text = programSearchText(requirements[ai!], catalog);
    expect(text.length, "no searchable text derived").toBeGreaterThan(80);
    expect(text).toMatch(/artificial intelligence/i);
  });

  it("is text drawn from the catalog, never invented", () => {
    const slug = slugs[0];
    const text = programSearchText(requirements[slug], catalog);
    // Every word either comes from the program's name or from a real course
    // title. Nothing is generated.
    const source = (
      requirements[slug].name +
      " " +
      Object.values(catalog).map((c) => c.title).join(" ")
    ).toLowerCase();
    for (const word of text.toLowerCase().split(/\s+/).slice(0, 40)) {
      if (word.length < 4) continue;
      expect(source, `"${word}" is in the search text but in no catalog title`).toContain(word);
    }
  });
});

describe("credits that count twice", () => {
  it("is computed from the two programs' own requirements", () => {
    const a = slugs.find((s) => /artificial-intelligence.*bs$/.test(s))!;
    const b = slugs.find((s) => /computer-science.*bs$/.test(s)) ?? slugs[1];
    const got = sharedCredits(requirements[a], requirements[b], catalog);
    expect(got.credits).toBeGreaterThanOrEqual(0);
    // Every shared course is named, so the number can be checked by hand.
    for (const code of got.courses) expect(catalog[code], `${code} is not a real course`).toBeTruthy();
    // And the credits are the sum of those courses' credits, not a guess.
    const sum = got.courses.reduce((n, c) => n + (catalog[c]?.creditsParsed?.min ?? 0), 0);
    expect(got.credits).toBe(sum);
  });

  it("a program shares everything with itself", () => {
    // The sanity check that catches an intersection written backwards.
    const slug = slugs.find((s) => /bs$/.test(s))!;
    const self = sharedCredits(requirements[slug], requirements[slug], catalog);
    const other = sharedCredits(requirements[slug], requirements[slugs.find((s) => s !== slug)!], catalog);
    expect(self.credits).toBeGreaterThanOrEqual(other.credits);
  });

  it("is zero, not negative or NaN, for programs with nothing in common", () => {
    const a = slugs.find((s) => /music/.test(s));
    const b = slugs.find((s) => /nuclear|mining/.test(s));
    if (!a || !b) return;
    const got = sharedCredits(requirements[a], requirements[b], catalog);
    expect(Number.isFinite(got.credits)).toBe(true);
    expect(got.credits).toBeGreaterThanOrEqual(0);
  });
});

describe("discovering a combination", () => {
  it("returns real programs for a real interest", () => {
    const out = discover("machine learning and clean energy", { requirements, catalog, limit: 3 });
    expect(out.length, "nothing found for a mainstream interest").toBeGreaterThan(0);
    for (const combo of out) {
      // Every credential is a program that exists, with the type it claims.
      expect(requirements[combo.major.slug], `${combo.major.slug} is not a real program`).toBeTruthy();
      expect(requirements[combo.major.slug].type).toBe("major");
      for (const extra of combo.extras) {
        expect(requirements[extra.slug], `${extra.slug} is not a real program`).toBeTruthy();
        expect(["minor", "certificate"]).toContain(requirements[extra.slug].type);
      }
    }
  });

  it("states an overlap that matches the programs it chose", () => {
    const out = discover("artificial intelligence", { requirements, catalog, limit: 1 });
    expect(out.length).toBeGreaterThan(0);
    const combo = out[0];
    // Recomputed independently from the combination's own members.
    let expected = 0;
    for (const extra of combo.extras) {
      expected += sharedCredits(requirements[combo.major.slug], requirements[extra.slug], catalog).credits;
    }
    expect(combo.sharedCredits).toBe(expected);
  });

  it("gives an empty answer rather than a confident wrong one", () => {
    // Nonsense in, nothing out. The failure to avoid is a plausible-looking
    // combination for an interest the catalog has no answer to.
    const out = discover("qwertyuiop zxcvbnm", { requirements, catalog, limit: 3 });
    expect(out).toEqual([]);
  });

  it("ignores an empty query instead of returning the whole catalog", () => {
    expect(discover("   ", { requirements, catalog, limit: 3 })).toEqual([]);
  });

  it("is deterministic — the same words give the same combinations", () => {
    const a = discover("environmental policy", { requirements, catalog, limit: 3 });
    const b = discover("environmental policy", { requirements, catalog, limit: 3 });
    expect(a.map((c) => c.major.slug)).toEqual(b.map((c) => c.major.slug));
  });

  it("never pairs a program with itself", () => {
    for (const combo of discover("engineering", { requirements, catalog, limit: 5 })) {
      const all = [combo.major.slug, ...combo.extras.map((e) => e.slug)];
      expect(new Set(all).size, "a combination repeats a program").toBe(all.length);
    }
  });
});

/** By NAME, not by slug pattern. The first version of these tests matched
 * `/engineering-science.*bs$/` and silently got
 * `behrend-polymer-engineering-science-bs`, a different program with nothing
 * in common with the minor — so the assertions passed having compared the
 * wrong pair. */
const byName = (re: RegExp, type: string) =>
  Object.entries(requirements).find(([, p]) => re.test(p.name) && p.type === type)?.[0];

describe("the overlap figure is one a student could actually realise", () => {
  const major = byName(/^Engineering Science, B\.S\./, "major");
  const minor = byName(/^Environmental Engineering, Minor/, "minor");

  it("has the pair this regression is about", () => {
    // Without this the two tests below skip and report success.
    expect(major, "Engineering Science B.S. is not in the catalog").toBeTruthy();
    expect(minor, "Environmental Engineering minor is not in the catalog").toBeTruthy();
  });

  it("does not exceed what the smaller credential even requires", () => {
    // The measured bug: this pair reported 71 shared credits against a minor
    // that is a fraction of that. An elective pool lists every course that
    // COULD satisfy a requirement; the requirement consumes only what it
    // asks for.
    //
    // Bounded against the minor shared WITH ITSELF, which is its own total
    // requirement measured the same way. Summing the rules' `credits` fields
    // instead undercounts: plenty of rules leave it null and take the course's
    // own credits, and a bound computed differently from the thing it bounds
    // is not a bound.
    const own = sharedCredits(requirements[minor!], requirements[minor!], catalog).credits;
    expect(own, "the minor requires nothing measurable").toBeGreaterThan(0);

    const ov = sharedCredits(requirements[major!], requirements[minor!], catalog);
    expect(
      ov.credits,
      `the minor totals ${own} credits but ${ov.credits} are reported as double-counting`,
    ).toBeLessThanOrEqual(own);
  });

  it("holds that bound for every combination it suggests, not just one pair", () => {
    // The pair above is the regression. This is the property.
    for (const q of ["machine learning and clean energy", "writing and psychology", "environmental policy"]) {
      for (const combo of discover(q, { requirements, catalog, limit: 3 })) {
        for (const extra of combo.extras) {
          const own = sharedCredits(requirements[extra.slug], requirements[extra.slug], catalog).credits;
          const ov = sharedCredits(requirements[combo.major.slug], requirements[extra.slug], catalog).credits;
          expect(ov, `"${q}": ${extra.name} totals ${own} but shares ${ov}`).toBeLessThanOrEqual(own);
        }
      }
    }
  });

  it("counts an elective slot once, not once per course that could fill it", () => {
    const ov = sharedCredits(requirements[major!], requirements[minor!], catalog);
    // The courses in common are still reported — they are what makes the
    // number checkable — but they are not all simultaneously countable.
    expect(ov.courses.length, "no shared courses, so this proves nothing").toBeGreaterThan(5);
    expect(ov.credits, "an elective pool is being counted course by course").toBeLessThan(ov.courses.length * 3);
  });
});
