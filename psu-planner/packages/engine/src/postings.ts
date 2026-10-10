/** The search index's description signal, encoded.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Search used to score against the description prose itself, which meant the
 * prose had to ship: 10.4 MB of Penn State's writing downloaded by every
 * visitor. Codes, credits and prerequisites are facts and ours to republish;
 * a paragraph describing a course is the University's expression
 * (DECISIONS.md 5.1).
 *
 * The scorer never actually needed the prose. It asked exactly one question of
 * it: how many times does this term occur, capped at 5. That is a COUNT, and a
 * table of counts is a fact about the text rather than the text. So the
 * pipeline reads the descriptions at build time, emits counts, and the prose
 * stops at the build. That is the Authors Guild v. HathiTrust shape -- index
 * the full text, display none of it -- and the condition is that the prose
 * genuinely never ships. Shipping it and not rendering it is still
 * distribution; a devtools panel is one keystroke away.
 *
 * WHAT CANNOT BE RECOVERED FROM THIS
 *
 * Word order, sentences, punctuation, and any count above 5. What remains is
 * an unordered bag of lowercased tokens with small integers beside them. You
 * cannot reconstruct a sentence from it, which is the entire point.
 *
 * THE ENCODING
 *
 * A course's postings are a flat array of integers, which in JSON costs no key
 * names at all -- the difference between `[12,47,3]` and `{"recursion":2,...}`
 * repeated 14,615 times.
 *
 * Terms live in one shared, SORTED dictionary; a course stores term IDs. The
 * IDs of a course are sorted ascending and delta-encoded, so they stay small
 * and compress well. The count rides in the same integer as the delta, because
 * 80% of postings have a count of 1 and a parallel array of mostly-ones is
 * pure overhead:
 *
 *     value = delta * 5 + (count - 1)        count is 1..5, so count-1 is 0..4
 *
 * Sorted matters for a second reason: the scorer matches PREFIXES. `qterms`
 * stems "statistics" to "statistic", and the old substring test then matched
 * "statistics" and "statistical" too. A sorted dictionary makes that a binary
 * search for the prefix's lower bound plus a short forward scan, which is how
 * `prefixRange` below keeps the old behaviour without the old bytes.
 */

/** Counts above this are indistinguishable, matching the scorer's own cap. */
export const MAX_COUNT = 5;

export interface SearchIndexFile {
  /** Shared dictionary, sorted ascending. Posting IDs index into this. */
  terms: string[];
  /** One entry per course; `t` holds its encoded postings. */
  courses: unknown[];
}

/** Encode one course's {term id -> count} map. Ids need not arrive sorted. */
export function encodePostings(counts: Map<number, number>): number[] {
  const ids = [...counts.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  let prev = 0;
  for (const id of ids) {
    const n = Math.min(MAX_COUNT, Math.max(1, counts.get(id)!));
    out.push((id - prev) * MAX_COUNT + (n - 1));
    prev = id;
  }
  return out;
}

/** Decode back to {term id -> count}. Inverse of encodePostings. */
export function decodePostings(packed: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  let prev = 0;
  for (const v of packed) {
    const id = prev + Math.floor(v / MAX_COUNT);
    out.set(id, (v % MAX_COUNT) + 1);
    prev = id;
  }
  return out;
}

/**
 * Half-open range [lo, hi) of dictionary entries starting with `prefix`.
 *
 * Binary search for the lower bound, then walk forward while the prefix still
 * matches. Because `terms` is sorted, every match is contiguous: anything
 * starting with "statistic" sorts together, so the walk stops at the first
 * word that does not.
 */
export function prefixRange(terms: readonly string[], prefix: string): [number, number] {
  let lo = 0;
  let hi = terms.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (terms[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < terms.length && terms[end].startsWith(prefix)) end++;
  return [lo, end];
}
