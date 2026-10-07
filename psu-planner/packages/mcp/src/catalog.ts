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

const read = <T,>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
};

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
  const courses = hydrateSearchIndex(read<unknown[]>(path.join(dir, "search-index.json"), []));
  const coverage = read<{ coveredBy?: Record<string, { by: string }[]> }>(path.join(dir, "coverage.json"), {});
  return {
    edition,
    catalog: buildCatalog(courses),
    programs: read(path.join(dir, "program-requirements.json"), {} as Record<string, ProgramRequirements>),
    programsIndex: read<ProgramIndexEntry[]>(path.join(dir, "programs_index.json"), []),
    coveredBy: Object.fromEntries(
      Object.entries(coverage.coveredBy ?? {}).map(([k, v]) => [k, v.map((x) => x.by)]),
    ),
  };
}
