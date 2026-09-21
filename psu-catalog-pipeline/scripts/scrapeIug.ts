/** Scrape the STRUCTURED IUG programs (Integrated Undergraduate-Graduate) from
 * the GRADUATE bulletin — deterministic parse of the raw HTML, no LLM output
 * (iron rule 1; see docs/iug-programs.md for the research that located these
 * pages and DECISIONS.md §2.5 for why LLM transcription is banned).
 *
 * v1 scope: the three deep-verified IUGs (Smeal Integrated MAcc, Smeal
 * B.S. Science + M.B.A., ESM's Engineering Science B.S.+M.S.). The remaining
 * ~38 filter_7-tagged programs come later — this script's IUGS config is the
 * extension point.
 *
 * Graduate program pages are CourseLeaf like everything else:
 *   #degreerequirementstextcontainer            -> master's requirement tables
 *   #integratedundergradgradprogramstextcontainer -> IUG rules + double-count list
 *
 * Output: data/out/<edition>/iug/{slug}.json
 * Run: npx tsx scripts/scrapeIug.ts [--edition 2025-2026] [--force]
 */
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { config } from "../src/config.js";
import { fetchPage } from "../src/lib/fetcher.js";
import { parseRequirementTables } from "../src/parse/programRequirements.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const edition = arg("edition") ?? config.edition;
const force = process.argv.includes("--force");
const outDir = path.join(config.outDir(edition), "iug");

/** The structured IUGs and how they pair with our undergrad program slugs.
 * gradDegree/pairsWith are configuration (verified against the bulletin index,
 * docs/iug-programs.md) — everything course-level is parsed from the page. */
const IUGS = [
  {
    slug: "smeal-integrated-macc",
    urlPath: "/graduate/programs/majors/accounting-smeal/",
    gradDegree: "Master of Accounting (M.Acc.)",
    college: "Smeal College of Business",
    campus: "University Park",
    pairsWith: ["smeal-business-accounting-bs"],
  },
  {
    slug: "smeal-science-bs-mba",
    urlPath: "/graduate/programs/majors/business-administration-smeal-professional/",
    gradDegree: "M.B.A. in Business Administration",
    college: "Smeal College of Business × Eberly College of Science",
    campus: "University Park",
    pairsWith: ["eberly-science-science-bs-business-administration-mba"],
  },
  {
    slug: "esm-esc-bs-ms",
    urlPath: "/graduate/programs/majors/engineering-science-mechanics/",
    gradDegree: "M.S. in Engineering Science and Mechanics",
    college: "College of Engineering (ESM)",
    campus: "University Park",
    pairsWith: ["engineering-engineering-science-bs"],
  },
] as const;

/** Course-code regex consistent with the rest of the pipeline: uppercase-only
 * subject (with optional hyphen/space parts) + 1-3 digits + optional letter
 * suffix. Wildcards rejected (see DECISIONS.md §2.4). */
const CODE_RE = /\b([A-Z][A-Z-]{1,7}(?:\s?[A-Z]{1,5})?)\s(\d{1,3}[A-Z]{0,2})\b/g;

function codesInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CODE_RE)) {
    const num = m[2];
    if (!/^\d/.test(num)) continue;
    out.add(`${m[1].replace(/-/g, "")} ${num}`.replace(/\s+/g, " "));
  }
  return [...out];
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const index: { slug: string; name: string; gradDegree: string; college: string; campus: string; pairsWith: string[] }[] = [];
  for (const iug of IUGS) {
    const { html, fromCache } = await fetchPage(iug.urlPath, { edition, force });
    const $ = cheerio.load(html);
    const name = $("h1.page-title, h1").first().text().trim() || iug.slug;

    // ---- Master's degree requirements (deterministic table parse) ----------
    const degreeContainer = $("#degreerequirementstextcontainer");
    const degreeHtml = degreeContainer.length ? cheerio.load(degreeContainer.html() ?? "").html() : "";
    const requirements = degreeHtml ? parseRequirementTables(degreeHtml) : { sections: [], needsReview: [] };
    const degreeText = degreeContainer.text().replace(/\s+/g, " ").trim();
    const totalCreditsMatch = /(?:minimum of|requires)\s+(\d{2})\s+credits/i.exec(degreeText);

    // ---- IUG section: rules + double-count table ----------------------------
    const iugContainer = $("#integratedundergradgradprogramstextcontainer");
    const iugText = iugContainer.text().replace(/\s+/g, " ").trim();
    const maxDcMatch = /up to\s+(\d{1,2})\s+credits may be double-counted/i.exec(iugText);
    // Eligible double-count courses: parse the IUG container's own courselist
    // tables; fall back to codes named in its prose.
    const iugHtml = iugContainer.length ? cheerio.load(iugContainer.html() ?? "").html() : "";
    const iugParsed = iugHtml ? parseRequirementTables(iugHtml) : { sections: [], needsReview: [] };
    const eligibleFromTables = new Set<string>();
    for (const sec of iugParsed.sections) {
      for (const rule of sec.rules) {
        if (rule.type === "course") eligibleFromTables.add(rule.code);
        else if (rule.type === "oneOf" || rule.type === "chooseN") rule.options.forEach((c) => eligibleFromTables.add(c));
        else if (rule.type === "selectCredits" && rule.from?.kind === "courses") rule.from.courses.forEach((c) => eligibleFromTables.add(c));
      }
    }
    const doubleCountEligible = eligibleFromTables.size ? [...eligibleFromTables] : codesInText(iugText);

    if (!iugContainer.length) {
      console.warn(`[scrapeIug] WARNING: ${iug.slug} has no IUG container — page layout changed?`);
    }

    // Grad pages stack multiple degree options in ONE container (M.B.A. then
    // D.B.A.; ESM's category menu / thesis / non-thesis tracks). Group the
    // parsed sections into TRACKS at each "Total Credits" boundary row so the
    // engine can pick the right one and never ingest the D.B.A. by accident.
    type Section = (typeof requirements.sections)[number];
    const gradTracks: { sections: Section[]; totalCredits: number | null }[] = [];
    let cur: Section[] = [];
    for (const sec of requirements.sections) {
      cur.push(sec);
      for (const rule of sec.rules) {
        const m = rule.type === "unstructured" && /^Total Credits(\d+)/.exec(rule.commentRaw ?? "");
        if (m) {
          gradTracks.push({ sections: cur, totalCredits: parseInt(m[1], 10) });
          cur = [];
          break;
        }
      }
    }
    if (cur.length) gradTracks.push({ sections: cur, totalCredits: null });

    const record = {
      slug: iug.slug,
      name,
      gradDegree: iug.gradDegree,
      college: iug.college,
      campus: iug.campus,
      pairsWith: iug.pairsWith,
      sourceUrl: config.baseUrl + iug.urlPath,
      edition,
      totalGradCredits: totalCreditsMatch ? parseInt(totalCreditsMatch[1], 10) : null,
      doubleCount: {
        maxCredits: maxDcMatch ? parseInt(maxDcMatch[1], 10) : 12,
        minHalfAt500Level: /50%|50 percent/i.test(iugText),
        eligible: doubleCountEligible.sort(),
      },
      /** GCAC-210 gates, restated on most program pages; kept as display text. */
      applyText: iugText.slice(0, 1200) || null,
      gradTracks,
      needsReview: requirements.needsReview,
    };
    fs.writeFileSync(path.join(outDir, `${iug.slug}.json`), JSON.stringify(record, null, 2));
    console.log(`[scrapeIug] ${iug.slug}${fromCache ? " (cache)" : ""}: ${gradTracks.length} track(s) [${gradTracks.map((t) => t.totalCredits ?? "?").join(", ")}cr], ` +
      `${record.doubleCount.eligible.length} double-count-eligible, max ${record.doubleCount.maxCredits}cr, total ${record.totalGradCredits ?? "?"}cr`);
    index.push({ slug: iug.slug, name, gradDegree: iug.gradDegree, college: iug.college, campus: iug.campus, pairsWith: [...iug.pairsWith] });
  }
  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 2));
  console.log(`[scrapeIug] wrote iug/index.json (${index.length} programs)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
