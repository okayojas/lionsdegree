/** Requirement Rules (mirroring the pipeline schema) and the Rule -> Pool
 * resolution used for cross-program fulfillment and slot suggestions.
 *
 * A POOL is the set of courses that may fill a Slot, together with where that
 * knowledge came from and how far it can be trusted. Provenance is part of the
 * Pool rather than metadata about it: the sources differ enormously in
 * reliability -- a bulletin table is authoritative, a department page read off
 * the bulletin is not, and "ask your adviser" is the requirement's actual
 * content rather than a gap in our data -- and the student has to be told
 * which one they are looking at. See CONTEXT.md. */
import { splitCode } from "./codes.js";

export type ReqFrom =
  // `discarded` means the pipeline HAD a list and threw it away because
  // every subject in it was a phantom. An empty list WITHOUT it means the
  // bulletin put the courses in the indented rows below the header. Both
  // resolve to `unreadable` (see resolveSlotPool for why neither borrows the
  // section's other courses); the flag exists so the two can be told apart
  // when deciding what to fix.
  | { kind: "courses"; courses: string[]; discarded?: boolean }
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

// ---------------------------------------------------------------- Pool

export type Pool =
  /** The bulletin names the courses outright. Authoritative. */
  | { kind: "listed"; courses: string[] }
  /** Derived from the subjects and levels the requirement describes. Only as
   * good as our reading of that description. */
  | { kind: "patterned"; subjects: string[]; minLevel: number | null }
  /** Any course carrying a given General Education designation. */
  | { kind: "genEd"; domain: string }
  /** A list from the Registry: published by a department off the bulletin, so
   * it travels with its source and the date it was read. */
  | {
      kind: "registry";
      courses: string[];
      entryId: string;
      sourceUrl: string;
      fetchedAt: string;
      edition: string;
      campusScope: string;
      confirmedBy: "html-parse" | "human";
    }
  /** No list exists ANYWHERE, because the requirement is settled by a
   * conversation. A kind in its own right, NEVER an empty one: an empty list
   * tells the student no course qualifies, which is false. The requirement's
   * own wording is the answer and the adviser is the authority. */
  | { kind: "adviser"; prose: string }
  /** We could not read this requirement at all. Distinct from `adviser`: that
   * one means no list EXISTS, this one means we failed to find a list that
   * does. Collapsing them would let unreadable rows out of the coverage
   * denominator and inflate the published coverage figure. The requirement's
   * raw text is all we have, and it is still shown rather than hidden. */
  | { kind: "unreadable"; prose: string };

export interface RegistryEntry {
  entryId: string;
  programSlug: string;
  /** Requirements are Edition-scoped facts; an entry read for one Edition says
   * nothing about another. */
  edition: string;
  /** Hash of the requirement's normalized wording. When a new Edition rewords
   * a requirement the fingerprint stops matching and the entry falls out into
   * review, rather than silently answering a question nobody asked. */
  fingerprint: string;
  courses: string[];
  sourceUrl: string;
  fetchedAt: string;
  /** Which campuses this list speaks for. A University Park list does not
   * silently speak for a branch campus. */
  campusScope: string;
  confirmedBy: "html-parse" | "human";
}

export interface Registry {
  entries: RegistryEntry[];
}

/** Everything Rule -> Pool resolution needs from outside the Rule itself. The
 * Registry is INJECTED, the way mined scheduling priors already are, so the
 * engine stays pure and reads no files. */
export interface PoolContext {
  programSlug?: string;
  edition?: string;
  registry?: Registry;
}

/** Stable hash of a requirement's wording, insensitive to case, punctuation
 * and whitespace so cosmetic edits do not invalidate a Registry entry.
 * FNV-1a, hand-rolled: the engine has no runtime dependencies and must run in
 * the browser, so node:crypto is not available. */
