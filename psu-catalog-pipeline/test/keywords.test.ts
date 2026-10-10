/** Keyword extraction: what a student is told a course is about.
 *
 * The properties that matter are not "these exact words come out" -- that
 * would pin tf-idf scores and break on every catalog refresh. They are: no
 * verbs, no course codes, no boilerplate, nothing invented, and the same
 * bytes in means the same keywords out. */
import { describe, it, expect } from "vitest";
import { extractKeywords } from "../src/derive/keywords.js";

const subjects = new Set(["cmpsc", "math", "engl", "chem", "kines", "art"]);

/** A corpus big enough for document frequency to mean something.
 *
 * Two constraints pull against each other: a term needs to appear in at least
 * 3 documents to be eligible, and in under 12% of them to not be boilerplate.
 * So the filler is deliberately VARIED -- sharing no vocabulary with the
 * courses under test -- and each test course is echoed twice under other
 * codes, putting its terms at exactly df=3 out of ~100. An earlier version of
 * this helper gave every filler document the same sentence as the course being
 * tested, which pushed its terms to df=100% and filtered them all as
 * boilerplate; the test failed for a reason that had nothing to do with the
 * extractor. */
const BANK = [
  "Pottery glazing techniques and kiln temperature schedules for stoneware.",
  "Medieval monastic economies, tithe records, and manorial accounting.",
  "Avian migration corridors, wetland habitat, and banding protocols.",
  "Orchestral conducting gesture, baton technique, and score reduction.",
  "Soil horizon classification, pedogenesis, and erosion mapping.",
  "Insurance underwriting, actuarial reserving, and premium rating.",
  "Theatrical lighting design, gel selection, and rigging safety.",
  "Fermentation vessels, yeast strains, and brewing water chemistry.",
];

function corpus(extra: { code: string; title: string; description: string }[] = []) {
  const filler = Array.from({ length: 96 }, (_, i) => ({
    code: `FILL ${100 + i}`,
    title: `Filler ${i}`,
    description: BANK[i % BANK.length],
  }));
  // Two echoes per test course, so its vocabulary reaches df=3 of ~100.
  const echoes = extra.flatMap((c) => [
    { ...c, code: `${c.code}X`, title: `${c.title} II` },
    { ...c, code: `${c.code}Y`, title: `${c.title} III` },
  ]);
  return [...filler, ...extra, ...echoes];
}

describe("extracting what a course is about", () => {
  it("keeps the topic nouns of a real description", () => {
    const kw = extractKeywords(
      corpus([
        {
          code: "CMPSC 465",
          title: "Data Structures and Algorithms",
          description:
            "Fundamental concepts of computer science: data structures, analysis of algorithms, recursion, trees, sets, graphs, sorting.",
        },
      ]),
      { subjects },
    );
    const got = kw.get("CMPSC 465") ?? [];
    expect(got.length, "no keywords derived at all").toBeGreaterThan(2);
    expect(got).toContain("recursion");
    expect(got).toContain("graphs");
  });

  it("drops verbs, which is the whole reason for the tagger", () => {
    // Without part-of-speech filtering roughly one keyword in four was a verb
    // like these -- on a surface whose entire job is to say what a course
    // covers, which is worse than saying nothing.
    const kw = extractKeywords(
      corpus([
        {
          code: "KINES 202",
          title: "Functional Human Anatomy",
          description:
            "Students comprehend and apply anatomical nomenclature pertaining to bone and ligament. " +
            "Artworks are judged and intended outcomes are maximized. Students learn to identify tissues.",
        },
      ]),
      { subjects },
    );
    const got = kw.get("KINES 202") ?? [];
    for (const verb of ["comprehend", "pertaining", "judged", "intended", "maximized", "identify", "apply"]) {
      expect(got, `verb "${verb}" leaked into the keywords`).not.toContain(verb);
    }
    // And it has not simply removed everything.
    expect(got.length).toBeGreaterThan(1);
  });

  it("never names a course code", () => {
    // Descriptions name sibling courses, and tf-idf loves them because they
    // are rare: MATH 140 used to score "140a", "140b", "140h".
    const kw = extractKeywords(
      corpus([
        {
          code: "MATH 140",
          title: "Calculus",
          description:
            "MATH 140 and MATH 140A and MATH 140B cover differential calculus. " +
            "Students who took CHEM 110 or ENGL 202C may enroll. Topics: antidifferentiation, linearization.",
        },
      ]),
      { subjects },
    );
    const got = kw.get("MATH 140") ?? [];
    for (const t of got) {
      expect(t, `"${t}" looks like a course code`).not.toMatch(/^\d/);
      expect(subjects.has(t), `"${t}" is a subject prefix`).toBe(false);
    }
  });

  it("invents nothing — every keyword is a word of the description", () => {
    // Iron rule 1 as a property, not a promise: the output is a SUBSET of the
    // input's own words. A generated summary could not pass this.
    const description =
      "Thermochemistry, stoichiometry, and intermolecular forces in liquids. Molecular structure is emphasized.";
    const kw = extractKeywords(corpus([{ code: "CHEM 110", title: "Chemical Principles", description }]), { subjects });
    const words = new Set(description.toLowerCase().split(/[^a-z]+/));
    for (const t of kw.get("CHEM 110") ?? []) {
      expect(words.has(t), `"${t}" is not in the source description`).toBe(true);
    }
  });

  it("does not repeat the title back", () => {
    const kw = extractKeywords(
      corpus([
        {
          code: "ART 100",
          title: "Visual Arts Studio",
          description: "Studio practice in the visual arts. Artworks and critique of surroundings and media.",
        },
      ]),
      { subjects },
    );
    for (const t of kw.get("ART 100") ?? []) {
      expect(["visual", "arts", "studio"], `"${t}" is already in the title`).not.toContain(t);
    }
  });

  it("is deterministic — the same bytes give the same keywords", () => {
    // A catalog refresh has to produce a reviewable diff. Ties are broken
    // alphabetically for exactly this reason.
    const input = corpus([
      { code: "STAT 200", title: "Elementary Statistics", description: "Statistical inference, sampling distributions, and probability." },
    ]);
    expect(extractKeywords(input, { subjects }).get("STAT 200")).toEqual(
      extractKeywords(input, { subjects }).get("STAT 200"),
    );
  });

  it("omits a course it could derive nothing for, rather than claiming empty", () => {
    const kw = extractKeywords(corpus([{ code: "NONE 001", title: "Nothing", description: "   " }]), { subjects });
    expect(kw.has("NONE 001")).toBe(false);
  });
});
