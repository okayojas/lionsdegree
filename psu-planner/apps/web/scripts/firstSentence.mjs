/** The one sentence of Penn State's course description we publish.
 *
 * WHY ONE SENTENCE AND NOT NONE. The published catalog carries no course
 * descriptions (see `stripDescriptions`): they are Penn State's prose and
 * shipping the bytes is distribution whether or not we render them. What
 * replaced them for a student was `keywords` — eight words extracted from
 * the description — and measured against the real catalog they read badly:
 *
 *   MUSIC 4     hollywood, narrative, eras, scene, extent, premier, …
 *   PSYCH 100   cognition, behavior, mental, sensation, discipline, …
 *
 * "extent", "premier", "discipline" are extraction noise, and a bag of
 * eight words is not a sentence. The Bulletin's own opening sentence
 * almost always says what the course is:
 *
 *   "An introductory examination of music's role in Hollywood narrative
 *    film from the classic era (1930s and 1940s) to the present."
 *
 * So one sentence is published, in quotes, attributed, beside the link to
 * the full entry. That is a deliberate narrowing of DECISIONS.md 5.1 and
 * not an accident: the rest of the description still never leaves the
 * build, and the guard in packages/mcp/scripts/sync-catalog.mjs is what
 * keeps a parser regression from quietly turning "one sentence" into a
 * paragraph.
 *
 * MEASURED over the 14,493 descriptions in the 2026-2027 edition before
 * any of this was written. A naive split on ". " gets the length right
 * (p50 127 characters, p90 187) and three things wrong:
 *
 *   107 cut at an abbreviation   "…modern languages (e.g."
 *                                "…the post-abolition period from the U.S."
 *    41 run past 400 characters  run-on openers with embedded lists
 *   477 come back under 25       "Is \"race\" real?" — a real sentence,
 *                                but it describes nothing
 *
 * The first is a parsing bug and is fixed below. The other two are not
 * bugs; they are sentences we should decline to use, so the bounds reject
 * them and the caller falls back to keywords. Nothing is truncated: a
 * half-quoted sentence attributed to Penn State would be worse than no
 * quote at all.
 */

/** Abbreviations whose full stop does not end a sentence.
 *
 * Case-sensitive where case carries meaning ("No." the number, "no." the
 * word) and matched against the token immediately before the period. */
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "vs", "cf", "al", "ca", "approx", "est", "incl",
  "Dr", "Mr", "Mrs", "Ms", "Prof", "Sr", "Jr", "St", "Ave", "Dept",
  "Ph.D", "Ed.D", "M.D", "M.S", "M.A", "B.S", "B.A", "D.V.M", "J.D",
  "U.S", "U.S.A", "U.K", "E.U",
  "No", "Vol", "Ch", "pp", "Fig", "Eq", "Sec", "Art",
  "cr", "hr", "hrs", "min", "max", "wk", "yr", "Jan", "Feb", "Mar", "Apr",
  "Jun", "Jul", "Aug", "Sept", "Sep", "Oct", "Nov", "Dec",
]);

/** Shortest sentence worth publishing, and longest.
 *
 * The floor is not about grammar. "Life is social." and "Is \"race\"
 * real?" are perfectly good sentences that tell a student nothing about
 * the course, and 477 descriptions open that way; below this they are
 * declined and the keywords show instead. The ceiling catches run-on
 * openers that are really three sentences with semicolons — quoting 600
 * characters is republishing the description, which is the thing this
 * module exists to avoid. */
export const MIN_SUMMARY = 40;
export const MAX_SUMMARY = 400;

/** Is the period at `i` the end of a sentence, or part of a token? */
function endsSentence(text, i) {
  const ch = text[i];
  if (ch === "!" || ch === "?") return true;

  // A decimal point: "3.5 credits". Digits either side, never an ending.
  if (/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) return false;

  // INSIDE A DOTTED ABBREVIATION, structurally rather than by name. The
  // period of "Ph.D." sits after "Ph", which is neither a lone initial nor
  // a word anybody would list, so a name-based rule means adding "Ph",
  // then "Ed", then whatever the Bulletin uses next.
  //
  // What actually distinguishes it is what FOLLOWS: a single letter and
  // another period. "Ph.D." matches; "cities.Students" — the Bulletin
  // splicing two blocks together with no space — does not, and still ends
  // a sentence as it should.
  if (/^[A-Za-z]\./.test(text.slice(i + 1, i + 3))) return false;

  // The token the period closes. Letters, digits and interior dots, so
  // "U.S" and "Ph.D" arrive here whole rather than as "S" and "D".
  const before = /([A-Za-z][A-Za-z0-9.]*)$/.exec(text.slice(0, i));
  if (before) {
    const token = before[1].replace(/\.$/, "");
    if (ABBREVIATIONS.has(token)) return false;
    // A LONE LETTER, either case, and the case matters more than it looks.
    // "e.g." reaches here at its FIRST period, where everything before is
    // just "e" — so an uppercase-only rule let "…various modern languages
    // (e." through as a finished sentence. Lowercase covers that; capitals
    // cover initials like "J. Smith".
    //
    // The cost is a sentence that genuinely ends on a single letter ("the
    // highest grade is an A.") running on to the next terminator. That is
    // a longer quote, not a wrong one, and it is far rarer than "e.g.".
    if (/^[A-Za-z]$/.test(token)) return false;
  }
  return true;
}

/** The Bulletin's opening sentence, or `null` when there is not a usable
 * one.
 *
 * NULL RATHER THAN A BEST EFFORT. The caller falls back to keywords, which
 * is a worse answer but an honest one; a truncated or mis-split sentence
 * published in quotes under Penn State's name is a wrong answer wearing a
 * citation. Iron rule 2, applied to prose. */
export function firstSentence(description) {
  if (typeof description !== "string") return null;
  const text = description.replace(/\s+/g, " ").trim();
  if (!text) return null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    // The terminator must be followed by whitespace or be the very end;
    // "cities.Students" is the Bulletin splicing two blocks together, and
    // the sentence does end there.
    const next = text[i + 1];
    if (next !== undefined && next !== " " && !/[A-Z"']/.test(next)) continue;
    if (!endsSentence(text, i)) continue;

    const sentence = text.slice(0, i + 1).trim();
    if (sentence.length > MAX_SUMMARY) return null;
    return sentence.length >= MIN_SUMMARY ? sentence : null;
  }

  // No terminator at all: a description that is one unpunctuated clause.
  return text.length >= MIN_SUMMARY && text.length <= MAX_SUMMARY ? text : null;
}
