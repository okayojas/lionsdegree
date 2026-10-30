/** The audit index must cover the whole catalog, and must stay small (#26).
 *
 * Two failures this guards, and they pull in opposite directions.
 *
 * OMISSION. The degree audit reasons about every course, because an elective
 * or a General Education requirement can be satisfied by almost anything. An
 * index missing a subject does not throw — it quietly tells a student that a
 * course they could take does not exist, which is the confident-wrong-answer
 * failure this project is built to avoid (iron rule 2).
 *
 * REGROWTH. The reason #24 exists is that `search-index.json` grew 3.4x with
 * nobody watching. An index is a convenient place to put "just one more
 * field", and five of those is the old file again. So the shape is asserted,
 * not just the contents.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(root, "data", "out");

/** Editions that have actually been built. The pipeline's output is not in
 * version control -- it is produced by a scrape -- so this reports rather
 * than silently passing when there is nothing to check. */
const editions = fs.existsSync(outRoot)
  ? fs.readdirSync(outRoot).filter((e) => fs.existsSync(path.join(outRoot, e, "audit-index.json")))
  : [];

/** Every course the pipeline wrote to the per-subject files, which is the
 * population the index has to cover. Read independently of the index so the
 * comparison means something. */
function coursesOnDisk(edition: string): Set<string> {
  const codes = new Set<string>();
  for (const dir of [path.join(outRoot, edition, "courses"), path.join(outRoot, edition, "courses", "grad")]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      for (const c of JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"))) {
        if (c?.code) codes.add(c.code);
      }
    }
  }
  return codes;
}

const ALLOWED = new Set(["code", "title", "creditsParsed", "genEd", "attributes"]);

describe.skipIf(editions.length === 0)("the audit index", () => {
  it("has been built for at least one edition", () => {
    expect(editions.length, "no audit-index.json anywhere — run scripts/buildIndex.ts").toBeGreaterThan(0);
  });

  for (const edition of editions) {
    describe(edition, () => {
      const index = JSON.parse(fs.readFileSync(path.join(outRoot, edition, "audit-index.json"), "utf-8")) as {
        courses: Record<string, unknown>[];
      };

      it("covers every course the pipeline wrote", () => {
        const onDisk = coursesOnDisk(edition);
        const inIndex = new Set(index.courses.map((c) => c.code as string));
        const missing = [...onDisk].filter((c) => !inIndex.has(c));
        expect(
          missing.slice(0, 10),
          `${missing.length} courses are in the catalog but not the audit index`,
        ).toEqual([]);
        expect(inIndex.size).toBe(onDisk.size);
      });

      it("invents no course the catalog does not have", () => {
        const onDisk = coursesOnDisk(edition);
        const extra = index.courses.map((c) => c.code as string).filter((c) => !onDisk.has(c));
        expect(extra.slice(0, 10), "the index names courses the catalog does not").toEqual([]);
      });

      it("carries a title for every course", () => {
        // A code with no title is a row the audit can count but a student
        // cannot read.
        const untitled = index.courses.filter((c) => !c.title).map((c) => c.code);
        expect(untitled.slice(0, 10), "courses in the index with no title").toEqual([]);
      });

      it("carries no field it is not supposed to", () => {
        // THE ANTI-REGROWTH GUARD. `description` would be a licensing
        // problem (DECISIONS.md 5.1); `t` would put the search postings back
        // on the boot path; `url` and `keywords` already live in the
        // per-subject files the course modal loads.
        const strays = new Set<string>();
        for (const c of index.courses) for (const k of Object.keys(c)) if (!ALLOWED.has(k)) strays.add(k);
        expect(
          [...strays],
          "fields leaked into the audit index — every one of these is weight on a path every student walks",
        ).toEqual([]);
      });

      it("stays small enough to be worth the split", () => {
        // The whole point of #26 is the gap between this and the file it
        // replaces. If they converge, the split has stopped paying and the
        // next person should know before shipping it.
        const gz = (f: string) => zlib.gzipSync(fs.readFileSync(path.join(outRoot, edition, f))).length / 1024;
        const audit = gz("audit-index.json");
        const search = gz("search-index.json");
        expect(
          audit,
          `audit index is ${audit.toFixed(0)} KB gzipped against the search index's ${search.toFixed(0)} KB`,
        ).toBeLessThan(350);
        expect(audit, "the audit index is no longer meaningfully smaller than what it replaces").toBeLessThan(
          search / 4,
        );
      });
    });
  }
});
