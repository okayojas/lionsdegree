/** Parse a subject course-descriptions page (div.courseblock structure,
 * verified against live HTML 2026-07-11) into Course records. */
import * as cheerio from "cheerio";
import { normDisplayCode, splitCode, CODE_RE, normCode } from "../lib/codes.js";
import { parseCredits } from "../lib/credits.js";
import { parseMixedPrereqText, astComplete } from "../lib/prereq.js";
import type { Course } from "../validate/schemas.js";

const GENED_LABELS: Record<string, string> = {
  "Writing/Speaking": "GWS",
  "Writing and Speaking": "GWS",
  "Quantification": "GQ",
  "Arts": "GA",
  "Humanities": "GH",
  "Health and Wellness": "GHW",
  "Natural Sciences": "GN",
  "Social and Behavioral Scien": "GS",
  "Social and Behavioral Sciences": "GS",
  "Integrative: Interdomain": "Inter-Domain",
  "Integrative: Linked": "Linked",
  "US Cultures": "US",
  "International Cultures": "IL",
  "Writing Across the Curriculum": "WAC",
  "First-Year Engagement": "FYE",
  "First-Year Seminar": "FYS",
};

function clean(s: string): string {
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** Extract the gen-ed short code from an attribute line like
 * "General Education: Quantification (GQ)" — prefer the parenthesized code. */
function genEdFromLine(rest: string): string {
  const paren = /\(([A-Z-]{2,4})\)\s*$/.exec(rest);
  if (paren) return paren[1];
  return GENED_LABELS[clean(rest)] ?? clean(rest);
}

export function parseSubjectPage(html: string, opts: { level: "undergraduate" | "graduate"; pageUrl: string }): Course[] {
  const $ = cheerio.load(html);
  const out: Course[] = [];

  $("div.courseblock").each((_, el) => {
    const block = $(el);
    const codeTitle = clean(block.find(".courseblocktitle .course_codetitle").first().text());
    const m = /^(.+?):\s*(.*)$/.exec(codeTitle);
    if (!m) return;
    const display = clean(m[1]);
    const title = clean(m[2]);
    const code = normDisplayCode(display);
    if (!code) return;
    const split = splitCode(code);
    if (!split) return;

    const credits = clean(block.find(".courseblocktitle .course_credits").first().text());
    const description = clean(block.find(".courseblockmeta .courseblockdesc").text());

    let enforced: string | null = null;
    let concurrent: string | null = null;
    let prereqAdvisory: string | null = null;
    const genEd: string[] = [];
    const attributes: string[] = [];
    const crossListings: string[] = [];
    const extraRaw: string[] = [];

    block.find(".courseblockextra p").each((_, p) => {
      const text = clean($(p).text());
      if (!text) return;
      const labelled = /^(Enforced (?:Prerequisites?|Concurrent)(?: at Enrollment)?|Prerequisites?|Recommended Preparations?|Corequisites?|Concurrent(?: Courses)?|Cross-listed(?: with)?)\s*:?\s*(.*)$/is.exec(text);
      if (labelled) {
        const label = labelled[1].toLowerCase();
        const rest = clean(labelled[2]);
        if (label.startsWith("enforced prerequisite")) enforced = enforced ? enforced + "; " + rest : rest;
        else if (label.startsWith("enforced concurrent")) concurrent = concurrent ? concurrent + "; " + rest : rest;
        else if (label.startsWith("prerequisite")) prereqAdvisory = prereqAdvisory ? prereqAdvisory + "; " + rest : rest;
        else if (label.startsWith("cross-listed")) {
          CODE_RE.lastIndex = 0;
          let cm: RegExpExecArray | null;
          const cleanRest = rest.replace(/ /g, " ");
          while ((cm = CODE_RE.exec(cleanRest)) !== null) crossListings.push(normCode(cm[1], cm[2]));
        } else extraRaw.push(text);
        return;
      }
      const attr = /^(General Education|Bachelor of Arts|GenEd Learning Objective|International Cultures|United States Cultures|Writing Across the Curriculum|First-Year Engagement|First-Year Seminar|Honors)\s*:?\s*(.*)$/i.exec(text);
      if (attr) {
        const kind = attr[1].toLowerCase();
        const rest = clean(attr[2]);
        if (kind === "general education") genEd.push(genEdFromLine(rest));
        else if (kind === "gened learning objective") attributes.push("GLO: " + rest);
        else if (kind === "bachelor of arts") attributes.push("BA: " + rest);
        else attributes.push(rest ? attr[1] + ": " + rest : attr[1]);
        return;
      }
      extraRaw.push(text);
    });

    // Mixed parsing handles labels embedded mid-text ("... or Enforced
    // Concurrent at Enrollment: X") by wrapping those segments in
    // `concurrent` AST nodes — 197 bulletin courses use this form.
    const prereqAst = enforced ? parseMixedPrereqText(enforced, false) : null;
    const concurrentAst = concurrent ? parseMixedPrereqText(concurrent, true) : null;
    const complete = (prereqAst ? astComplete(prereqAst) : true) && (concurrentAst ? astComplete(concurrentAst) : true);

    const aliases = [code];
    if (display !== code) {
      const dispNorm = clean(display);
      if (!aliases.includes(dispNorm)) aliases.push(dispNorm);
    }

    out.push({
      code,
      subject: split.subject,
      number: split.number,
      display,
      title,
      credits,
      creditsParsed: parseCredits(credits),
      description,
      enforced,
      concurrent,
      prereqAdvisory,
      prereqAst,
      concurrentAst,
      astComplete: complete,
      genEd: [...new Set(genEd)],
      attributes,
      crossListings: [...new Set(crossListings)],
      aliases,
      level: opts.level,
      url: opts.pageUrl,
      extraRaw,
    });
  });

  return out;
}
