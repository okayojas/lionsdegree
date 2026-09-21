/** Parse table.sc_plangrid suggested-academic-plan grids.
 * Layout (verified 2026-07-11): Fall and Spring are SIDE BY SIDE — each body row
 * carries cells for both terms, distinguished by the `header` attribute
 * ("year0 year0_Term0_codecol" / "year0 year0_Term1_codecol"). Course codes are
 * taken from each cell link's `title` attribute (contains nbsp). */
import * as cheerio from "cheerio";
import { normDisplayCode } from "../lib/codes.js";
import { parseCodeListText } from "./programRequirements.js";
import type { PlanEntry, SuggestedPlan } from "../validate/schemas.js";

function clean(s: string): string {
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

interface TermBucket {
  year: number;
  termIndex: number;
  termName: string;
  entries: PlanEntry[];
  credits: number | null;
}

function classifyText(label: string, credits: number | null, footnotes: string[]): PlanEntry {
  // Domain may lead ("GHW course") or trail in parens ("General Education Course (GHW)").
  const genEdDomain =
    /^(GWS|GQ|GA|GH|GHW|GN|GS)\b/.exec(label)?.[1] ??
    /\((GWS|GQ|GA|GH|GHW|GN|GS)\)/.exec(label)?.[1] ??
    null;
  if (/general education/i.test(label) || genEdDomain) {
    return { type: "genEd", label, domain: genEdDomain, credits, footnotes };
  }
  return { type: "placeholder", label, credits, footnotes };
}

export function parsePlanGrids(html: string): SuggestedPlan[] {
  const $ = cheerio.load(html);
  const plans: SuggestedPlan[] = [];

  $("table.sc_plangrid").each((_, table) => {
    const $table = $(table);

    // Heading above the grid, e.g. "University Park (CMPSC_BS)".
    let campusLabel = "";
    let hops = 0;
    let node = $table.prev();
    while (node.length && hops < 8) {
      if (/^h[2-6]$/i.test(node.prop("tagName") ?? "")) {
        campusLabel = clean(node.text());
        break;
      }
      node = node.prev();
      hops++;
    }

    const termNames: Record<string, string> = {};
    $table.find("tr.plangridterm th.plangridtermhdr").each((_, th) => {
      const id = $(th).attr("id"); // e.g. year0_Term0_codecol
      const m = id && /^(year\d+_Term\d+)_codecol$/.exec(id);
      if (m) termNames[m[1]] = clean($(th).text());
    });

    const buckets = new Map<string, TermBucket>();
    const bucketFor = (key: string): TermBucket => {
      let b = buckets.get(key);
      if (!b) {
        const m = /^year(\d+)_Term(\d+)$/.exec(key)!;
        b = {
          year: parseInt(m[1], 10) + 1,
          termIndex: parseInt(m[2], 10),
          termName: termNames[key] ?? `Term ${m[2]}`,
          entries: [],
          credits: null,
        };
        buckets.set(key, b);
      }
      return b;
    };

    let totalCredits: number | null = null;

    $table.find("tbody tr").each((_, tr) => {
      const $tr = $(tr);
      const cls = $tr.attr("class") ?? "";

      if (cls.includes("plangridtotal")) {
        const m = /Total Credits\s+(\d+)/i.exec(clean($tr.text()));
        if (m) totalCredits = parseInt(m[1], 10);
        return;
      }

      $tr.find("td").each((_, td) => {
        const $td = $(td);
        const header = $td.attr("header") ?? "";
        const m = /(year\d+_Term\d+)_(codecol|hourscol)/.exec(header);
        if (!m) return;
        const key = m[1];

        if (m[2] === "hourscol") {
          if (cls.includes("plangridsum")) {
            const n = parseFloat(clean($td.text()));
            if (!Number.isNaN(n)) bucketFor(key).credits = n;
          } else {
            const b = bucketFor(key);
            const n = parseFloat(clean($td.text()));
            const last = b.entries[b.entries.length - 1];
            if (last && last.credits === null && !Number.isNaN(n)) last.credits = n;
          }
          return;
        }
        if (cls.includes("plangridsum")) return;

        const footnotes = $td
          .find("sup")
          .map((_, s) => clean($(s).text()))
          .get()
          .join("")
          .split("")
          .filter((c) => c.trim());
        const links = $td.find("a.code");
        const codes = links
          .map((_, a) => normDisplayCode(clean($(a).attr("title") ?? $(a).text())))
          .get()
          .filter((c): c is string => !!c);
        const cellTextNoSup = clean($td.clone().find("sup").remove().end().text());
        if (!cellTextNoSup) return;

        const b = bucketFor(key);
        if (codes.length >= 1) {
          // Multi-code cells are "CMPSC 121 or 131" choices; first code is the
          // default card, the rest become selectable alternatives.
          b.entries.push({ type: "course", code: codes[0], credits: null, footnotes, alternatives: codes.slice(1) });
        } else {
          // Some plan cells are course codes without links ("ESC 410").
          const textCodes = parseCodeListText(cellTextNoSup);
          if (textCodes) {
            b.entries.push({ type: "course", code: textCodes.codes[0], credits: null, footnotes, alternatives: textCodes.codes.slice(1) });
          } else {
            b.entries.push(classifyText(cellTextNoSup, null, footnotes));
          }
        }
      });
    });

    // Footnote definitions immediately after the table (dl.sc_footnotes).
    const footnotes: Record<string, string> = {};
    let sib = $table.next();
    let sibHops = 0;
    while (sib.length && sibHops < 4) {
      if (sib.is("dl.sc_footnotes")) {
        sib.find("dt").each((_, dt) => {
          const sym = clean($(dt).text());
          const def = clean($(dt).next("dd").text());
          if (sym) footnotes[sym] = def;
        });
        break;
      }
      sib = sib.next();
      sibHops++;
    }

    const semesters = [...buckets.values()]
      .sort((a, b) => a.year - b.year || a.termIndex - b.termIndex)
      .map((b) => ({
        year: b.year,
        term: b.termName,
        label: `Year ${b.year} ${b.termName}`,
        credits: b.credits,
        entries: b.entries,
      }));

    if (semesters.length) plans.push({ campusLabel, semesters, totalCredits, footnotes });
  });

  return plans;
}
