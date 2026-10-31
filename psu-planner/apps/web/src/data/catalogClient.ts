/** Loads pipeline-produced static catalog files (served from /catalog in dev,
 * CDN in prod) and assembles the runtime Catalog for the courses a plan needs. */
import { astCourses, buildCatalog, buildSearchRanking, hydrateAuditRow, NO_RANKING, type AuditRow, type SearchRanking, type Catalog, type Course, type FlowchartPatterns, type IugSpec } from "@psu-planner/engine";

const ROOT = "/catalog";

/** Which bulletin edition every fetch below reads from. A student's degree
 * requirements are governed by the edition in force when they entered their
 * major, so a Plan pins one and the app must serve that one rather than the
 * newest (docs/adr/0001-forward-only-catalog-editions.md). */
let edition: string | null = null;
let editionsPromise: Promise<EditionsIndex> | null = null;

/** Bumped on every edition switch.
 *
 * Clearing the caches is not enough on its own: a request issued under the
 * previous edition can still be in flight, and its `await` resumes AFTER the
 * switch has emptied them -- writing the old bulletin's data back into a
 * cache that was just cleared. Every loader below captures this before it
 * fetches and declines to store a result that arrived too late. */
let generation = 0;

export interface EditionsIndex {
  editions: string[];
  latest: string;
}

