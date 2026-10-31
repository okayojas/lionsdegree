/** The search index carries counts, not prose.
 *
 * Two kinds of claim here. The codec ones are ordinary round-trip properties.
 * The last block is the one that matters: the SHIPPED catalog must contain no
 * description text at all, because "we keep it internally" only means
 * something if it never leaves the build (DECISIONS.md 5.1). */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { decodePostings, encodePostings, prefixRange, MAX_COUNT } from "../src/postings.js";
import { CATALOG_DIR, fullIndexDir } from "./edition.js";

describe("the postings codec", () => {
  it("round-trips ids and counts", () => {
    const m = new Map([[0, 1], [5, 3], [900, 5], [28_972, 2]]);
    expect(decodePostings(encodePostings(m))).toEqual(m);
  });

  it("round-trips whatever order the ids arrive in", () => {
    const shuffled = new Map([[900, 5], [0, 1], [28_972, 2], [5, 3]]);
    expect(decodePostings(encodePostings(shuffled))).toEqual(new Map([[0, 1], [5, 3], [900, 5], [28_972, 2]]));
  });

  it("caps counts, exactly as the scorer does", () => {
    // Above 5 the scorer cannot tell the difference, so neither should the
    // bytes -- and an uncapped count would leak how emphatic a description is.
    expect(decodePostings(encodePostings(new Map([[7, 99]]))).get(7)).toBe(MAX_COUNT);
    expect(decodePostings(encodePostings(new Map([[7, 0]]))).get(7)).toBe(1);
  });

  it("is empty for a course with no description", () => {
    expect(encodePostings(new Map())).toEqual([]);
    expect(decodePostings([])).toEqual(new Map());
  });

  it("packs a posting into one integer", () => {
    // The encoding's whole purpose: 80% of postings have count 1, so a
    // parallel counts array would be mostly ones. One int per posting.
    expect(encodePostings(new Map([[3, 1], [10, 2]]))).toHaveLength(2);
  });
});

describe("prefix lookup", () => {
  const terms = ["algebra", "statistic", "statistical", "statistics", "thermostat", "zebra"];

  it("finds every inflection of a stem, and only those", () => {
    // The old scorer substring-matched, so a stem of "statistic" also hit
    // "statistics" and "statistical". That behaviour is preserved here.
    const [lo, hi] = prefixRange(terms, "statistic");
    expect(terms.slice(lo, hi)).toEqual(["statistic", "statistical", "statistics"]);
  });

  it("no longer matches inside a word, which is the point", () => {
    // "stat" used to hit inside "thermostat". A prefix range cannot.
    const [lo, hi] = prefixRange(terms, "stat");
    expect(terms.slice(lo, hi)).not.toContain("thermostat");
  });

  it("returns an empty range for a term that is absent", () => {
    const [lo, hi] = prefixRange(terms, "quantum");
    expect(hi - lo).toBe(0);
  });

  it("handles the ends of the dictionary", () => {
    expect(terms.slice(...prefixRange(terms, "algebra"))).toEqual(["algebra"]);
    expect(terms.slice(...prefixRange(terms, "zebra"))).toEqual(["zebra"]);
    expect(prefixRange([], "anything")).toEqual([0, 0]);
  });
});

describe("the published catalog", () => {
  /** Reading the bytes that actually ship, not the pipeline's working copy. */
  const courseFiles = (() => {
    const out: string[] = [];
    for (const sub of [["courses"], ["courses", "grad"]]) {
      const dir = path.join(CATALOG_DIR, ...sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) out.push(path.join(dir, f));
    }
    return out;
  })();

  it("has course files to check", () => {
    // A path typo here would make every assertion below vacuous.
    expect(courseFiles.length, `no course files under ${CATALOG_DIR}`).toBeGreaterThan(100);
  });

  it("publishes no description prose", () => {
    // The claim the whole change rests on. Shipping the text and not
    // rendering it is still distribution.
    const offenders: string[] = [];
    let courses = 0;
    for (const f of courseFiles) {
      for (const c of JSON.parse(fs.readFileSync(f, "utf-8"))) {
        courses++;
        if (typeof c.description === "string" && c.description.trim()) {
          offenders.push(`${path.basename(f)}: ${c.code}`);
        }
      }
    }
    expect(courses, "no courses were examined").toBeGreaterThan(10_000);
    expect(offenders.slice(0, 5), "description prose is still being published").toEqual([]);
  });

  it("still tells a student what a course is about", () => {
    // Removing the prose without replacing it would leave a bare title, which
    // is a worse product, not a safer one.
    let withKeywords = 0;
    let total = 0;
    for (const f of courseFiles) {
      for (const c of JSON.parse(fs.readFileSync(f, "utf-8"))) {
        total++;
        if (c.keywords?.length) withKeywords++;
      }
    }
    expect(withKeywords / total).toBeGreaterThan(0.9);
  });

  it("links every course to the Bulletin page its text lives on", () => {
    // The prose is not gone, it is one click away -- and the link is what
    // makes this a reference rather than a replacement.
    let missing = 0;
    let total = 0;
    for (const f of courseFiles) {
      for (const c of JSON.parse(fs.readFileSync(f, "utf-8"))) {
        total++;
        if (!c.url) missing++;
      }
    }
    expect(missing / total).toBeLessThan(0.01);
  });

  it("ships a search index of counts, carrying no text of its own", () => {
    const idx = JSON.parse(fs.readFileSync(path.join(fullIndexDir(), "search-index.json"), "utf-8"));
    expect(Array.isArray(idx.terms), "index is not in the postings format").toBe(true);
    expect(idx.terms.length).toBeGreaterThan(1000);
    // Sorted: prefixRange binary-searches it, and an unsorted dictionary would
    // silently return wrong ranges rather than fail.
    const sorted = [...idx.terms].sort();
    expect(idx.terms).toEqual(sorted);
    // No course entry carries prose.
    for (const c of idx.courses) expect(c.description ?? "").toBe("");
    // And the postings are actually there.
    expect(idx.courses.filter((c: { t?: number[] }) => c.t?.length).length).toBeGreaterThan(10_000);
  });
});
