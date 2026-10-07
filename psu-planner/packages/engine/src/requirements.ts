/** Requirement-rule types (mirroring the pipeline schema) and the slot→rule
 * matcher used for cross-program fulfillment and slot suggestions. */
import { splitCode } from "./codes.js";

export type ReqFrom =
  | { kind: "courses"; courses: string[] }
  /** Several subjects, because requirements routinely name several ("400-level
   * BMB, BIOL, BIOTC, or MICRB courses") and holding one silently deleted the
   * rest. minLevel is the LOWEST level admitted: "300 or 400-level" means 300. */
  | { kind: "pattern"; subjects: string[]; minLevel: number | null }
  | { kind: "genEd"; domain: string };

export type ReqRule =
  | { type: "course"; code: string; credits: number | null }
  | { type: "oneOf"; options: string[]; credits: number | null }
  | { type: "chooseN"; n: number; options: string[]; credits: number | null; commentRaw: string }
  | { type: "selectCredits"; credits: number | null; commentRaw: string; from: ReqFrom | null }
  | { type: "genEd"; domain: string; credits: number | null; commentRaw: string }
  | { type: "note"; commentRaw: string }
  | { type: "unstructured"; commentRaw: string };

export interface ReqSection {
  heading: string;
  kind: string;
  creditsRequired: number | null;
  rules: ReqRule[];
}

const GENERIC_TOKENS = new Set(["course", "courses", "list", "the", "a", "an", "of", "from", "select", "credits", "credit", "department", "and", "or", "in"]);

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !GENERIC_TOKENS.has(t)).map((t) => t.replace(/s$/, ""));
}

export interface SlotPool {
  courses: Set<string>;
  patterns: { subjects: string[]; minLevel: number | null }[];
  genEdDomains: string[];
  matchedRule: ReqRule | null;
}

/** All courses named anywhere in a section (options, choices, prescribed). */
function sectionCourses(section: ReqSection): string[] {
  const out: string[] = [];
  for (const r of section.rules) {
    if (r.type === "course") out.push(r.code);
    else if (r.type === "oneOf" || r.type === "chooseN") out.push(...r.options);
    else if (r.type === "selectCredits" && r.from?.kind === "courses") out.push(...r.from.courses);
  }
  return out;
}

/** Find the courses that can fill a slot with the given label ("Foundational
 * Elective", "Technical Elective") from a program's requirement sections. */
export function resolveSlotPool(label: string, sections: ReqSection[]): SlotPool {
  const want = tokens(label);
  const pool: SlotPool = { courses: new Set(), patterns: [], genEdDomains: [], matchedRule: null };
  if (!want.length) return pool;

  let best: { score: number; rule: ReqRule; section: ReqSection } | null = null;
  for (const section of sections) {
    const headingToks = new Set(tokens(section.heading));
    for (const rule of section.rules) {
      const text =
        rule.type === "selectCredits" || rule.type === "chooseN" || rule.type === "genEd" || rule.type === "note" || rule.type === "unstructured"
          ? rule.commentRaw
          : "";
      const ruleToks = new Set([...tokens(text), ...headingToks]);
      const hits = want.filter((t) => ruleToks.has(t)).length;
      if (hits === want.length && (rule.type === "selectCredits" || rule.type === "chooseN")) {
        const score = hits + (tokens(text).some((t) => want.includes(t)) ? 1 : 0);
        if (!best || score > best.score) best = { score, rule, section };
      }
    }
  }
  if (!best) return pool;

  pool.matchedRule = best.rule;
  if (best.rule.type === "chooseN") best.rule.options.forEach((c) => pool.courses.add(c));
  if (best.rule.type === "selectCredits") {
    const from = best.rule.from;
    if (from?.kind === "courses") from.courses.forEach((c) => pool.courses.add(c));
    else if (from?.kind === "pattern") pool.patterns.push({ subjects: from.subjects, minLevel: from.minLevel });
    else if (from?.kind === "genEd") pool.genEdDomains.push(from.domain);
    // Sibling indented courses in the matched section can also fill it.
    if (!pool.courses.size && !pool.patterns.length && !pool.genEdDomains.length) {
      sectionCourses(best.section).forEach((c) => pool.courses.add(c));
    }
  }
  return pool;
}

export function codeMatchesPool(code: string, pool: SlotPool): boolean {
  if (pool.courses.has(code)) return true;
  const split = splitCode(code);
  if (!split) return false;
  const level = parseInt(split.number, 10);
  return pool.patterns.some((p) => p.subjects.includes(split.subject) && (p.minLevel === null || level >= p.minLevel));
}
