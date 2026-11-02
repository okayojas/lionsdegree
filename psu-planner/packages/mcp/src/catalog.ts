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
  buildSearchRanking,
  NO_RANKING,
  subjectOf,
  type AuditIndexFile,
  type Catalog,
  type IugSpec,
  type SearchRanking,
  type Course,
  type ProgramRequirements,
  type ProgramTemplate,
  type TemplateSemester,
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

/** One row of `iug/index.json`: enough to list an Integrated
 * Undergraduate-Graduate program and say which bachelor's it pairs with,
 * without reading the program itself.
 *
 * A subset of `IugSpec` rather than the whole thing, because the whole
 * thing is the graduate requirement tree and a student choosing between
 * three programs does not need three requirement trees. */
export interface IugIndexEntry {
  slug: string;
  name: string;
  gradDegree: string;
  college: string;
  campus: string;
  /** Slugs of the bachelor's Programs this IUG is published against. */
  pairsWith: string[];
}

export interface EditionCatalog {
  edition: string;
  /** Every Edition this catalog can serve, oldest first.
   *
   * Carried here because a REFUSAL needs it and the tools have a catalog
   * in hand but no source. A Program or a Plan absent from this Edition
   * is routinely present in another (ADR 0001), so "we do not have that"
   * without "here is what we do have" reads as "that does not exist" —
   * which for a forward-only catalog is the wrong story entirely. */
  editions: string[];
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

  /** The same, for whole subjects rather than individual Courses.
   *
   * Exists because the caller that wants this — ranking a requirement's
   * candidate Courses — genuinely has subjects, and the first version
   * smuggled them through `ensureCourses` as synthetic codes like
   * `"MATH 0"`. A fake Course code is a lie the next reader has to decode. */
  ensureSubjects(subjects: readonly string[]): Promise<void>;

  /** The Integrated Undergraduate-Graduate programs this Edition
   * publishes, or an empty list if it publishes none.
   *
   * EMPTY IS A REAL ANSWER HERE, and a failed read is not. Editions
   * accumulate forward (ADR 0001) and the IUG scrape is newer than the
   * oldest of them, so "this Edition has none" is a fact a student can
   * be told. "We could not read the file" is not the same fact, and
   * answering it as `[]` would tell a student Penn State offers no
   * integrated degree — a confident wrong answer (iron rule 2). The
   * distinction is kept by not memoising a miss. */
  iugPrograms(): Promise<IugIndexEntry[]>;

  /** One IUG program in full, or null if this Edition does not publish
   * it under that slug. */
  iug(slug: string): Promise<IugSpec | null>;

  /** A Program as the engine's merge wants it: requirements plus the
   * suggested-plan grid (#47).
   *
   * ASSEMBLED FROM TWO FILES, which is why it is a method rather than a
   * field. The requirements are in the always-resident
   * `program-requirements.json`; the grid is one 7 KB file per Program,
   * read on demand, because a session that never declares a Program
   * should not pay for 1.6 MB of them.
   *
   * `null` only when this Edition does not publish the Program at all. A
   * Program that publishes requirements and NO grid -- most minors and
   * certificates -- returns a Template with no semesters, exactly as the
   * planner's own `templateFor` does: contributing requirements and
   * placing no courses is what those Programs actually do, not a failure
   * to read them. */
  programTemplate(slug: string): Promise<ProgramTemplate | null>;

  /** Load the ranking data that search scores descriptions with.
   *
   * Separate because it is tens of megabytes of heap that does nothing
   * until a query arrives, and most sessions never search. */
  ensureSearchRanking(): Promise<void>;

  /** The body signal for THIS Edition.
   *
   * Held here rather than in engine module state, which is what it used
   * to be. One isolate serves many students and the second Edition to
   * load replaced the first's dictionary globally — Edition A then
   * scored against Edition B's vocabulary, permanently, because the
   * loader's memo recorded the work as done. Term ids index a specific
   * dictionary; a stale one across an Edition change is a correctness
   * bug (ADR 0001). */
  readonly ranking: SearchRanking;
}

/** Where a subject's files live, from the catalog's own index.
 *
 * NOT GUESSED. The first version of this built `courses/${SUBJECT}.json`
 * and was wrong twice over: the shipped files are lower-case
 * (`courses/math.json`), and some subjects are slugged rather than
 * lower-cased (`AI` -> `courses/a-i.json`, `CS` -> `c-s.json`). It
 * resolved nothing at all on a case-sensitive filesystem and nothing ever
 * for those 41 subjects — but it passed every test on a case-insensitive
 * one, which is the only reason it got this far.
 *
 * `subjects_index.json` is the mapping the web client already reads, so
 * using it is also what stops the two readers developing separate ideas
 * about where a Course lives.
 *
 * A subject can have an undergraduate file, a graduate one, or both — an
 * IUG Plan mixes 400-level with 500/800-level in the same subject — so
 * both keys are tried and the results merged. */