export function fingerprintRequirement(prose: string): string {
  const norm = prose.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function registryEntryFor(prose: string, ctx?: PoolContext): RegistryEntry | null {
  if (!ctx?.registry || !ctx.programSlug || !ctx.edition) return null;
  const fp = fingerprintRequirement(prose);
  return (
    ctx.registry.entries.find(
      (e) =>
        e.programSlug === ctx.programSlug &&
        e.edition === ctx.edition &&
        e.fingerprint === fp &&
        // An entry with no courses would produce a confident empty list.
        e.courses.length > 0,
    ) ?? null
  );
}

/** A rule that should name courses but names none is unreadable, not
 * adviser-defined: the bulletin meant to list something and we did not get it.
 * `prose` may be empty (oneOf carries no comment); that is honest -- we have
 * nothing to show -- and is why this is not an `adviser` Pool, whose whole
 * contract is that the wording IS the answer. */
const listedOrUnreadable = (courses: string[], prose: string): Pool =>
  courses.length ? { kind: "listed", courses } : { kind: "unreadable", prose };

function poolFromRegistryEntry(e: RegistryEntry): Pool {
  return {
    kind: "registry",
    courses: e.courses,
    entryId: e.entryId,
    sourceUrl: e.sourceUrl,
    fetchedAt: e.fetchedAt,
    edition: e.edition,
    campusScope: e.campusScope,
    confirmedBy: e.confirmedBy,
  };
}

/** Turn one Requirement Rule into the Pool of courses that can satisfy it.
 *
 * Returns null only for rules that carry no requirement at all (organizational
 * notes), which have no satisfying set to describe.
 *
 * The Registry is consulted ONLY where the bulletin yields no candidates. The
 * Registry exists to supply lists the bulletin names but does not contain;
 * where the bulletin publishes the list itself, the bulletin wins. */
export function poolFromRule(rule: ReqRule, ctx?: PoolContext): Pool | null {
  switch (rule.type) {
    case "course":
      return { kind: "listed", courses: [rule.code] };
    case "oneOf":
      return listedOrUnreadable(rule.options, "");
    case "chooseN":
      return listedOrUnreadable(rule.options, rule.commentRaw);
    case "genEd":
      return { kind: "genEd", domain: rule.domain };
    case "selectCredits": {
      const from = rule.from;
      if (from?.kind === "courses" && from.courses.length) return { kind: "listed", courses: from.courses };
      if (from?.kind === "pattern" && from.subjects.length)
        return { kind: "patterned", subjects: from.subjects, minLevel: from.minLevel };
      if (from?.kind === "genEd") return { kind: "genEd", domain: from.domain };
      // The Registry may hold the list the bulletin points at, whichever way
      // the bulletin failed to give us one.
      const registered = registryEntryFor(rule.commentRaw, ctx);
      if (registered) return poolFromRegistryEntry(registered);
      // An EMPTY course list is a list the bulletin meant to publish and we
      // could not read; no `from` at all means the bulletin pointed somewhere
      // else (a department list, or the student's adviser). The first is work
      // still to do, the second has no answer by design, and only the second
      // may be excluded from coverage.
      const unreadable = from?.kind === "courses" && from.courses.length === 0;
      return { kind: unreadable ? "unreadable" : "adviser", prose: rule.commentRaw };
    }
    case "unstructured":
      // A row we could not read. We still know a requirement is there, so show
      // its wording rather than pretending it does not exist -- but it is NOT
      // adviser-defined, and must not be counted as one.
      return { kind: "unreadable", prose: rule.commentRaw };
    case "note":
      return null;
  }
}

// -------------------------------------------------- label -> Pool matching

const GENERIC_TOKENS = new Set(["course", "courses", "list", "the", "a", "an", "of", "from", "select", "credits", "credit", "department", "and", "or", "in"]);

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !GENERIC_TOKENS.has(t)).map((t) => t.replace(/s$/, ""));
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

/** Find the Pool that can fill a slot with the given label ("Foundational
 * Elective", "Technical Elective") from a program's requirement sections.
 * Returns null when no requirement matches the label at all. */
export function resolveSlotPool(label: string, sections: ReqSection[], ctx?: PoolContext): Pool | null {
  const want = tokens(label);
  if (!want.length) return null;

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
  if (!best) return null;

  const pool = poolFromRule(best.rule, ctx);
  // Nothing concrete on the rule itself: sibling indented courses in the
  // matched section can also fill it. Gated to selectCredits rules that
  // resolved to `adviser`, which is narrower than it looks and deliberately
  // so.
  //
  // Widening it to `unreadable` (an EMPTY course list) was tried and
  // reverted. 91 rules in the shipped catalog have one; 10 of those sit in a
  // section that has sibling courses, and all 10 were measured by hand. Not
  // one was a correct recovery:
  //
  //   - 4 would offer courses the student is separately REQUIRED to take
  //     (the Spanish certificate's SPAN 310/420), i.e. a double-count.
  //   - 4 would merge mutually exclusive concentration branches into one
  //     pool -- the same defect as the SPAN merge bug.
  //   - 2 would offer "SELECT 8", "APPLY 6", "LEAST 6", "THE 400", prose the
  //     parser mistook for course codes.
  //
  // So an empty list stays unreadable and says so. The reviewer who flagged
  // this as an unintended narrowing was reading the gate rather than the ten
  // rules it governs.
  if (best.rule.type === "selectCredits" && pool?.kind === "adviser") {
    const siblings = sectionCourses(best.section);
    if (siblings.length) return { kind: "listed", courses: siblings };
  }
  return pool;
}

/** Membership sets, memoized per Pool: a Pool is resolved once per slot and
 * then tested against every course in the plan. */
const memberCache = new WeakMap<object, Set<string>>();
function members(pool: Pool & { courses: string[] }): Set<string> {
  let s = memberCache.get(pool);
  if (!s) {
    s = new Set(pool.courses);
    memberCache.set(pool, s);
  }
  return s;
}

/** Whether a Pool can be tested for membership by course code at all.
 *
 * A genEd Pool is answered by the gen-ed audit, which knows each course's
 * designations; an adviser Pool has nothing to test by construction. Callers
 * use this to decide between "here is the approved list" and "we cannot say
 * what counts" -- a distinction the UI must make, so it lives here rather than
 * being re-derived in each component. */
export function poolHasMembership(
  pool: Pool | null,
): pool is Extract<Pool, { kind: "listed" | "registry" | "patterned" }> {
  return !!pool && (pool.kind === "listed" || pool.kind === "registry" || pool.kind === "patterned");
}

/** Whether this Pool's absence of courses is the requirement's real content
 * (ask your adviser) rather than our failure to read it. Coverage reporting
 * excludes the former from its denominator and must NOT exclude the latter. */
export function poolIsAdviserDefined(pool: Pool | null): boolean {
  return pool?.kind === "adviser";
}

export function codeMatchesPool(code: string, pool: Pool | null): boolean {
  if (!pool) return false;
  switch (pool.kind) {
    case "listed":
    case "registry":
      return members(pool).has(code);
    case "patterned": {
      const split = splitCode(code);
      if (!split) return false;
      const level = parseInt(split.number, 10);
      return pool.subjects.includes(split.subject) && (pool.minLevel === null || level >= pool.minLevel);
    }
    // A General Education domain is satisfied via the gen-ed audit, which knows
    // each course's designations; a bare code cannot answer it here. An adviser
    // Pool has no membership to test by construction.
    case "genEd":
    case "adviser":
    case "unreadable":
      return false;
  }
}
