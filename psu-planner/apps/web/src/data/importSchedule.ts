/** Extract PSU course codes from an uploaded schedule — .xlsx/.csv/.tsv/.txt
 * files or pasted text (e.g. a degree-audit export or a personal spreadsheet).
 * SheetJS is lazy-loaded so the main bundle stays lean. */
import { CODE_RE, normCode } from "@psu-planner/engine";

export function extractCodesFromText(text: string): string[] {
  const codes: string[] = [];
  CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const cleaned = text.replace(/ /g, " ");
  while ((m = CODE_RE.exec(cleaned)) !== null) {
    // Skip obvious false positives: a "code" whose subject is a common word.
    const subj = m[1].toUpperCase();
    if (["LEVEL", "SPRING", "FALL", "SUMMER", "YEAR", "ROOM", "THE", "OF", "AND", "OR", "TO"].includes(subj)) continue;
    codes.push(normCode(m[1], m[2]));
  }
  return [...new Set(codes)];
}

export async function fileToText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    let text = "";
    for (const sheetName of wb.SheetNames) {
      text += XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]) + "\n";
    }
    return text;
  }
  return file.text();
}

export async function extractCodesFromFile(file: File): Promise<string[]> {
  return extractCodesFromText(await fileToText(file));
}

/* ---------- term-aware extraction ---------- */

export interface TermRef {
  season: "Spring" | "Summer" | "Fall";
  year: number;
}
export interface ScheduleEntry {
  code: string;
  term: TermRef | null;
}

/** Chronological key: Spring < Summer < Fall within a year. */
export function termKey(t: TermRef): number {
  return t.year * 3 + (t.season === "Spring" ? 0 : t.season === "Summer" ? 1 : 2);
}

/** The academic term "now" falls in (used to split completed vs upcoming). */
export function currentTermKey(now = new Date()): number {
  const m = now.getMonth(); // 0-based
  const season: TermRef["season"] = m <= 4 ? "Spring" : m <= 7 ? "Summer" : "Fall";
  return termKey({ season, year: now.getFullYear() });
}

const TERM_RE = /\b(fall|autumn|spring|summer|fa|sp|su)\s*[.'-]?\s*(20\d{2}|\d{2})\b/gi;

function normTerm(season: string, yearStr: string): TermRef {
  const s = season.toLowerCase();
  const year = yearStr.length === 2 ? 2000 + parseInt(yearStr, 10) : parseInt(yearStr, 10);
  return {
    season: s.startsWith("f") || s.startsWith("a") ? "Fall" : s.startsWith("sp") ? "Spring" : "Summer",
    year,
  };
}

/** Parse a schedule line-by-line, carrying the most recent term heading as
 * context: codes under "Fall 2025" belong to Fall 2025 until the next term
 * label appears. Codes with no term context get term: null. */
export function extractSchedule(text: string): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  const seen = new Set<string>();
  let current: TermRef | null = null;
  for (const rawLine of text.replace(/ /g, " ").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Term label(s) on this line update the context (last one wins for
    // side-by-side layouts we can't disambiguate).
    TERM_RE.lastIndex = 0;
    let tm: RegExpExecArray | null;
    while ((tm = TERM_RE.exec(line)) !== null) current = normTerm(tm[1], tm[2]);
    for (const code of extractCodesFromText(line)) {
      if (seen.has(code)) continue;
      seen.add(code);
      entries.push({ code, term: current });
    }
  }
  return entries;
}