type SubjectsIndex = Record<string, string>;

function subjectPaths(edition: string, subject: string, index: SubjectsIndex): string[] {
  return [index[subject], index[`${subject}:grad`]]
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    .map((f) => `${edition}/${f}`);
}

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

  // This one the server CANNOT do without, and its absence is silent: with
  // no index, every subject lookup misses, every Course stays a slim audit
  // row, and the server answers questions about prerequisites it never
  // read. Loud at startup beats wrong at every query (iron rule 2).
  const subjectsRaw = await source.read<SubjectsIndex>(`${edition}/subjects_index.json`);
  if (!subjectsRaw || !Object.keys(subjectsRaw).length) {
    throw new Error(
      `The ${edition} subject index is missing, so no course file could ever be located. ` +
        `Re-run \`node scripts/sync-catalog.mjs\` to rebuild this server's catalog.`,
    );
  }

  const subjects: SubjectsIndex = subjectsRaw;
  const loadedSubjects = new Map<string, Promise<Course[]>>();
  let rankingLoaded: Promise<void> | null = null;
  let ranking: SearchRanking = NO_RANKING;
  // Both memoised on the PROMISE for the same reason `loadSubject` is:
  // two tool calls arriving together would otherwise each fetch the
  // file. Neither is read at startup — an isolate that is never asked
  // about an IUG pays nothing for one (measured: 927 bytes for the
  // index, 0.3 MB for all three programs and every graduate subject
  // they name, see scripts/measure-memory.mts).
  let iugIndexLoaded: Promise<IugIndexEntry[]> | null = null;
  const loadedIug = new Map<string, Promise<IugSpec | null>>();
  /** The same, for suggested-plan grids (#47). One file per Program, read
   * only when a student declares one: 1.6 MB of grids per Edition that a
   * session which never declares a Program never touches. */
  const loadedGrid = new Map<string, Promise<{ campusLabel?: string; semesters?: TemplateSemester[] } | null>>();

  /** The Edition's IUG index, read once. A local function rather than a
   * method so `iug` below can call it without going through `this` --
   * the returned object gets destructured by callers, and a `this`
   * reference would be undefined by the time it mattered. */
  async function iugPrograms(): Promise<IugIndexEntry[]> {
    // HELD IN A LOCAL. The body below clears `iugIndexLoaded` on a miss,
    // and that happens BEFORE this function returns -- so returning the
    // variable handed the caller `null` instead of the list on the very
    // first successful-then-cleared interleaving. The `??=` expression
    // yields the promise, which is the thing to await.
    const inFlight = (iugIndexLoaded ??= (async () => {
      const rows = await source.read<IugIndexEntry[]>(`${edition}/iug/index.json`);
      if (!Array.isArray(rows)) {
        // NOT REMEMBERED. A source returns null for absent, broken and
        // unreachable alike, so this branch covers an Edition that
        // genuinely ships no IUG data AND a transient failure. Keeping
        // either as "there are none" would make one bad fetch tell every
        // later student in this isolate that Penn State offers no
        // integrated degree. Dropping the memo means the next question
        // retries instead of being served the same silence.
        iugIndexLoaded = null;
        return [];
      }
      return rows;
    })());
    return inFlight;
  }

  /** Read one subject's files and fold them into the catalog. Returns the
   * Courses added, so the caller can look at their prerequisites. */
  async function loadSubject(subject: string): Promise<Course[]> {
    // Not in the index at all: this Edition does not publish the subject.
    // Genuinely absent rather than unreadable, so it is remembered.
    if (!subjects[subject] && !subjects[`${subject}:grad`]) {
      loadedSubjects.set(subject, Promise.resolve([]));
      return [];
    }

    // MEMOISED ON THE PROMISE, not on a flag. The first version marked a
    // subject loaded BEFORE awaiting its bytes, so a second caller
    // arriving during the read saw "already done" and went on to evaluate
    // against audit rows that had not been replaced yet — answering about
    // prerequisites that were still in flight. Handing back the same
    // promise makes the second caller wait for the first one's bytes.
    // `ensureSearchRanking` already did this; this did not.
    const inFlight = loadedSubjects.get(subject);
    if (inFlight) return inFlight;

    const work = (async () => {
      const paths = subjectPaths(edition, subject, subjects);
      const found: Course[] = [];
      let failed = false;
      for (const p of paths) {
        const rows = await source.read<Course[]>(p);
        if (Array.isArray(rows)) found.push(...rows);
        // The INDEX SAID THIS FILE EXISTS. A source returns null for
        // absent, broken and unreachable alike -- deliberately, since a
        // caller decides what a miss means -- so this is where the three
        // are told apart: a path the subjects index names and we could
        // not read is a FAILURE, not an empty subject.
        else failed = true;
      }

      if (failed) {
        // DO NOT REMEMBER A FAILURE AS AN ANSWER. Memoised, one transient
        // 500 made that isolate report `enforced_prerequisites: null` for
        // every Course in the subject, for its whole life -- "this has no
        // prerequisites" where "we could not read them" is the only
        // honest answer (iron rule 2). Dropping the memo means the next
        // question retries instead of being served the same silence.
        loadedSubjects.delete(subject);
        // Anything that DID arrive is still folded in; a subject with an
        // undergraduate file and a missing graduate one is better served
        // half-known than not at all, and the Courses that did not arrive
        // keep `astComplete: false`.
      }

      // A full Course REPLACES its audit row. Callers hold `catalog`
      // across this, so it is mutated rather than rebuilt.
      for (const [key, course] of Object.entries(buildCatalog(found))) catalog[key] = course;
      return found;
    })();

    loadedSubjects.set(subject, work);
    return work;
  }

  return {
    edition,
    // One extra read of a tiny index, once per Edition per isolate. The
    // alternative was threading a `CatalogSource` through every tool so
    // a refusal could name the Editions we hold, which would put a
    // loader on the context of code that only answers questions.
    editions: await source.editions(),
    catalog,
    programs,
    programsIndex,
    get ranking() {
      return ranking;
    },
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

    iugPrograms,

    async iug(slug) {
      // CHECKED AGAINST THE INDEX BEFORE IT BECOMES A PATH. The slug
      // arrives from a MODEL, and `assertInsideCatalog` would already
      // refuse a traversal -- but refusing is a thrown error where the
      // honest answer is "this Edition does not publish that program".
      // Resolving only slugs the Edition itself lists means a made-up
      // one is answered rather than raised, and the path builder below
      // never sees a string we did not publish.
      if (!(await iugPrograms()).some((p) => p.slug === slug)) return null;

      const inFlight = loadedIug.get(slug);
      if (inFlight) return inFlight;
      const work = (async () => {
        const spec = await source.read<IugSpec>(`${edition}/iug/${slug}.json`);
        // The index named it and we could not read it. Same rule as the
        // index itself: a miss is not an answer, so it is not kept.
        if (!spec) loadedIug.delete(slug);
        return spec;
      })();
      loadedIug.set(slug, work);
      return work;
    },

    async programTemplate(slug) {
      // THE REQUIREMENTS DECIDE WHETHER THIS EDITION HAS THE PROGRAM, not
      // the grid: 376 of the 759 Programs publish requirements and no
      // grid, so keying existence on the grid would tell a student their
      // Edition does not offer half the minors in it.
      const reqs = programs[slug];
      if (!reqs) return null;

      // The slug came from a MODEL. It is checked against the Edition's own
      // requirements above before it becomes a path, like `iug` -- so a
      // made-up slug is answered rather than raised, and the path builder
      // never sees a string we did not publish.
      const inFlight = loadedGrid.get(slug);
      const grid = await (inFlight ??
        (() => {
          const work = source
            .read<{ campusLabel?: string; semesters?: TemplateSemester[] }>(`${edition}/plans/${slug}.json`)
            .then((g) => {
              // A MISS IS NOT MEMOISED when it might be transient. An absent
              // grid for a minor is a permanent fact, and an unreadable one
              // for a major is not -- and nothing here can tell them apart,
              // so neither is kept. The cost of re-reading is one 7 KB file.
              if (!g) loadedGrid.delete(slug);
              return g;
            });
          loadedGrid.set(slug, work);
          return work;
        })());

      return {
        slug,
        name: reqs.name,
        campusLabel: grid?.campusLabel ?? "",
        // NO GRID IS AN EMPTY GRID, matching the planner's `templateFor`.
        // `addProgram` then derives placement from the requirement sections,
        // which is exactly what it does in the browser for a minor.
        semesters: grid?.semesters ?? [],
        requirements: reqs.requirementSections ?? [],
      };
    },

    async ensureSubjects(wanted) {
      for (const s of new Set(wanted.map((x) => x.trim().toUpperCase()).filter(Boolean))) {
        await loadSubject(s);
      }
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
        if (file?.terms && file.postings) ranking = buildSearchRanking(file.terms, file.postings);
      })();
      await rankingLoaded;
    },
  };
}
