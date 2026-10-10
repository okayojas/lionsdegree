/** Catalog search. Port of the demo's scorer (L676-727), parameterized on
 * catalog. Designed to run inside a Web Worker over the full ~10k-course
 * catalog. */
import type { Catalog, Course } from "./types.js";
import { decodePostings, prefixRange, type SearchIndexFile } from "./postings.js";

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


/** The shared term dictionary of the loaded search index, sorted ascending.
 *
 * Module-level because it belongs to the catalog as a whole rather than to any
 * one course, and `searchCatalog` takes a Catalog (a map of Courses) with
 * nowhere to hang it. Set by `hydrateSearchIndex`; empty until then, which
 * makes every description count zero -- search still works off code and title,
 * it just loses the body signal. That is the honest degradation: a catalog
 * built from subject files rather than the index has no postings. */
let DICT: readonly string[] = [];

/** Decoded postings per course code, built once at hydrate. */
const POSTINGS = new Map<string, Map<number, number>>();

export function loadSearchDictionary(terms: readonly string[]): void {
  DICT = terms;
}

/** Per-query memo: a stem resolves to the same dictionary ids for every course
 * it is tested against, and resolving is a binary search plus a scan. */
let prefixMemo = new Map<string, number[]>();

function idsFor(stem: string): number[] {
  let ids = prefixMemo.get(stem);
  if (!ids) {
    const [lo, hi] = prefixRange(DICT, stem);
    ids = [];
    for (let i = lo; i < hi; i++) ids.push(i);
    prefixMemo.set(stem, ids);
  }
  return ids;
}

/** How often `stem` occurs in a course's description, by PREFIX.
 *
 * The old scorer counted substrings, so a stem of "statistic" also matched
 * "statistics" and "statistical". Summing every dictionary entry that starts
 * with the stem reproduces that, minus infix matches ("stat" no longer hits
 * inside "thermostat") -- which is a behaviour change in the right direction. */
function descCount(c: Course, stem: string): number {
  const p = POSTINGS.get(c.code);
  if (!p || !DICT.length) return 0;
  let n = 0;
  for (const id of idsFor(stem)) n += p.get(id) ?? 0;
  return n;
}

export function searchCatalog(catalog: Catalog, q: string, limit = 25): string[] {
  const stems = qterms(q);
  if (!stems.length) return [];
  prefixMemo = new Map();
  const res: { key: string; score: number }[] = [];
  const visited = new Set<string>();
  for (const key in catalog) {
    const c = catalog[key];
    if (visited.has(c.code)) continue;
    visited.add(c.code);
    const code = (c.code + " " + (c.display || "")).toLowerCase();
    const title = (c.title || "").toLowerCase();
    let score = 0;
    let ok = true;
    let inTitleAll = true;
    for (const t of stems) {
      let s = 0;
      if (code.includes(t)) s += 8;
      if (title.includes(t)) s += 6;
      else inTitleAll = false;
      s += Math.min(descCount(c, t), 5);
      if (!s) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    if (inTitleAll) score += 8;
    const tTok = toks(title);
    // Phrase matching survives only on the TITLE. The description's +7 run
    // bonus needed word order, and word order is the one part of an index that
    // edges toward reconstructable prose. Measured cost of dropping it: 2
    // points of top-25 agreement (88.9% -> 86.9%). Cheap, for a guarantee that
    // the shipped bytes cannot be reassembled into sentences.
    if (stems.length > 1 && hasRun(tTok, stems)) score += 14;
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

/** Restore whole Course objects from the slim search index.
 *
 * The index omits empty fields -- `"crossListings":[]` on most courses,
 * `"concurrent":null` on nearly all -- because the key names repeat once per
 * course and that adds up across ~14,600 of them. It also omits the common
 * `level` and the bulletin `url`. Consumers should never have to know that, so
 * everything is filled back in here and they receive ordinary Courses.
 *
 * The index carries NO description prose. It carries postings -- per-term
 * counts over the description -- which is what the scorer always consumed
 * (postings.ts, DECISIONS.md 5.1). Decoding them is this function's second
 * job: the dictionary is shared across the whole file, so it is loaded once
 * here rather than threaded through every call.
 *
 * Accepts both shapes. A bare array is the pre-postings index, which hydrates
 * with no body signal rather than throwing -- an old cached index in a service
 * worker should degrade to code-and-title search, not break the page. */
export function hydrateSearchIndex(raw: unknown[] | SearchIndexFile): Course[] {
  const file = Array.isArray(raw) ? { terms: [], courses: raw } : raw;
  loadSearchDictionary(file.terms ?? []);
  POSTINGS.clear();
  for (const entry of file.courses) {
    const e = entry as { code?: string; t?: number[] };
    if (e.code && e.t?.length) POSTINGS.set(e.code, decodePostings(e.t));
  }
  return (file.courses as Partial<Course>[]).map((c) => ({
    code: c.code ?? "",
    subject: c.subject ?? "",
    number: c.number ?? "",
    display: c.display ?? c.code ?? "",
    title: c.title ?? "",
    credits: c.credits ?? "",
    creditsParsed: c.creditsParsed ?? null,
    // Empty by construction from the index: the prose is not shipped. A card
    // that wants it fetches the course's own file, which the client no longer
    // publishes either -- it shows keywords and links to the Bulletin.
    description: c.description ?? "",
    keywords: c.keywords ?? [],
    enforced: c.enforced ?? null,
    concurrent: c.concurrent ?? null,
    prereqAdvisory: c.prereqAdvisory ?? null,
    prereqAst: c.prereqAst ?? null,
    concurrentAst: c.concurrentAst ?? null,
    astComplete: c.astComplete ?? true,
    genEd: c.genEd ?? [],
    attributes: c.attributes ?? [],
    crossListings: c.crossListings ?? [],
    aliases: c.aliases ?? [],
    level: c.level ?? "undergraduate",
    url: c.url ?? "",
  }));
}
