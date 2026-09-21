import * as cheerio from "cheerio";
import { fetchPage } from "../lib/fetcher.js";
import { config } from "../config.js";
import type { ProgramLink } from "../validate/schemas.js";

/** The /programs/ index is server-rendered (verified 2026-07-11):
 * ul.isotope > li.item > a[href] with span.title + span.keyword children. */
export async function discoverPrograms(edition: string): Promise<ProgramLink[]> {
  const { html } = await fetchPage(config.paths.programsIndex, { edition });
  const $ = cheerio.load(html);
  const out: ProgramLink[] = [];
  const seen = new Set<string>();

  $("li.item a[href]").each((_, a) => {
    const href = $(a).attr("href")!;
    if (!/^\/(undergraduate|graduate)\//.test(href) || seen.has(href)) return;
    seen.add(href);
    const title = $(a).find("span.title").first().text().trim();
    if (!title) return;
    const keywords = $(a)
      .find("span.keyword")
      .map((_, k) => $(k).text().trim())
      .get();
    // Slug must be unique across campuses: accounting-bs exists at Abington,
    // Smeal, Behrend... so prefix with the college/campus path segment.
    const parts = href.replace(/\/$/, "").split("/").filter(Boolean);
    const tail = parts[parts.length - 1];
    const college = parts.length >= 3 ? parts[parts.length - 2] : null;
    const slug = college && college !== "undergraduate" && college !== "graduate" ? `${college}-${tail}` : tail;
    let type: ProgramLink["type"];
    if (/-minor$/.test(slug) || /minor/i.test(title)) type = "minor";
    else if (/certificate/.test(slug) || /certificate/i.test(title)) type = "certificate";
    else type = "major";
    out.push({ url: href, slug, title, keywords, type });
  });

  return out;
}
