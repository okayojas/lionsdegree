/** What the server reads, and when.
 *
 * The point of #31 is not that the catalog loads — it already did — but
 * that it stops loading all of it up front. A hosted isolate has 128 MB and
 * the old path took 138 MB of RSS, so "which files were touched" is the
 * behaviour under test, not an implementation detail.
 *
 * Observed through a source that records every read. That is the seam
 * doing its job: the question "did this touch the postings" is answerable
 * without reaching inside the loader at all.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsCatalogSource, type CatalogSource } from "../src/source.js";
import { loadEdition } from "../src/catalog.js";

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "catalog");

/** Wraps a source and remembers what was asked for. */
class Recording implements CatalogSource {
  readonly reads: string[] = [];
  constructor(private readonly inner: CatalogSource) {}
  read<T>(p: string): Promise<T | null> {
    this.reads.push(p);
    return this.inner.read<T>(p);
  }
  editions(): Promise<string[]> {
    return this.inner.editions();
  }
}

const recorder = () => new Recording(new FsCatalogSource(CATALOG));
const touched = (r: Recording, needle: string) => r.reads.filter((p) => p.includes(needle));

describe("loading an Edition", () => {
  it("has every Course in the catalog without reading a single subject file", async () => {
    // The audit has to see the WHOLE catalog -- an elective or a General
    // Education requirement can be satisfied by almost anything -- and the
    // audit index is how it does that for 212 KB instead of 2.4 MB.
    const src = recorder();
    const ed = await loadEdition(src, "2026-2027");
    expect(Object.keys(ed.catalog).length).toBeGreaterThan(10_000);
    expect(touched(src, "courses/"), "a subject file was read at load").toEqual([]);
  });

  it("never reads the retired combined index", async () => {
    // `search-index.json` is 11 MB and carries everything at once. Reading
    // it is the whole problem this ticket exists to remove, and a fallback
    // to it would quietly restore the memory cost while all the tests above
    // still passed.
    const src = recorder();
    await loadEdition(src, "2026-2027");
    expect(touched(src, "search-index.json")).toEqual([]);
  });

  it("does not read the search postings until something is searched", async () => {
    // 7.8 MB of heap that means nothing until a student types.
    const src = recorder();
    const ed = await loadEdition(src, "2026-2027");
    expect(touched(src, "search-postings"), "postings were read at load").toEqual([]);
    await ed.ensureSearchRanking();
    expect(touched(src, "search-postings").length).toBe(1);
  });

  it("loads the postings once however often ranking is asked for", async () => {
    const src = recorder();
    const ed = await loadEdition(src, "2026-2027");
    await ed.ensureSearchRanking();
    await ed.ensureSearchRanking();
    await ed.ensureSearchRanking();
    expect(touched(src, "search-postings").length).toBe(1);
  });

  it("reads a subject file only when a Course from it is wanted", async () => {
    const src = recorder();
    const ed = await loadEdition(src, "2026-2027");
    await ed.ensureCourses(["MATH 141"]);
    expect(touched(src, "courses/math.json").length).toBe(1);
  });

  it("upgrades a Course from a slim row to one with prerequisites", async () => {
    // THE DIFFERENCE THAT MATTERS. The audit index carries no prerequisite
    // structure, and `astComplete: false` is how a Course says so. Checking
    // a prerequisite against a Course in that state has to report "could
    // not be checked", never "satisfied" (iron rule 2) -- so the upgrade
    // is what makes real prerequisite answers possible.
    const src = recorder();
    const ed = await loadEdition(src, "2026-2027");
    expect(ed.catalog["MATH 141"]?.astComplete, "a slim row claimed complete prerequisites").toBe(false);
    await ed.ensureCourses(["MATH 141"]);
    expect(ed.catalog["MATH 141"]?.astComplete).toBe(true);
    expect(ed.catalog["MATH 141"]?.title).toBeTruthy();
  });

  it("reads each subject once however many of its Courses are asked for", async () => {
    const src = recorder();
    const ed = await loadEdition(src, "2026-2027");
    await ed.ensureCourses(["MATH 140", "MATH 141", "MATH 230"]);
    await ed.ensureCourses(["MATH 220"]);
    expect(touched(src, "courses/math.json").length).toBe(1);
  });

  it("follows one hop into the subjects a prerequisite names", async () => {
    // A Plan's own subjects are not enough: PHYS 212 requires MATH, and a
    // chart that loaded only PHYS would show the requirement as unmet
    // because it never read the Course that satisfies it.
    const src = recorder();
    const ed = await loadEdition(src, "2026-2027");
    await ed.ensureCourses(["PHYS 212"]);
    const subjects = touched(src, "courses/").length;
    expect(subjects, "only the asked-for subject was read; no hop happened").toBeGreaterThan(1);
  });

  it("degrades a missing subject to what the audit index knows", async () => {
    // Absent is not fatal. The Course still exists for listing and for
    // gen-ed matching; it simply has no prerequisite structure, which is
    // exactly what `astComplete: false` already means.
    const src = recorder();
    const ed = await loadEdition(src, "2026-2027");
    await expect(ed.ensureCourses(["ZZZZ 999"])).resolves.not.toThrow();
  });

  it("refuses to start when the audit index is missing, rather than answering wrongly", async () => {
    // The worst available outcome is a server that starts cleanly and then
    // says "MATH 141 is not in the 2026-2027 catalog" for every Course.
    // That is a confident wrong answer, which this package exists to refuse.
    const empty: CatalogSource = { read: async () => null, editions: async () => ["2026-2027"] };
    await expect(loadEdition(empty, "2026-2027")).rejects.toThrow(/course index|sync-catalog/i);
  });

  it("reads only the Edition it was asked for", async () => {
    // ADR 0001. A Plan is governed by the bulletin in force when the
    // student entered their major; touching another Edition's files is the
    // beginning of answering a question they did not ask.
    const src = recorder();
    await loadEdition(src, "2025-2026");
    expect(src.reads.filter((p) => p.startsWith("2026-2027"))).toEqual([]);
  });
});

