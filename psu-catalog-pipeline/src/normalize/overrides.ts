/** Merge department-published elective lists (data/overrides/electives.json)
 * into requirement rules whose bulletin text points at an external list
 * ("Select 15 credits from the department Foundational Elective List").
 * Sources are department sites (e.g. esm.psu.edu); each override records its
 * URL. Raw bulletin text is never modified — only rule.from is filled in. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Program } from "../validate/schemas.js";

interface OverrideEntry {
  commentContains: string;
  courses: string[];
  source: string;
}

const overridesPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "overrides", "electives.json",
);

let cache: Record<string, OverrideEntry[]> | null = null;
function load(): Record<string, OverrideEntry[]> {
  if (!cache) {
    cache = fs.existsSync(overridesPath)
      ? (JSON.parse(fs.readFileSync(overridesPath, "utf-8")) as Record<string, OverrideEntry[]>)
      : {};
  }
  return cache;
}

export function applyOverrides(program: Program): void {
  const entries = load()[program.slug];
  if (!entries) return;
  for (const section of program.requirementSections) {
    for (const rule of section.rules) {
      if (rule.type !== "selectCredits" || rule.from !== null) continue;
      const match = entries.find((e) => rule.commentRaw.toLowerCase().includes(e.commentContains.toLowerCase()));
      if (match) {
        rule.from = { kind: "courses", courses: match.courses };
        section.llmNormalized = false;
      }
    }
  }
}
