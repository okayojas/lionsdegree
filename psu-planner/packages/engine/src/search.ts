/** Catalog search. Port of the demo's scorer (L676-727), parameterized on
 * catalog. Designed to run inside a Web Worker over the full ~10k-course
 * catalog. */
import type { Catalog } from "./types.js";

const STOP = new Set("a an the and or of in to for with on by is are as its this that at from".split(" "));

export function stem(t: string): string {
  return t.length > 3 ? t.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : "")) : t;
}
export function qterms(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)).map(stem);
}
function toks(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
}
function hasRun(tokens: string[], stems: string[]): boolean {
  outer: for (let i = 0; i + stems.length <= tokens.length; i++) {
    for (let j = 0; j < stems.length; j++) {
      if (!tokens[i + j].startsWith(stems[j])) continue outer;
    }
    return true;
  }
  return false;
}

export function searchCatalog(catalog: Catalog, q: string, limit = 25): string[] {
  const stems = qterms(q);
  if (!stems.length) return [];
  const res: { key: string; score: number }[] = [];
  const visited = new Set<string>();
  for (const key in catalog) {
    const c = catalog[key];
    if (visited.has(c.code)) continue;
    visited.add(c.code);
    const code = (c.code + " " + (c.display || "")).toLowerCase();
    const title = (c.title || "").toLowerCase();
    const desc = (c.description || "").toLowerCase();
    let score = 0;
    let ok = true;
    let inTitleAll = true;
    for (const t of stems) {
      let s = 0;
      if (code.includes(t)) s += 8;
      if (title.includes(t)) s += 6;
      else inTitleAll = false;
      const n = desc.split(t).length - 1;
      s += Math.min(n, 5);
      if (!s) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    if (inTitleAll) score += 8;
    const tTok = toks(title);
    if (stems.length > 1 && hasRun(tTok, stems)) score += 14;
    else if (stems.length > 1 && hasRun(toks(desc).slice(0, 400), stems)) score += 7;
    if (tTok.length === stems.length && inTitleAll) score += 15;
    res.push({ key: c.code, score });
  }
  res.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return res.slice(0, limit).map((r) => r.key);
}

/** Highlightable snippet around the first stem match; returns plain text plus
 * match ranges so the view layer can render <mark> safely. */
export function snippet(desc: string, stems: string[]): { text: string; ranges: [number, number][] } {
  const low = desc.toLowerCase();
  let pos = -1;
  for (const t of stems) {
    const i = low.indexOf(t);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) return { text: desc.slice(0, 130) + "…", ranges: [] };
  const start = Math.max(0, pos - 40);
  const end = Math.min(desc.length, pos + 120);
  const text = (start > 0 ? "…" : "") + desc.slice(start, end) + (end < desc.length ? "…" : "");
  const ranges: [number, number][] = [];
  const lowText = text.toLowerCase();
  for (const t of stems) {
    let i = 0;
    while ((i = lowText.indexOf(t, i)) >= 0) {
      let e = i + t.length;
      while (e < text.length && /[a-z]/i.test(text[e])) e++;
      ranges.push([i, e]);
      i = e;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return { text, ranges };
}