describe("locating a subject's file", () => {
  /** THE BUG THIS EXISTS FOR. The first version built
   * `courses/${SUBJECT}.json` from the Course code. The shipped files are
   * lower-cased (`courses/math.json`) and some are slugged rather than
   * lower-cased (`AI` -> `a-i.json`), so it resolved NOTHING on a
   * case-sensitive filesystem and nothing ever for those subjects.
   *
   * It passed every test, because the machine it was written on has a
   * case-insensitive filesystem. CI is Linux and the fetch source this
   * seam exists for is case-sensitive by definition, so the tests have to
   * compare against real filenames rather than against whether a read
   * happened to succeed. */
  const shipped = () => {
    // RECURSIVE. Graduate files live in `courses/grad/`, and a flat listing
    // reported all 94 of them as missing -- the test being wrong in the
    // same direction as the bug it was written to catch.
    const out = new Set<string>();
    const walk = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
        else if (e.name.endsWith(".json")) out.add(`${prefix}${e.name}`);
      }
    };
    walk(path.join(CATALOG, "2026-2027", "courses"), "courses/");
    return out;
  };

  it("asks for paths that exist exactly as spelled", async () => {
    const index = JSON.parse(
      fs.readFileSync(path.join(CATALOG, "2026-2027", "subjects_index.json"), "utf-8"),
    ) as Record<string, string>;
    const onDisk = shipped();
    const wrong = Object.entries(index).filter(([, file]) => !onDisk.has(file));
    expect(wrong.slice(0, 5), `${wrong.length} subjects point at a file that is not there`).toEqual([]);
  });

  it("finds a subject whose filename is slugged, not merely lower-cased", async () => {
    // AI ships as `courses/a-i.json`. Lower-casing the code gives
    // `ai.json`, which does not exist -- so this is the case that fails
    // even on a case-insensitive filesystem.
    const src = recorder();
    const ed = await loadEdition(src, "2026-2027");
    const before = ed.catalog["AI 100"];
    expect(before, "AI 100 is not in the audit index; pick another slugged subject").toBeTruthy();
    await ed.ensureCourses(["AI 100"]);
    expect(ed.catalog["AI 100"]?.astComplete, "the slugged subject file was never found").toBe(true);
  });

  it("refuses to start without the subject index rather than silently finding nothing", async () => {
    // Without it every lookup misses, every Course stays a slim row, and
    // the server answers about prerequisites it never read.
    const partial: CatalogSource = {
      async read<T>(p: string): Promise<T | null> {
        if (p.endsWith("audit-index.json")) return { courses: [{ code: "MATH 140" }] } as T;
        if (p.endsWith("program-requirements.json")) return { x: {} } as T;
        return null;
      },
      async editions() { return ["2026-2027"]; },
    };
    await expect(loadEdition(partial, "2026-2027")).rejects.toThrow(/subject index/i);
  });
});
