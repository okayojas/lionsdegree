/** Loads pipeline-produced static catalog files (served from /catalog in dev,
 * CDN in prod) and assembles the runtime Catalog for the courses a plan needs. */
import { astCourses, buildCatalog, type Catalog, type Course, type FlowchartPatterns, type IugSpec } from "@psu-planner/engine";

const ROOT = "/catalog";

/** Which bulletin edition every fetch below reads from. A student's degree
 * requirements are governed by the edition in force when they entered their
 * major, so a Plan pins one and the app must serve that one rather than the
 * newest (docs/adr/0001-forward-only-catalog-editions.md). */
let edition: string | null = null;
let editionsPromise: Promise<EditionsIndex> | null = null;

export interface EditionsIndex {
  editions: string[];
  latest: string;
}

export async function loadEditions(): Promise<EditionsIndex> {
  if (!editionsPromise) {
    editionsPromise = fetch(`${ROOT}/editions.json`).then((r) => {
      if (!r.ok) throw new Error(`editions.json missing (${r.status})`);
      return r.json() as Promise<EditionsIndex>;
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
  subjectsIndex = null;
  loadedSubjects.clear();
  coverageCache = null;
  patternsCache = undefined;
  iugIndexCache = null;
  programsIndexCache = null;
  fullCatalogPromise = null;
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

let programsIndexCache: ProgramIndexEntry[] | null = null;
export async function loadProgramsIndex(): Promise<ProgramIndexEntry[]> {
  if (!programsIndexCache) programsIndexCache = await getJson<ProgramIndexEntry[]>("programs_index.json");
  return programsIndexCache;
}

export async function loadSubjectsIndex(): Promise<SubjectsIndex> {
  if (!subjectsIndex) subjectsIndex = await getJson<SubjectsIndex>("subjects_index.json");
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

/** Full catalog for search — loads all subjects lazily once, then caches. */
let fullCatalogPromise: Promise<Catalog> | null = null;
/** The entire course catalog (used by chat search / course-details tools).
 * MEMOIZED and PARALLEL-loaded: the AI often calls catalog tools several times
 * a turn, and loading ~500 subject files one-at-a-time per call was slow enough
 * to blow the chat's request timeout ("the AI stopped working"). A failed
 * subject fetch is skipped, not fatal — a partial catalog still answers most
 * questions. */
export async function loadFullCatalog(onProgress?: (loaded: number, total: number) => void): Promise<Catalog> {
  if (fullCatalogPromise) return fullCatalogPromise;
  fullCatalogPromise = (async () => {
    const idx = await loadSubjectsIndex();
    const prefixes = Object.keys(idx);
    let done = 0;
    const chunks = await Promise.all(
      prefixes.map((p) =>
        loadSubject(p)
          .catch(() => [] as Course[])
          .finally(() => onProgress?.(++done, prefixes.length)),
      ),
    );
    return buildCatalog(chunks.flat());
  })();
  try {
    return await fullCatalogPromise;
  } catch (e) {
    fullCatalogPromise = null; // let a later call retry after a transient failure
    throw e;
  }
}
