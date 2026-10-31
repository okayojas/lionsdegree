/** Loading the catalog for one Edition.
 *
 * Only ONE Edition is ever loaded: the one the student's Plan is pinned to.
 * Their requirements come from the bulletin in force when they entered
 * their major, so reading any other would answer a question they did not
 * ask (ADR 0001).
 *
 * WHAT CHANGED IN #31, and why it is not a tidying exercise. This used to
 * read `search-index.json` — every field of every Course plus the search
 * postings, in one 11 MB file — and hold the result for the life of the
 * process. MEASURED: 64 MB of heap and 138 MB of RSS. A Cloudflare isolate
 * has 128 MB, so the hosted connector was not merely slow on that path, it
 * was impossible.
 *
 * It now reads what it needs when it needs it:
 *
 *   audit-index.json      always. Every Course in the catalog, slim: code,
 *                         title, credits, gen-eds, level. 3.9 MB of heap
 *                         for all 14,615. The audit must see everything,
 *                         because an elective or a General Education
 *                         requirement can be satisfied by almost anything.
 *   courses/<SUBJ>.json   on demand. Prerequisite structure, keywords and
 *                         the bulletin URL for one subject at a time.
 *   search-postings.json  on first search. 7.8 MB of ranking data that
 *                         means nothing until somebody types.
 *
 * Always-resident is 7.8 MB with the programs, against 64 MB before.
 *
 * Where the bytes come from is a `CatalogSource`, so the hosted connector
 * supplies fetch and this file does not change. One catalog, two ways of
 * reaching it — a second loader would be a second set of answers about
 * what a Course requires.
 */
import {
  astCourses,
  buildCatalog,
  hydrateAuditRow,
  isAuditIndex,
  loadSearchPostings,
  type AuditIndexFile,
  type Catalog,
  type Course,
  type ProgramRequirements,
} from "@psu-planner/engine";
import type { CatalogSource } from "./source.js";

// Re-exported, not redefined. It moved to the engine when discovery needed
// it too, and two declarations of one catalog file's shape drift.
export type { ProgramRequirements };

export interface ProgramIndexEntry {
  slug: string;
  name: string;
  type: string;
  campuses: string[];
  college: string | null;
}

export interface EditionCatalog {
  edition: string;
  /** Every Course in the Edition.
   *
   * Entries start as audit rows — `astComplete: false`, no prerequisite
   * structure — and are REPLACED in place by full Courses as their subject
   * files load. Callers hold this object across those upgrades, which is
   * why it is mutated rather than rebuilt. */
  catalog: Catalog;
  programs: Record<string, ProgramRequirements>;
  programsIndex: ProgramIndexEntry[];
  coveredBy: Record<string, string[]>;

  /** Make sure these Courses carry real prerequisite structure.
   *
   * Loads each code's subject file, then follows ONE hop into the subjects
   * those prerequisites name — a Plan's own subjects are not enough, since
   * PHYS 212 requires MATH and a catalog that read only PHYS would report
   * the requirement unmet because it never read what satisfies it.
   *
   * Idempotent and cheap to over-call: a subject already loaded is not
   * read twice. */
  ensureCourses(codes: readonly string[]): Promise<void>;

  /** Load the ranking data that search scores descriptions with.
   *
   * Separate because it is 7.8 MB that does nothing until a query arrives,
   * and most sessions never search. */
  ensureSearchRanking(): Promise<void>;
}

/** The subject a Course code belongs to. Derived, never stored — a pipeline
 * test asserts the split holds for all 14,615 Courses. */
function subjectOf(code: string): string {
  const space = code.indexOf(" ");
  return (space > 0 ? code.slice(0, space) : code).trim().toUpperCase();
}

/** Graduate Courses live in their own directory. A subject can appear in
 * either or both, so both are tried and the results merged. */
const subjectPaths = (edition: string, subject: string) => [
  `${edition}/courses/${subject}.json`,
  `${edition}/courses/grad/${subject}.json`,
];

