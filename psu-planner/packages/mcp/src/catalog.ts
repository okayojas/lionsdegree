/** Loading the bundled catalog.
 *
 * Everything is read from disk inside the installed package. No fetch, no
 * account, no key -- running this costs the project nothing and tells nobody
 * what a student is studying.
 *
 * Only ONE edition is ever loaded: the one the student's plan is pinned to.
 * Their requirements come from the bulletin in force when they entered their
 * major, so reading any other would answer a question they did not ask. */
import fs from "node:fs";
import path from "node:path";
import { buildCatalog, hydrateSearchIndex, type Catalog, type ReqSection } from "@psu-planner/engine";

export interface ProgramRequirements {
  slug: string;
  name: string;
  type: string;
  totalCredits: number | null;
  requirementSections: ReqSection[];
}

export interface ProgramIndexEntry {
  slug: string;
  name: string;
  type: string;
  campuses: string[];
  college: string | null;
}

export interface EditionCatalog {
  edition: string;
  catalog: Catalog;
  programs: Record<string, ProgramRequirements>;
  programsIndex: ProgramIndexEntry[];
  coveredBy: Record<string, string[]>;
}

/** For files the server can do without: coverage (no substitute matching) and
 * the programs index (no program listing). Courses still answer. */
const read = <T,>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
};

/** For files the server CANNOT do without.
 *
 * Falling back to `[]` here produced the worst available outcome: the server
 * started cleanly and then answered "MATH 141 is not in the 2025-2026
 * catalog" for every course an assistant asked about. That is a confident
 * wrong answer, which this package exists to refuse (iron rule 2) -- and it
 * is reachable, because sync-catalog skips an edition whose source files are
 * missing while still listing it in editions.json. Refusing to start names
 * the real problem instead. */
function readRequired<T>(file: string, label: string, isUsable: (v: T) => boolean): T {
  let parsed: T;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (e) {
    throw new Error(
      `${label} could not be read from ${file} (${e instanceof Error ? e.message : String(e)}). ` +
        `Re-run \`node scripts/sync-catalog.mjs\` to rebuild this server's catalog.`,
    );
  }
  if (!isUsable(parsed)) {
    // Parsed but empty is the same failure wearing a different hat.
    throw new Error(
      `${label} at ${file} is empty. Re-run \`node scripts/sync-catalog.mjs\` to rebuild this server's catalog.`,
    );
  }
  return parsed;
}

export function publishedEditions(catalogRoot: string): string[] {
  const index = path.join(catalogRoot, "editions.json");
  const fromIndex = read<{ editions?: string[] }>(index, {}).editions;
  if (fromIndex?.length) return fromIndex;
  if (!fs.existsSync(catalogRoot)) return [];
  return fs
    .readdirSync(catalogRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{4}$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Read one edition. Measured at ~70 ms for a 12.5 MB index, paid once when
 * the assistant connects: this process is long-lived, so every query after
 * this is in memory. */
export function loadEdition(catalogRoot: string, edition: string): EditionCatalog {
  const dir = path.join(catalogRoot, edition);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `This copy of lionsdegree-mcp does not include the ${edition} bulletin. ` +
        `It has: ${publishedEditions(catalogRoot).join(", ") || "none"}.`,
    );
  }
  // Accepts both index shapes. The current one is `{terms, courses}` --
  // a shared term dictionary plus per-course postings, carrying no description
  // prose (DECISIONS.md 5.1). A bare array is the pre-postings format, still
  // valid and still searchable on code and title.
  const courses = hydrateSearchIndex(
    readRequired<unknown[] | { terms: string[]; courses: unknown[] }>(
      path.join(dir, "search-index.json"),
      `The ${edition} course index`,
      (v) =>
        (Array.isArray(v) && v.length > 0) ||
        (!!v && typeof v === "object" && Array.isArray((v as { courses?: unknown }).courses) && (v as { courses: unknown[] }).courses.length > 0),
    ),
  );
  const coverage = read<{ coveredBy?: Record<string, { by: string }[]> }>(path.join(dir, "coverage.json"), {});
  return {
    edition,
    catalog: buildCatalog(courses),
    programs: readRequired<Record<string, ProgramRequirements>>(
      path.join(dir, "program-requirements.json"),
      `The ${edition} program requirements`,
      (v) => !!v && typeof v === "object" && Object.keys(v).length > 0,
    ),
    programsIndex: read<ProgramIndexEntry[]>(path.join(dir, "programs_index.json"), []),
    coveredBy: Object.fromEntries(
      Object.entries(coverage.coveredBy ?? {}).map(([k, v]) => [k, v.map((x) => x.by)]),
    ),
  };
}
