/** The audit index: what every Course looks like before its subject file
 * has been read.
 *
 * The degree audit has to see the WHOLE catalog, because an elective or a
 * General Education requirement can be satisfied by almost anything —
 * narrowing it to the subjects a Plan already touches would quietly hide
 * real options. But it reads only a handful of fields off a Course, so it
 * gets a file carrying only those: 212 KB gzipped against the 2,419 KB the
 * combined index used to cost (#24).
 *
 * This lives in the engine rather than in either client because BOTH read
 * it now — the planner in the browser and the MCP server — and a second
 * hydration is a second set of answers about what a Course is. The
 * `level` bug is the argument: it was hardcoded here once, and 5,126
 * graduate Courses were offered to undergraduates until a test caught it.
 * One copy can be fixed once.
 *
 * SUBJECT AND NUMBER ARE DERIVED, not stored. Verified across all 14,615
 * Courses in both Editions: `subject` is exactly the code before the space
 * and `number` exactly the part after, with no exceptions. A pipeline test
 * asserts that invariant at build time, so if the Bulletin ever produces a
 * code where it does not hold, the build says so rather than pattern rules
 * quietly mis-matching.
 */
import type { Course } from "./types.js";

export interface AuditRow {
  code: string;
  title?: string;
  creditsParsed?: Course["creditsParsed"];
  genEd?: string[];
  attributes?: string[];
  /** Absent means undergraduate: the pipeline drops the common case to save
   * weight, so only graduate rows carry it. */
  level?: string;
}

/** The shape the pipeline writes. */
export interface AuditIndexFile {
  courses: AuditRow[];
}

/** A whole `Course` from one slim row.
 *
 * Everything absent is filled with the EMPTY value, never a plausible one.
 * `prereqAst: null` with `astComplete: false` says "no prerequisite
 * structure was loaded" — which is what a subject-file load is for.
 * Inventing one here would let the audit reason about prerequisites it has
 * not actually read, and report a requirement satisfied on the strength of
 * it (iron rule 2).
 */
/** The subject half of a Course code, upper-cased.
 *
 * One implementation, because this split is load-bearing in three places
 * now: hydrating an audit row, locating a subject file, and matching a
 * pattern rule. The pipeline asserts it reproduces the stored `subject`
 * for all 14,615 Courses. */
export function subjectOf(code: string): string {
  const space = code.indexOf(" ");
  return (space > 0 ? code.slice(0, space) : code).trim().toUpperCase();
}

export function hydrateAuditRow(r: AuditRow): Course {
  const space = r.code.indexOf(" ");
  return {
    code: r.code,
    subject: space > 0 ? r.code.slice(0, space) : r.code,
    number: space > 0 ? r.code.slice(space + 1) : "",
    display: r.code,
    title: r.title ?? "",
    credits: "",
    creditsParsed: r.creditsParsed ?? null,
    description: "",
    enforced: null,
    concurrent: null,
    prereqAdvisory: null,
    prereqAst: null,
    concurrentAst: null,
    astComplete: false,
    genEd: r.genEd ?? [],
    attributes: r.attributes ?? [],
    crossListings: [],
    aliases: [],
    // READ, not assumed. This was hardcoded to "undergraduate" and the index
    // is built from courses/ AND courses/grad/ -- 5,126 of 14,615 rows are
    // 500-level or higher. The engine gates gen-ed and elective suggestions
    // on `level !== "undergraduate"`, so hardcoding it offered graduate
    // Courses to undergraduates: a plausible invented value, which is exactly
    // what this function's own contract forbids.
    level: (r.level as Course["level"]) ?? "undergraduate",
    url: "",
  } as Course;
}

/** Whether a parsed file is a usable audit index.
 *
 * An index that parses but is empty is the same failure wearing a different
 * hat: the server starts cleanly and then reports that every Course a
 * student asks about does not exist. */
export function isAuditIndex(v: unknown): v is AuditIndexFile {
  return !!v && typeof v === "object" && Array.isArray((v as AuditIndexFile).courses) && (v as AuditIndexFile).courses.length > 0;
}
