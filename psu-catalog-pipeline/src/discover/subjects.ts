import * as cheerio from "cheerio";
import { fetchPage } from "../lib/fetcher.js";
import { config } from "../config.js";

export interface SubjectLink {
  urlPath: string;
  name: string;
  prefix: string;
  level: "undergraduate" | "graduate";
}

export async function discoverSubjects(edition: string, level: "undergraduate" | "graduate"): Promise<SubjectLink[]> {
  const indexPath = level === "undergraduate" ? config.paths.subjectsIndexUG : config.paths.subjectsIndexGrad;
  const { html } = await fetchPage(indexPath, { edition });
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: SubjectLink[] = [];
  $(`a[href^="/university-course-descriptions/${level}/"]`).each((_, a) => {
    const href = $(a).attr("href")!;
    // Slug charset must include "-": A-I (Artificial Intelligence) and C-S are
    // hyphenated slugs that a [a-z_0-9]+ pattern silently skipped.
    const m = new RegExp(`^/university-course-descriptions/${level}/([a-z_0-9-]+)/$`).exec(href);
    if (!m || seen.has(href)) return;
    seen.add(href);
    const name = $(a).text().trim();
    const prefix = /\(([A-Z\s-]+)\)\s*$/.exec(name)?.[1] ?? m[1].toUpperCase();
    out.push({ urlPath: href, name, prefix, level });
  });
  return out;
}
