/** Academic term sequencing: Fall/Spring plus OPT-IN summer sessions.
 *
 * A summer session is identified by its calendar YEAR (Summer 2027 sits
 * between Spring 2027 and Fall 2027) — durable across re-optimization, unlike
 * term indices which shift when terms are inserted or the plan re-packs.
 * `PlanDoc.summerYears` lists the years whose summers the student wants to
 * use; every label generator threads through here so the whole pipeline
 * agrees on the sequence. Summer terms carry a LOWER credit ceiling (PSU
 * summer loads realistically run 3-9 credits) and are exempt from the
 * full-time 14-credit floor. */

export type TermKind = "Fall" | "Spring" | "Summer";

export interface TermRef {
  label: string; // e.g. "Summer 2027"
  kind: TermKind;
  year: number;
}

/** Realistic per-summer credit ceiling (two 6-week sessions; most students
 * take one or two courses per session). */
export const SUMMER_MAX_CREDITS = 9;

/** Parse "Fall 2026" / "Summer 2027" into a TermRef; null if unrecognized. */
export function parseTermLabel(label: string): TermRef | null {
  const m = /^(Fall|Spring|Summer)\s+(20\d{2})$/.exec(label.trim());
  return m ? { label: `${m[1]} ${m[2]}`, kind: m[1] as TermKind, year: parseInt(m[2], 10) } : null;
}

function next(t: TermRef, summerYears: ReadonlySet<number>): TermRef {
  if (t.kind === "Fall") return { label: `Spring ${t.year + 1}`, kind: "Spring", year: t.year + 1 };
  if (t.kind === "Spring") {
    return summerYears.has(t.year)
      ? { label: `Summer ${t.year}`, kind: "Summer", year: t.year }
      : { label: `Fall ${t.year}`, kind: "Fall", year: t.year };
  }
  return { label: `Fall ${t.year}`, kind: "Fall", year: t.year };
}

/** The term sequence starting at `start`, `count` long, with summer sessions
 * inserted after the springs of the given years. */
export function termSequence(
  start: { term: "Fall" | "Spring"; year: number },
  count: number,
  summerYears: Iterable<number> = [],
): TermRef[] {
  const summers = new Set(summerYears);
  const out: TermRef[] = [];
  let cur: TermRef = { label: `${start.term} ${start.year}`, kind: start.term, year: start.year };
  for (let i = 0; i < count; i++) {
    out.push(cur);
    cur = next(cur, summers);
  }
  return out;
}

/** 1-based ACADEMIC year of a term relative to the plan's first term. PSU
 * academic years run Fall -> Spring -> Summer (Summer 2027 closes AY 2026-27),
 * which is also how Schreyer counts honors-credit years. */
export function academicYearOf(term: TermRef, first: TermRef): number {
  const ayStart = (t: TermRef) => (t.kind === "Fall" ? t.year : t.year - 1);
  return ayStart(term) - ayStart(first) + 1;
}