export async function loadEdition(source: CatalogSource, edition: string): Promise<EditionCatalog> {
  const index = await source.read<AuditIndexFile>(`${edition}/audit-index.json`);
  if (!isAuditIndex(index)) {
    // Falling back to an empty catalog produced the worst available
    // outcome: the server started cleanly and then answered "MATH 141 is
    // not in the 2026-2027 catalog" for every Course an assistant asked
    // about. That is a confident wrong answer, which this package exists to
    // refuse (iron rule 2). Refusing to start names the real problem.
    //
    // MISSING and PRESENT-BUT-EMPTY are worded differently on purpose: one
    // means the file never arrived, the other that the pipeline produced
    // nothing for this Edition, and they send you to different places.
    const have = (await source.editions()).join(", ") || "none";
    const why = index === null
      ? `could not be read. This catalog has: ${have}.`
      : `is empty — the pipeline produced no courses for this edition.`;
    throw new Error(
      `The ${edition} course index ${why} ` +
        `Re-run \`node scripts/sync-catalog.mjs\` to rebuild this server's catalog.`,
    );
  }

  const catalog: Catalog = buildCatalog(index.courses.map(hydrateAuditRow));

  const programs = await source.read<Record<string, ProgramRequirements>>(`${edition}/program-requirements.json`);
  if (!programs || typeof programs !== "object" || !Object.keys(programs).length) {
    throw new Error(
      `The ${edition} program requirements could not be read. ` +
        `Re-run \`node scripts/sync-catalog.mjs\` to rebuild this server's catalog.`,
    );
  }

  // Both of these the server can do without: no coverage means no
  // substitute matching, no index means no program listing. Courses still
  // answer, so a miss degrades the feature rather than the server.
  const coverage = (await source.read<{ coveredBy?: Record<string, { by: string }[]> }>(`${edition}/coverage.json`)) ?? {};
  const programsIndex = (await source.read<ProgramIndexEntry[]>(`${edition}/programs_index.json`)) ?? [];

  const loadedSubjects = new Set<string>();
  let rankingLoaded: Promise<void> | null = null;

  /** Read one subject's files and fold them into the catalog. Returns the
   * Courses added, so the caller can look at their prerequisites. */
  async function loadSubject(subject: string): Promise<Course[]> {
    if (loadedSubjects.has(subject)) return [];
    loadedSubjects.add(subject);
    const found: Course[] = [];
    for (const p of subjectPaths(edition, subject)) {
      const rows = await source.read<Course[]>(p);
      if (Array.isArray(rows)) found.push(...rows);
    }
    // A full Course REPLACES its audit row. Callers hold `catalog` across
    // this, so it is mutated rather than rebuilt.
    for (const [key, course] of Object.entries(buildCatalog(found))) catalog[key] = course;
    return found;
  }

  return {
    edition,
    catalog,
    programs,
    programsIndex,
    coveredBy: Object.fromEntries(
      Object.entries(coverage.coveredBy ?? {}).map(([k, v]) => [k, v.map((x) => x.by)]),
    ),

    async ensureCourses(codes) {
      const wanted = new Set<string>();
      for (const c of codes) {
        const s = subjectOf(c);
        if (s && !loadedSubjects.has(s)) wanted.add(s);
      }
      if (!wanted.size) return;

      const added: Course[] = [];
      for (const s of wanted) added.push(...(await loadSubject(s)));

      // One hop. Not two: the chain can run arbitrarily deep and following
      // it to the end would load most of the catalog one file at a time,
      // which is the cost this whole change removes. One hop is what makes
      // the Courses actually IN the Plan resolvable, which is the question
      // being asked.
      const hop = new Set<string>();
      for (const c of added) {
        for (const ast of [c.prereqAst, c.concurrentAst]) {
          if (!ast) continue;
          for (const code of astCourses(ast)) {
            const s = subjectOf(code);
            if (s && !loadedSubjects.has(s)) hop.add(s);
          }
        }
      }
      for (const s of hop) await loadSubject(s);
    },

    async ensureSearchRanking() {
      // Memoised on the PROMISE, not on a flag: two searches arriving
      // together would otherwise both see "not loaded" and fetch 7.8 MB
      // twice.
      rankingLoaded ??= (async () => {
        const file = await source.read<{ terms: string[]; postings: Record<string, number[]> }>(
          `${edition}/search-postings.json`,
        );
        // No postings is not an error: search still ranks on code and
        // title, which is honest degradation rather than a broken tool.
        if (file?.terms && file.postings) loadSearchPostings(file.terms, file.postings);
      })();
      await rankingLoaded;
    },
  };
}
