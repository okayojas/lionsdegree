import * as cheerio from "cheerio";
import { config } from "../config.js";
import { parseRequirementTables } from "./programRequirements.js";
import { parsePlanGrids } from "./suggestedPlan.js";
import type { Program, ProgramLink } from "../validate/schemas.js";

const DEGREE_RE = /-(bs|ba|bfa|bm|bme|bdes|bae|bsed|basc|bhum|bph|bsb|minor|certificate)$/;

function campusesFromKeywords(keywords: string[]): string[] {
  return keywords.filter((k) => /^Penn State /.test(k)).map((k) => k.replace(/^Penn State /, ""));
}

export function parseProgramPage(
  html: string,
  link: ProgramLink,
): { program: Program; needsReview: { heading: string; text: string }[] } {
  const $ = cheerio.load(html);
  const name = $("h1").first().text().replace(/ /g, " ").trim() || link.title;

  // College from the breadcrumb-ish URL: /undergraduate/colleges/<college>/...
  const collegeSlug = /\/colleges\/([a-z-]+)\//.exec(link.url)?.[1] ?? null;

  const { sections, needsReview } = parseRequirementTables(html);
  const suggestedPlans = parsePlanGrids(html);

  // "a minimum of 127 credits is required" in the requirements intro.
  let totalCredits: number | null = null;
  const reqIntro = $("#programrequirementstextcontainer").text();
  const m = /minimum of\s+(\d+)\s+credits/i.exec(reqIntro);
  if (m) totalCredits = parseInt(m[1], 10);

  const degree = DEGREE_RE.exec(link.slug)?.[1]?.toUpperCase() ?? null;

  const program: Program = {
    slug: link.slug,
    name,
    type: link.type,
    degree: degree === "MINOR" || degree === "CERTIFICATE" ? null : degree,
    college: collegeSlug,
    campuses: campusesFromKeywords(link.keywords),
    url: config.baseUrl + link.url,
    totalCredits,
    requirementSections: sections,
    suggestedPlans,
  };
  return { program, needsReview };
}
