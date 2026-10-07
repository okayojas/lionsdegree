/** Parse table.sc_courselist requirement tables into structured rule sections.
 * Structure is additive, never lossy: every section keeps its rawText, and any
 * row the deterministic parser can't classify becomes an `unstructured` rule
 * plus an entry in the needs-review queue. */
import * as cheerio from "cheerio";
import { normDisplayCode } from "../lib/codes.js";
import { astComplete, parseExpr, tokenize, type AstNode } from "../lib/prereq.js";
import type { RequirementSection, Rule } from "../validate/schemas.js";

function clean(s: string): string {
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function sectionKind(heading: string): RequirementSection["kind"] {
  const h = heading.toLowerCase();
  if (h.includes("prescribed")) return "prescribed";
  if (h.includes("additional")) return "additional";
  if (h.includes("supporting")) return "supporting";
  if (h.includes("general education")) return "geneds";
  if (h.includes("elective")) return "electives";
  return "other";
}

const GENED_DOMAINS = ["GWS", "GQ", "GA", "GH", "GHW", "GN", "GS"];
const WORD_NUMS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/** Strict code-token pattern: subject 2-6 UPPERCASE letters (optionally A-I
 * style), number 1-3 digits + up to 2 letter suffix. Uppercase-only on purpose:
 * case-insensitive matching turned prose like "The 400-level", "Option 4", and
 * "apply 6" into phantom course codes. Bare numbers inherit the previous
 * subject ("CMPSC 121 or 131"); slash subjects share the number ("STS/PHIL 107").
 * Wildcards ("BIOL 4XX") are patterns, not courses — rejected here. */
const CODE_TOKEN = /^([A-Z]{2,6}(?:-[A-Z])?(?:\s*\/\s*[A-Z]{2,6}(?:-[A-Z])?)*)\s*(\d{1,3}[A-Z]{0,2})$/;
const BARE_NUM = /^(\d{1,3}[A-Z]{0,2})$/;
const WILDCARD = /^\d[XY]{2}$|^\dXX$/i;

export interface CodeListResult {
  codes: string[];
  leadingOr: boolean;
}

/** If the text is purely a list of course codes joined by or/and/commas/slashes,
 * return the expanded codes; otherwise null. Conservative by design — prose
 * like "400 level" must NOT match. */
export function parseCodeListText(text: string): CodeListResult | null {
  let t = clean(text).replace(/[.;]+$/, "");
  const leadingOr = /^or\s+/i.test(t);
  t = t.replace(/^(?:or|and)\s+/i, "");
  if (!t) return null;
  const parts = t.split(/\s*(?:,|\bor\b|\band\b|&)\s*/i).filter(Boolean);
  const codes: string[] = [];
  let lastSubjects: string[] | null = null;
  for (const part of parts) {
    if (WILDCARD.test(part.trim().split(/\s+/).pop() ?? "")) return null; // "BIOL 4XX" is a pattern
    const m = CODE_TOKEN.exec(part.trim());
    if (m) {
      const subjects = m[1].split(/\s*\/\s*/).map((s) => s.trim());
      for (const subj of subjects) {
        const code = normDisplayCode(`${subj} ${m[2]}`);
        if (!code) return null;
        codes.push(code);
      }
      lastSubjects = subjects;
      continue;
    }
    const bare = BARE_NUM.exec(part.trim());
    if (bare && lastSubjects) {
      for (const subj of lastSubjects) {
        const code = normDisplayCode(`${subj} ${bare[1]}`);
        if (!code) return null;
        codes.push(code);
      }
      continue;
    }
    return null;
  }
  return codes.length ? { codes, leadingOr } : null;
}

/** Requirement rows sometimes hold boolean expressions ("CHEM 210 & CHEM 212 &
 * (CHEM 213 or CHEM 213W)"). Reuse the prereq parser and flatten a top-level
 * AND chain of courses / or-groups into individual rules. */
export function parseBooleanRow(text: string, credits: number | null): Rule[] | null {
  if (!/[&()]/.test(text)) return null;
  const ast = parseExpr(tokenize(text.replace(/&/g, " and ")));
  if (!astComplete(ast)) return null;
  const rules: Rule[] = [];
  const orChain = (n: AstNode): string[] | null => {
    if (n.op === "course") return [n.code];
    if (n.op === "or") {
      const a = orChain(n.a), b = orChain(n.b);
      return a && b ? [...a, ...b] : null;
    }
    return null;
  };
  const walkAnd = (n: AstNode): boolean => {
    if (n.op === "and") return walkAnd(n.a) && walkAnd(n.b);
    if (n.op === "course") { rules.push({ type: "course", code: n.code, credits: null }); return true; }
    const ors = orChain(n);
    if (ors) { rules.push({ type: "oneOf", options: ors, credits: null }); return true; }
    return false;
  };
  if (!walkAnd(ast) || !rules.length) return null;
  if (rules.length === 1) {
    const only = rules[0];
    if (only.type === "course" || only.type === "oneOf") only.credits = credits;
  }
  return rules;
}

/** Organizational labels and policy notes that carry no checkable rule. */
export function isNoteRow(text: string): boolean {
  if (/^select an option[.:]?$/i.test(text)) return true;
  if (/^a maximum of \d+/i.test(text)) return true;
  if (/^per university policy/i.test(text)) return true;
  // Short heading-like labels ("Evolution Group:", "Practicum Group:")
  if (/:$/.test(text) && text.length < 60 && !/\bcredits?\b/i.test(text) && !/\d{2,}/.test(text)) return true;
  return false;
}

/** Uppercase tokens that show up inside requirement prose but are never course
 * subjects. Gen-ed domains are listed because they are their own pool kind. */
const NOT_SUBJECTS = new Set([
  "I", "II", "III", "IV", "V", "VI", "GPA", "US", "IL", "AND", "OR", "THE", "OF",
  "AT", "IN", "FROM", "ANY", "ONE", "TWO", "ALL", "NOT", "A", "AN",
  "GWS", "GQ", "GA", "GH", "GHW", "GN", "GS",
]);

/** List separator: a comma, a slash, "or"/"and", or any combination of them
 * ("BIOL, BIOTC, or MICRB" is a comma AND an "or", and treating it as one or
 * the other truncated the list at the last comma). */
const SEP = String.raw`(?:\s*,\s*(?:or|and)\s+|\s*,\s*|\s+(?:or|and)\s+|\s*\/\s*)`;

/** The level phrase, capturing EVERY level the prose admits: "300 or 400-level"
 * and "200 - 400 level" both yield their full range. The old pattern anchored
 * on a single \d{3} adjacent to "level", so it read both as 400 and silently
 * deleted every lower-level course from the pool. minLevel is the floor of
 * what it captures. */
const LEVEL_SEP = String.raw`(?:\s*(?:,|-|–|\/|\bor\b|\band\b|\bto\b)\s*)`;
const LEVEL_PHRASE = new RegExp(String.raw`\b(\d{3}(?:${LEVEL_SEP}\d{3})*)\s*-?\s*level\b`, "i");

/** A separated run of subject tokens. UPPERCASE-ONLY, for exactly the reason
 * CODE_TOKEN is (see its comment): the old regex matched case-insensitively, so
 * "with at least 3 credits at the 400-level" parsed as a subject named REDITS.
 * Case-insensitivity on code-shaped regexes has now produced this class of bug
 * twice; see DECISIONS.md 2.4. */
/** A subject code as the bulletin writes it. Some carry an internal SPACE --
 * "PL SC courses" is PLSC in the catalog -- and reading only the first half
 * left the whole requirement with no pool, because PL is not a subject.
 *
 * The second part must be ALL CAPS, two or more letters, not a wildcard, and
 * not the start of a Capitalised word. Without those guards "Advanced IT
 * Business courses" read as "IT B" -> ITB and destroyed the valid IT, and
 * "NURS 400-Level ... (NURS XXX)" became NURSXXX. Both are real rows that
 * regressed before the guards went in. */
const SUBJECT_TOKEN = String.raw`[A-Z]{2,7}(?:[ -](?!X{2,})[A-Z]{2,5}(?![a-z]))?`;
const SUBJECT_RUN = new RegExp(String.raw`\b${SUBJECT_TOKEN}(?:${SEP}${SUBJECT_TOKEN})*`, "g");
const SUBJECT_SPLIT = new RegExp(SEP);

function pickSubjects(segment: string, trailing = false): string[] | null {
  const runs = segment.match(SUBJECT_RUN) ?? [];
  for (const run of trailing ? [...runs].reverse() : runs) {
    const subjects = [
      ...new Set(
        run
          .split(SUBJECT_SPLIT)
          // "A-I" is stored as "AI" with an "A-I" alias, as everywhere else.
          .map((s) => s.trim().toUpperCase().replace(/[\s-]/g, ""))
          .filter((s) => s.length >= 2 && !NOT_SUBJECTS.has(s)),
      ),
    ];
    if (subjects.length) return subjects;
  }
  return null;
}

/** "9 credits of 400-level BMB, BIOL, or MICRB courses" and its inversions.
 * Returns the LOWEST level the prose admits and EVERY subject it names.
 * Subjects are candidates only: they are intersected with the real subject
 * index downstream, because prose like "Advanced IT courses" yields plausible
 * tokens that are not subjects. */
export function parseLevelSubjects(rest: string): { kind: "pattern"; subjects: string[]; minLevel: number | null } | null {
  const lv = LEVEL_PHRASE.exec(rest);
  if (!lv) return null;
  const levels = (lv[1].match(/\d{3}/g) ?? []).map(Number);
  const minLevel = levels.length ? Math.min(...levels) : null;

  // Subjects follow the level ("400-level BMB, BIOL") or precede it
  // ("ENTR courses at the 400 level"); prefer the former.
  const subjects =
    pickSubjects(rest.slice(lv.index + lv[0].length)) ?? pickSubjects(rest.slice(0, lv.index), true);
  if (!subjects?.length) return null;
  return { kind: "pattern", subjects, minLevel };
}

/** Classify a courselistcomment row into a structured rule where possible. */
export function classifyComment(text: string): Rule {
  // "Select one/two of the following (...)" -> chooseN, options collected from
  // the indented rows that follow.
  const chooseWord =
    /^(?:students?\s+(?:must|should|will)\s+)?(?:select|choose|take|complete)\s+(one|two|three|four|five|six|\d+)\s+(?:course|of the following|(?:additional\s+)?courses?)/i.exec(text);
  if (chooseWord) {
    const n = WORD_NUMS[chooseWord[1].toLowerCase()] ?? parseInt(chooseWord[1], 10);
    if (n >= 1 && n <= 20) return { type: "chooseN", n, options: [], credits: null, commentRaw: text };
  }

  // Any "...select/take/choose ... N credits ..." phrasing, including with a
  // leading clause ("In consultation with adviser, select 12 credits from...").
  const sel =
    /^(?:students?\s+(?:must|should|will)\s+)?(?:select|choose|take|complete)\b[^.]*?\b(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s+credits?\b(.*)$/i.exec(text) ??
    /^Select\s+(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s+credits?\s*:?(.*)$/i.exec(text) ??
    (text.length < 220
      ? /\b(?:select|choose|take|complete)\b[^.]*?\b(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s+credits?\b(.*)$/i.exec(text)
      : null);
  if (sel) {
    const credits = parseFloat(sel[1]);
    const rest = clean(sel[3] ?? "");
    if (!rest || /the following/i.test(rest) || /:$/.test(text.trim())) {
      return { type: "selectCredits", credits, commentRaw: text, from: { kind: "courses", courses: [] } };
    }
    const pat = parseLevelSubjects(rest);
    if (pat) return { type: "selectCredits", credits, commentRaw: text, from: pat };
    const ged = GENED_DOMAINS.find((d) => new RegExp(`\\b${d}\\b`).test(rest));
    if (ged) return { type: "selectCredits", credits, commentRaw: text, from: { kind: "genEd", domain: ged } };
    const list = parseCodeListText(rest);
    if (list) return { type: "selectCredits", credits, commentRaw: text, from: { kind: "courses", courses: list.codes } };
    // Constraint prose we can't model ("in consultation with adviser", "with at
    // least 9 credits at the 400 level") — keep the credit count, keep the text.
    return { type: "selectCredits", credits, commentRaw: text, from: null };
  }

  const ged = /^(GWS|GQ|GA|GH|GHW|GN|GS)\b.*course/i.exec(text);
  if (ged) return { type: "genEd", domain: ged[1].toUpperCase(), credits: null, commentRaw: text };

  // A CONDITIONAL list header: "If you take SPAN 215N or SPAN 215Q, select one
  // of the following courses:". The condition comes first, so the anchored
  // patterns above miss it and the row reads as prose -- which let two
  // mutually exclusive branches collect into a single pool, offering a student
  // courses that cannot satisfy their requirement. Checked last, so anything
  // with an explicit credit count is already handled; bounded to rows that END
  // by introducing a list, which is a strong enough signal to be safe.
  // The leading `.*` is greedy ON PURPOSE: it pushes the match to the LAST
  // select/choose/take in the row. Anchoring on the first one matched the
  // "take" of "If you take SPAN 253W, select two of the following" and the
  // count was never captured, so every conditional list recorded as one
  // course. Today's catalog says "select one" throughout, so nothing was
  // wrong yet -- a row saying "select two" would have under-credited a
  // student by a whole course.
  const conditional = /^.*\b(?:select|choose|take)\s+(one|two|three|four|five|six|\d+)?[^.]*?\bfollowing(?:\s+courses?)?\s*:$/i.exec(text);
  if (conditional) {
    const word = conditional[1]?.toLowerCase();
    const n = word ? (WORD_NUMS[word] ?? parseInt(word, 10)) : 1;
    return { type: "chooseN", n: Number.isFinite(n) && n > 0 ? n : 1, options: [], credits: null, commentRaw: text };
  }

  return { type: "unstructured", commentRaw: text };
}

export interface RequirementsParseResult {
  sections: RequirementSection[];
  needsReview: { heading: string; text: string }[];
}

export function parseRequirementTables(html: string): RequirementsParseResult {
  const $ = cheerio.load(html);
  const container = $("#programrequirementstextcontainer");
  const tables = container.length ? container.find("table.sc_courselist") : $("table.sc_courselist");
  const sections: RequirementSection[] = [];
  const needsReview: RequirementsParseResult["needsReview"] = [];

  tables.each((_, table) => {
    let current: RequirementSection | null = null;
    /** Open rule that collects option codes from following indented rows. */
    let collector: Extract<Rule, { type: "selectCredits" | "chooseN" }> | null = null;

    /** A Pool is a SET of courses that may fill the requirement. The bulletin
     * repeats a code when it appears in several sub-lists under one heading
     * ("18 credits of 400-level biology" lists BIOL 406 under both Ecology and
     * Genetics), and an or-pair row repeats its left side. Collecting those
     * verbatim gave one requirement 157 entries for 84 real courses. */
    const pushUnique = (into: string[], codes: string[]) => {
      for (const c of codes) if (!into.includes(c)) into.push(c);
    };

    const collectInto = (codes: string[]): boolean => {
      if (!collector) return false;
      if (collector.type === "chooseN") { pushUnique(collector.options, codes); return true; }
      if (collector.from?.kind === "courses") { pushUnique(collector.from.courses, codes); return true; }
      return false;
    };

    const push = () => {
      if (current) {
        current.structured = current.rules.every((r) => r.type !== "unstructured");
        sections.push(current);
      }
    };
    const ensureSection = (heading: string) => {
      push();
      current = {
        heading,
        kind: sectionKind(heading),
        creditsRequired: null,
        rules: [],
        structured: true,
        llmNormalized: false,
        rawText: "",
      };
      collector = null;
    };

    $(table)
      .find("tbody tr")
      .each((_, tr) => {
        const $tr = $(tr);
        const cls = $tr.attr("class") ?? "";
        const rowText = clean($tr.clone().find("sup").remove().end().text());
        if (!rowText) return;

        const isHeader = $tr.find("span.areaheader").length > 0;
        const isSubheader = $tr.find("span.areasubheader").length > 0;
        const comment = $tr.find("span.courselistcomment").first();
        const codeLink = $tr.find("td.codecol a").first();
        const hoursText = clean($tr.find("td.hourscol").first().text());
        const credits = hoursText && !Number.isNaN(parseFloat(hoursText)) ? parseFloat(hoursText) : null;
        const indented = $tr.find("div.blockindent").length > 0;

        if (isHeader) {
          ensureSection(clean(comment.clone().find("sup").remove().end().text()) || rowText);
          return;
        }
        if (!current) ensureSection("Requirements");
        current!.rawText += rowText + "\n";
        if (isSubheader) return;

        const foldIntoPrev = (codes: string[], rowCredits: number | null) => {
          const prevRule = current!.rules[current!.rules.length - 1];
          if (prevRule?.type === "course") {
            current!.rules[current!.rules.length - 1] = {
              type: "oneOf",
              options: [prevRule.code, ...codes],
              credits: prevRule.credits ?? rowCredits,
            };
          } else if (prevRule?.type === "oneOf") {
            prevRule.options.push(...codes);
          } else if (!collectInto(codes)) {
            current!.rules.push(codes.length > 1 ? { type: "oneOf", options: codes, credits: rowCredits } : { type: "course", code: codes[0], credits: rowCredits });
          }
        };

        // codecol cells without links (courses the bulletin didn't hyperlink):
        // parse the cell text as a code list or boolean expression.
        const codeCell = $tr.find("td.codecol").first();
        if (!codeLink.length && codeCell.length) {
          const text = clean(codeCell.clone().find("sup").remove().end().text());
          if (text) {
            const list = parseCodeListText(text);
            if (list) {
              if (list.leadingOr) foldIntoPrev(list.codes, credits);
              else if (indented && collectInto(list.codes)) { /* collected */ }
              else if (list.codes.length > 1) current!.rules.push({ type: "oneOf", options: list.codes, credits });
              else current!.rules.push({ type: "course", code: list.codes[0], credits });
              return;
            }
            const bool = parseBooleanRow(text, credits);
            if (bool) { current!.rules.push(...bool); collector = null; return; }
          }
        }

        if (codeLink.length) {
          const codesInCell = $tr
            .find("td.codecol a")
            .map((_, a) => normDisplayCode(clean($(a).attr("title") ?? $(a).text())))
            .get()
            .filter((c): c is string => !!c);
          if (!codesInCell.length) {
            // The cell is hyperlinked but no title resolved to a code --
            // cross-listed titles like "LTNST/ENGL 226" are the common case.
            // Surfacing it beats dropping the row on the floor: silently
            // discarding a course the bulletin published is the failure mode
            // the review queue exists to catch.
            needsReview.push({ heading: current!.heading, text: rowText });
            return;
          }

          if (cls.includes("orclass")) {
            foldIntoPrev(codesInCell, credits);
            return;
          }
          if (indented && collectInto(codesInCell)) return;

          if (codesInCell.length > 1) {
            current!.rules.push({ type: "oneOf", options: codesInCell, credits });
          } else {
            current!.rules.push({ type: "course", code: codesInCell[0], credits });
          }
          collector = null;
          return;
        }

        if (comment.length) {
          const text = clean(comment.clone().find("sup").remove().end().text());
          if (!text) return;

          // Comment rows that are purely course codes ("CRIMJ 200",
          // "or STS/PHIL 107") — treat like code rows.
          const list = parseCodeListText(text);
          if (list) {
            if (list.leadingOr) foldIntoPrev(list.codes, credits);
            else if (indented && collectInto(list.codes)) { /* collected */ }
            else if (list.codes.length > 1) current!.rules.push({ type: "oneOf", options: list.codes, credits });
            else current!.rules.push({ type: "course", code: list.codes[0], credits });
            return;
          }

          if (isNoteRow(text)) {
            current!.rules.push({ type: "note", commentRaw: text });
            return;
          }
          const bool = parseBooleanRow(text, credits);
          if (bool) { current!.rules.push(...bool); if (!indented) collector = null; return; }

          const rule = classifyComment(text);
          current!.rules.push(rule);
          // INDENTATION IS THE BOUNDARY of an option list. The bulletin writes
          // "Select 6 credits of the following:" and indents the options under
          // it, and some of those options are prose we cannot read ("EDTHP at
          // the 400 level") sitting above ones we can. Closing the list on the
          // first such row orphaned every course below it into the section,
          // leaving the requirement itself with an empty list -- which reads
          // as "no course qualifies" -- while the orphans looked like
          // separately REQUIRED courses. An indented row is a member of the
          // open list; only a non-indented row ends it.
          if (rule.type === "selectCredits" || rule.type === "chooseN") collector = rule;
          else if (!indented) collector = null;
          if ((rule.type === "selectCredits" || rule.type === "chooseN") && credits !== null && rule.credits === null) rule.credits = credits;
          if (rule.type === "unstructured") needsReview.push({ heading: current!.heading, text });
          return;
        }

        needsReview.push({ heading: current!.heading, text: rowText });
        current!.rules.push({ type: "unstructured", commentRaw: rowText });
      });

    push();
  });

  // Section credit subtotals often appear in the heading text, e.g.
  // "Prescribed Courses (42 credits)" — capture when present.
  for (const s of sections) {
    const m = /\((\d+(?:\.\d+)?)\s*credits?\)/i.exec(s.heading) ?? /:\s*(\d+(?:\.\d+)?)\s*credits?/i.exec(s.heading);
    if (m) s.creditsRequired = parseFloat(m[1]);
  }

  return { sections, needsReview };
}