export async function loadEditions(): Promise<EditionsIndex> {
  if (!editionsPromise) {
    editionsPromise = fetch(`${ROOT}/editions.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`editions.json missing (${r.status})`);
        return r.json() as Promise<EditionsIndex>;
      })
      // Drop the memo on failure, as the audit index does. Keeping a rejected
      // promise cached makes one flaky fetch permanent for the session: every
      // later call to base() rejects too, so every catalog read fails and
      // even "Start over" cannot recover.
      .catch((e) => {
        editionsPromise = null;
        throw e;
      });
  }
  return editionsPromise;
}

/** Switch editions. Every cache below is edition-scoped, so all of them are
 * dropped: serving one edition's course list under another's requirements is
 * exactly the silent wrongness the multi-edition work exists to prevent. */
export function setCatalogEdition(next: string): void {
  if (edition === next) return;
  edition = next;
  generation++;
  subjectsIndex = null;
  loadedSubjects.clear();
  coverageCache = null;
  patternsCache = undefined;
  iugIndexCache = null;
  programsIndexCache = null;
  apCache = null;
  auditIndexPromise = null;
  postingsPromise = null;
  // The ranking's term ids index a SPECIFIC Edition's dictionary, so it
  // goes with the memo. Scoring stops rather than scoring wrongly: code
  // and title still rank (ADR 0001).
  ranking = NO_RANKING;
}

export function currentEdition(): string | null {
  return edition;
}

async function base(): Promise<string> {
  if (!edition) edition = (await loadEditions()).latest;
  return `${ROOT}/${edition}`;
}

export interface ProgramIndexEntry {
  slug: string;
  name: string;
  type: "major" | "minor" | "certificate";
  campuses: string[];
  college: string | null;
  hasPlans: boolean;
}

export interface SubjectsIndex {
  /** prefix (e.g. "CMPSC") -> file path relative to catalog root */
  [prefix: string]: string;
}

let subjectsIndex: SubjectsIndex | null = null;
const loadedSubjects = new Map<string, Course[]>();

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${await base()}/${path}`);
  if (!res.ok) throw new Error(`catalog fetch failed: ${path} (${res.status})`);
  return res.json();
}

/** Fetch, but only let the result be cached if the edition has not changed
 * underneath us. `store` runs solely for a response that is still current. */
async function getFresh<T>(path: string, store: (v: T) => void): Promise<T> {
  const at = generation;
  const value = await getJson<T>(path);
  if (at === generation) store(value);
  return value;
}

/** AP exam credit, per Edition.
 *
 * Previously fetched straight from `/catalog/ap_credits.json` in the picker
 * component, which was wrong three ways: the path has no edition segment, so
 * it 404ed; the dev/preview server answers a miss with the SPA shell at status
 * 200, so the `res.ok` guard passed and `res.json()` threw "Unexpected token
 * '<'" as an unhandled rejection; and the module-level cache was never cleared
 * when the student changed edition, so one bulletin's awards could outlive it.
 * Awards do change between bulletins. */
export interface ApExam {
  exam: string;
  // `credits` is NULLABLE: 24 award rows in the shipped 2026-2027 table carry
  // no credit figure (the award is a placement, not credit). Moving this type
  // out of the picker narrowed it to `number`, which made a guard for exactly
  // that case read as unreachable.
  awards: { minScore: number; credits: number | null; courses: string[]; raw: string }[];
  notes: string[];
}
let apCache: ApExam[] | null = null;
export async function loadApCredits(): Promise<ApExam[]> {
  if (apCache) return apCache;
  try {
    const at = generation;
    const exams = (await getJson<{ exams: ApExam[] }>("ap_credits.json")).exams ?? [];
    if (at !== generation) return exams; // a later edition is current now
    apCache = exams;
  } catch {
    // AP credit is an optional convenience; onboarding still works without it.
    apCache = [];
  }
  return apCache;
}

let programsIndexCache: ProgramIndexEntry[] | null = null;
export async function loadProgramsIndex(): Promise<ProgramIndexEntry[]> {
  if (!programsIndexCache) {
    return getFresh<ProgramIndexEntry[]>("programs_index.json", (v) => { programsIndexCache = v; });
  }
  return programsIndexCache;
}

export async function loadSubjectsIndex(): Promise<SubjectsIndex> {
  if (!subjectsIndex) {
    return getFresh<SubjectsIndex>("subjects_index.json", (v) => { subjectsIndex = v; });
  }
  return subjectsIndex;
}

export async function loadProgram<T>(type: "majors" | "minors" | "certificates", slug: string): Promise<T> {
  return getJson(`programs/${type}/${slug}.json`);
}

const TYPE_DIR = { major: "majors", minor: "minors", certificate: "certificates" } as const;

let coverageCache: Record<string, string[]> | null = null;
/** Directional coverage (MATH 250 -> [MATH 251]) mined from bulletin descriptions. */
export async function loadCoverage(): Promise<Record<string, string[]>> {
  if (coverageCache) return coverageCache;
  try {
    const raw = await getJson<{ coveredBy: Record<string, { by: string }[]> }>("coverage.json");
    coverageCache = Object.fromEntries(Object.entries(raw.coveredBy).map(([k, v]) => [k, v.map((x) => x.by)]));
  } catch {
    coverageCache = {};
  }
  return coverageCache;
}

let patternsCache: FlowchartPatterns | null | undefined;
/** Aggregate scheduling priors mined from the engineering flowcharts. Absent
 * (older catalog / not yet mined) → the engine's built-in defaults apply. */
export async function loadFlowchartPatterns(): Promise<FlowchartPatterns | undefined> {
  if (patternsCache !== undefined) return patternsCache ?? undefined;
  try {
    patternsCache = await getJson<FlowchartPatterns>("flowchart-patterns.json");
  } catch {
    patternsCache = null; // remember the miss; engine falls back to defaults
  }
  return patternsCache ?? undefined;
}

export interface IugIndexEntry {
  slug: string;
  name: string;
  gradDegree: string;
  college: string;
  campus: string;
  pairsWith: string[];
}
let iugIndexCache: IugIndexEntry[] | null = null;
/** IUG programs available (data/out/<edition>/iug/index.json). Empty if the
 * scrape hasn't produced any. */
export async function loadIugIndex(): Promise<IugIndexEntry[]> {
  if (iugIndexCache) return iugIndexCache;
  try { iugIndexCache = await getJson<IugIndexEntry[]>("iug/index.json"); }
  catch { iugIndexCache = []; }
  return iugIndexCache;
}
export async function loadIug(slug: string): Promise<IugSpec | null> {
  try { return await getJson<IugSpec>(`iug/${slug}.json`); }
  catch { return null; }
}

/** Load a program knowing only its slug (directory resolved via the index). */
export async function loadProgramBySlug<T>(slug: string): Promise<T | null> {
  const index = await loadProgramsIndex();
  const entry = index.find((p) => p.slug === slug);
  if (!entry) return null;
  try {
    return await loadProgram<T>(TYPE_DIR[entry.type], slug);
  } catch {
    return null;
  }
}

export async function loadSubject(prefix: string): Promise<Course[]> {
  const cached = loadedSubjects.get(prefix);
  if (cached) return cached;
  const idx = await loadSubjectsIndex();
  // Load the undergrad file AND the grad file (prefix:grad) when present — an
  // IUG plan mixes 400-level undergrad with 500/800-level graduate courses in
  // the same subject (ACCTG, BA, ESC...). Undergrad wins code collisions.
  const files = [idx[prefix], idx[`${prefix}:grad`]].filter(Boolean) as string[];
  if (!files.length) return [];
  const seen = new Set<string>();
  const courses: Course[] = [];
  for (const file of files) {
    for (const c of await getJson<Course[]>(file)) {
      if (seen.has(c.code)) continue;
      seen.add(c.code);
      courses.push(c);
    }
  }
  loadedSubjects.set(prefix, courses);
  return courses;
}

/** One course, with its FULL description, from its subject file.
 *
 * The search index carries a shortened description -- enough to find a course,
 * not enough to read about one. Anything that shows a student prose about a
 * single course must come through here, or it will quietly render the
 * search text instead. */
export async function loadCourse(code: string): Promise<Course | null> {
  const prefix = code.split(" ")[0];
  if (!prefix) return null;
  return (await loadSubject(prefix)).find((c) => c.code === code) ?? null;
}

/** Load every subject referenced by the given codes, plus one hop of prereq
 * subjects so edges and status checks resolve. */
export async function loadCatalogFor(codes: string[]): Promise<Catalog> {
  const prefixes = new Set<string>();
  for (const code of codes) {
    const p = code.split(" ")[0];
    if (p) prefixes.add(p);
  }
  let courses: Course[] = [];
  for (const p of prefixes) courses = courses.concat(await loadSubject(p));

  // One hop: prereq codes may reference subjects not in the plan.
  const hop = new Set<string>();
  for (const c of courses) {
    for (const ast of [c.prereqAst, c.concurrentAst]) {
      if (!ast) continue;
      for (const code of astCourses(ast)) {
        const p = code.split(" ")[0];
        if (p && !prefixes.has(p)) hop.add(p);
      }
    }
  }
  for (const p of hop) courses = courses.concat(await loadSubject(p));
  return buildCatalog(courses);
}

/* ── The audit index (#27) ───────────────────────────────────────────────
   What the degree audit needs about every course, and nothing else.

   The audit has to see the whole catalog, because an elective or a General
   Education requirement can be satisfied by almost anything — narrowing it
   to the subjects a plan already touches would quietly hide real options.
   But it reads five things off a course: the code, the credits, the subject
   and number a pattern rule matches on, and the gen-ed designations. So it
   gets a file carrying five things: 210 KB gzipped against the 2,419 KB it
   used to pull (#24).

   SUBJECT AND NUMBER ARE DERIVED, not stored. Verified across all 14,615
   courses in both editions: `subject` is exactly the code before the space
   and `number` exactly the part after, with zero exceptions. A pipeline test
   asserts that invariant at build time, so if the Bulletin ever produces a
   code where it does not hold, the build says so rather than the audit
   quietly mis-matching pattern rules. */
/* `AuditRow` and `hydrateAuditRow` now live in the engine. Both this client
   and the MCP server read this index, and a second hydration is a second
   set of answers about what a Course is -- the `level` bug is the argument
   for that: it was hardcoded once and 5,126 graduate Courses were offered
   to undergraduates until a test caught it. */

let auditIndexPromise: Promise<Catalog> | null = null;

/** Every course, as much as an audit needs of it.
 *
 * Memoised per edition: `setCatalogEdition` drops this with the rest, because
 * auditing one edition's plan against another's course list is the silent
 * wrongness ADR 0001 exists to prevent — Editions are forward-only and pinned
 * per plan, so a stale index here is a correctness bug and not a cache miss.
 *
 * A failed fetch REJECTS rather than returning an empty catalog. An empty one
 * would read as "no course in the catalog satisfies this requirement", which
 * is a confident wrong answer; the caller shows that the audit could not be
 * run instead. */
export async function loadAuditIndex(): Promise<Catalog> {
  if (auditIndexPromise) return auditIndexPromise;
  auditIndexPromise = (async () => {
    const raw = await getJson<{ courses: AuditRow[] }>("audit-index.json");
    const rows = Array.isArray(raw?.courses) ? raw.courses : [];
    if (!rows.length) throw new Error("audit-index.json is empty");
    return buildCatalog(rows.map(hydrateAuditRow));
  })();
  try {
    return await auditIndexPromise;
  } catch (e) {
    auditIndexPromise = null; // let a later attempt retry a transient failure
    throw e;
  }
}

let postingsPromise: Promise<void> | null = null;

/** The body signal for the Edition currently being shown.
 *
 * ONE at a time, which is all a browser ever needs — the planner shows a
 * single bulletin and clears this on switch. It is a value rather than
 * engine module state because the hosted connector serves many Editions
 * from one isolate and could not share a global; keeping the engine free
 * of that global is what makes both possible. */
let ranking: SearchRanking = NO_RANKING;

/** The ranking for whatever Edition is loaded, for callers that search. */
export function searchRanking(): SearchRanking {
  return ranking;
}

/** The body signal for ranking, fetched the first time anyone searches (#28).
 *
 * 1,263 KB gzipped of posting lists that mean nothing until a student types.
 * They used to ride along with the course records, so opening a plan paid for
 * the ranking data of 14,615 courses in order to look at a chart.
 *
 * Failure is NOT fatal and deliberately so: without postings, `searchCatalog`
 * still ranks on code and title, which finds "CMPSC 465" perfectly well and
 * only degrades matching on description topics. A student who gets slightly
 * worse ordering is better served than one who gets an error page. */
async function ensureSearchPostings(): Promise<void> {
  if (postingsPromise) return postingsPromise;
  postingsPromise = (async () => {
    const at = generation;
    const raw = await getJson<{ terms: string[]; postings: Record<string, number[]> }>("search-postings.json");
    // An edition switch while this was in flight: the term ids in this file
    // index THIS edition's dictionary, and loading them under another
    // bulletin's would score against the wrong vocabulary (ADR 0001).
    if (at !== generation) return;
    ranking = buildSearchRanking(raw.terms ?? [], raw.postings ?? {});
  })().catch((e) => {
    console.warn("[search] ranking data unavailable; falling back to code and title", e);
    postingsPromise = null;
  });
  return postingsPromise;
}

/** A catalog good enough to search, and the ranking data to search it with.
 *
 * The audit index is already in memory for most students — the Requirements
 * panel loads it on every boot — so the marginal cost of a first search is
 * the postings alone. */
export async function loadSearchCatalog(): Promise<Catalog> {
  const [catalog] = await Promise.all([loadAuditIndex(), ensureSearchPostings()]);
  return catalog;
}

/* `loadFullCatalog` lived here. It is gone with `search-index.json` (#29):
   the audit reads the audit index, search adds the postings, and course
   detail reads the subject file. Nothing was left that wanted all twenty-two
   fields for all 14,615 courses at once. */
