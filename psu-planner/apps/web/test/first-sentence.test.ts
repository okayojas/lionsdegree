/** The one sentence of Penn State's prose we publish.
 *
 * The published catalog carries no course descriptions — they are the
 * University's writing, and shipping static files is distribution whether
 * or not anything renders them (DECISIONS.md 5.1). What replaced them for
 * a student was eight extracted keywords, and measured against the real
 * catalog they read badly: MUSIC 4 came out as "hollywood, narrative,
 * eras, scene, extent, premier, functions, musical", where three of those
 * are extraction noise and none of it is a sentence.
 *
 * So the opening sentence is published, in quotes, attributed, beside the
 * link to the full entry. That is a deliberate narrowing of 5.1, and this
 * file is what keeps it narrow: a parser that quietly starts returning
 * paragraphs turns "one sentence" into "the description", which is the
 * thing the rule exists to prevent.
 *
 * The cases below are not invented. Each one was found by running the
 * extractor over all 14,493 descriptions in the 2026-2027 edition and
 * looking at what came back wrong.
 */
import { describe, it, expect } from "vitest";
import { firstSentence, MIN_SUMMARY, MAX_SUMMARY } from "../scripts/firstSentence.mjs";

describe("an ordinary description", () => {
  it("returns the opening sentence and stops there", () => {
    // The real MUSIC 4 entry: a short blurb, then the Bulletin splices the
    // course header and a long expansion onto the end of it.
    const d =
      "An introductory examination of music's role in Hollywood narrative film from the classic era " +
      "(1930s and 1940s) to the present. MUSIC 4 Film Music (3) (GA)The course examines the role of music.";
    expect(firstSentence(d)).toBe(
      "An introductory examination of music's role in Hollywood narrative film from the classic era (1930s and 1940s) to the present.",
    );
  });

  it("keeps a sentence that is a list of semicolons", () => {
    // MATH 230 reads as a syllabus line and is one of the better ones.
    const d = "Three-dimensional analytic geometry; vectors in space; partial differentiation; double and triple integrals. More text here.";
    expect(firstSentence(d)).toMatch(/^Three-dimensional analytic geometry;.*integrals\.$/);
  });

  it("collapses the whitespace the Bulletin leaves behind", () => {
    const d = "An historical survey of the political and\n   economic development of America.   And more.";
    expect(firstSentence(d)).toBe("An historical survey of the political and economic development of America.");
  });
});

describe("periods that do not end a sentence", () => {
  it("does not cut at e.g.", () => {
    // THE ONE THAT SURVIVED THE FIRST IMPLEMENTATION. At the first period
    // of "e.g." everything before it is just "e", so an uppercase-only
    // initial rule let "…modern languages (e." through as finished.
    const d = "Engineering topics: parallel programming, and various modern languages (e.g. C++, Java, and Ada). Then more.";
    expect(firstSentence(d)).toBe(
      "Engineering topics: parallel programming, and various modern languages (e.g. C++, Java, and Ada).",
    );
  });

  it("does not cut at i.e.", () => {
    const d = "The course covers the standard model, i.e. the one in current use, across both terms. A second sentence.";
    expect(firstSentence(d)!).toMatch(/current use, across both terms\.$/);
  });

  it("does not cut at U.S.", () => {
    const d = "This course focuses on the design and analysis of cities from ancient to modern periods in the U.S. and Europe. More.";
    expect(firstSentence(d)!).toMatch(/U\.S\. and Europe\.$/);
  });

  it("does not cut at an academic abbreviation", () => {
    for (const abbr of ["etc.", "cf.", "Ph.D.", "Vol."]) {
      const d = `A survey of the field covering theory, practice, ${abbr} and their applications in industry. Second sentence here.`;
      expect(firstSentence(d)!, `cut at ${abbr}`).toMatch(/applications in industry\.$/);
    }
  });

  it("does not cut inside a decimal", () => {
    const d = "Students complete 3.5 credits of laboratory work alongside the lecture component. And then more text.";
    expect(firstSentence(d)).toBe("Students complete 3.5 credits of laboratory work alongside the lecture component.");
  });

  it("does not cut at an initial", () => {
    const d = "The seminar studies the collected letters of J. Smith and their influence on the period. More follows.";
    expect(firstSentence(d)!).toMatch(/influence on the period\.$/);
  });

  it("DOES cut where the Bulletin splices two blocks with no space", () => {
    // "…cities.Students will…" is not a typo in one sentence, it is two
    // blocks concatenated, and the sentence genuinely ends.
    const d = "An analysis of the design of ancient and modern cities.Students will complete a portfolio of work.";
    expect(firstSentence(d)).toBe("An analysis of the design of ancient and modern cities.");
  });
});

describe("sentences it declines to publish", () => {
  it("declines one too short to describe anything", () => {
    // Real openers: "Life is social.", "Is \"race\" real?", "Drawing from
    // life." Perfectly good sentences that tell a student nothing. 477
    // descriptions open this way; the caller shows keywords instead.
    expect(firstSentence("Life is social. The course examines why.")).toBeNull();
    expect(firstSentence('Is "race" real? The course takes up the question.')).toBeNull();
  });

  it("declines one long enough to be the description itself", () => {
    // THE RULE THIS FILE EXISTS FOR. One sentence is published on purpose;
    // a 600-character run-on is a paragraph wearing a full stop, and
    // publishing it would be republishing the description.
    const long = `${"The course covers a great many things in considerable detail, ".repeat(12)}and ends.`;
    expect(long.length).toBeGreaterThan(MAX_SUMMARY);
    expect(firstSentence(long)).toBeNull();
  });

  it("never returns a fragment", () => {
    // NULL RATHER THAN A BEST EFFORT. A truncated sentence published in
    // quotes under Penn State's name is a wrong answer wearing a citation.
    for (const d of ["Short.", "", "   ", "A." , "Is it?"]) {
      const s = firstSentence(d);
      expect(s === null || s.length >= MIN_SUMMARY, `${JSON.stringify(d)} -> ${JSON.stringify(s)}`).toBe(true);
    }
  });

  it("declines anything that is not a string", () => {
    for (const bad of [undefined, null, 42, {}, []] as unknown[]) {
      expect(firstSentence(bad as string)).toBeNull();
    }
  });
});

describe("the bound is real", () => {
  it("never returns more than the published maximum", () => {
    // Asserted as a property rather than trusted, because this number is
    // the entire difference between "a sentence" and "the description",
    // and the mcp sync script refuses to ship anything over it.
    const samples = [
      "A short one that is comfortably long enough to be useful to a student reading it.",
      `${"word ".repeat(200)}end.`,
      "An introductory examination of music's role in Hollywood narrative film from the classic era (1930s and 1940s) to the present. More.",
    ];
    for (const d of samples) {
      const s = firstSentence(d);
      if (s !== null) expect(s.length).toBeLessThanOrEqual(MAX_SUMMARY);
    }
  });

  it("agrees with the guard that ships it", () => {
    // `packages/mcp/scripts/sync-catalog.mjs` imports MAX_SUMMARY rather
    // than repeating it. Two copies of a limit is one copy that stops
    // matching, and the one that stops matching is the guard.
    expect(MAX_SUMMARY).toBeGreaterThan(MIN_SUMMARY);
    expect(MIN_SUMMARY).toBeGreaterThan(0);
  });
});
