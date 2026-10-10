/** What a course is ABOUT, extracted from its description.
 *
 * Why this exists at all: the shipped catalog is moving away from carrying
 * Penn State's description prose verbatim (DECISIONS.md 5.1). Course codes,
 * credits and prerequisites are facts and ours to republish; a thousand
 * characters of prose describing the course is the University's expression.
 * Keywords are the middle: extracted terms are facts ABOUT the text rather
 * than the text, and a student still gets told what the course covers.
 *
 * DETERMINISTIC, and that is not an implementation detail. Iron rule 1 --
 * nothing a language model wrote is ever written into the dataset -- is the
 * lesson of DECISIONS.md 2.5, where LLM transcription invented 48 elective
 * entries including two courses that do not exist at Penn State, and 46 of
 * the 48 were real courses merely not on that list, so referential integrity
 * could not see them. Generating 14,000 unreviewable summaries is that
 * failure with a bigger blast radius. Every term here is lifted from the
 * source bytes; the only judgement applied is which to keep.
 *
 * Four filters, in the order they matter:
 *  1. PART OF SPEECH. Nouns and adjectives only. Without this the output is
 *     about one-in-four stray verbs -- "pertaining", "comprehend", "judged",
 *     "intended" -- which is worse than useless on a surface that claims to
 *     say what a course is about. Tagged per OCCURRENCE, not per term: a
 *     corpus-wide vote drops "writing" (verbal 86% of the time overall, but
 *     nominal in every English course) and keeps "comprehend" at 51%.
 *  2. SUBJECT CODES. Descriptions name sibling courses, and tf-idf loves them
 *     because they are rare: MATH 140 scored "140a", "140b", "140h". Checked
 *     against the edition's own subject registry, the same source the
 *     phantom-code guard uses.
 *  3. DOCUMENT FREQUENCY. Below 3 is noise; above 12% of the corpus is
 *     boilerplate that describes no course in particular.
 *  4. TITLE WORDS. The title is already on screen. Repeating it back wastes
 *     the few slots a student actually reads.
 *
 * Known limit: a gerund in a bare list tags as a verb, because there is no
 * grammar around it to say otherwise. "...trees, sets, graphs, sorting." loses
 * "sorting". Accepted -- the alternative, a corpus vote, measured worse.
 */
import posTagger from "wink-pos-tagger";

/** Penn Treebank tags worth keeping: common and proper nouns, adjectives. */
const KEEP_POS = new Set(["NN", "NNS", "NNP", "NNPS", "JJ", "JJR", "JJS"]);

/** Generic academic scaffolding. Deliberately SHORT: a long hand-maintained
 * stoplist is what the phantom-code fix argued against, and the part-of-speech
 * filter already removes the verbs that make up most of the noise. These are
 * the nouns that survive it and still say nothing. */
const STOP = new Set(
  `course courses student students study studies topic topics introduction
   credit credits prerequisite prerequisites semester semesters hour hours
   emphasis focus concept concepts principle principles method methods theory
   overview survey application applications material materials class classes
   lecture lectures laboratory discussion week weeks work term terms
   requirement requirements degree major minor program programs
   well various certain particular specific different important common related
   additional individual appropriate necessary available current recent modern
   exercises combination portions aspects areas issues role roles part parts
   variety range number level levels form forms type types set ways manner`.split(/\s+/),
);

export interface KeywordOptions {
  /** Subject prefixes that exist this edition, lowercased (ENGL, CHEM, ...). */
  subjects: Set<string>;
  /** How many keywords per course. */
  limit?: number;
  /** Upper document-frequency bound, as a fraction of the corpus. */
  maxDocFraction?: number;
}

interface Doc {
  code: string;
  /** Lowercased noun/adjective tokens, in order, with repeats. */
  terms: string[];
}

const WORD = /^[a-z][a-z-]{2,}$/;

/** Tag one description and keep only the nouns and adjectives in it. */
function nounsAndAdjectives(tagger: ReturnType<typeof posTagger>, text: string, opts: KeywordOptions): string[] {
  const out: string[] = [];
  // The tagger wants sentences; handing it a whole paragraph degrades the
  // tags near the end, so it is split on terminal punctuation first.
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (!sentence.trim()) continue;
    let tagged;
    try {
      tagged = tagger.tagSentence(sentence);
    } catch {
      continue; // a sentence the tagger chokes on contributes nothing
    }
    for (const t of tagged) {
      if (!KEEP_POS.has(t.pos)) continue;
      const w = t.value.toLowerCase();
      if (!WORD.test(w) || w.length < 4) continue;
      if (STOP.has(w) || opts.subjects.has(w.replace(/-/g, ""))) continue;
      out.push(w);
    }
  }
  return out;
}

/** Terms of the title, so the keywords do not repeat what is already shown. */
function titleWords(title: string): Set<string> {
  return new Set(title.toLowerCase().split(/[^a-z]+/).filter(Boolean));
}

/**
 * Extract keywords for every course that has a description.
 *
 * Returns a map from course code to its keywords, most distinctive first.
 * Courses whose description yields nothing are absent rather than present and
 * empty, so a caller can tell "no keywords derived" from "no description".
 */
export function extractKeywords(
  courses: { code: string; title?: string; description?: string }[],
  opts: KeywordOptions,
): Map<string, string[]> {
  const limit = opts.limit ?? 8;
  const maxDocFraction = opts.maxDocFraction ?? 0.12;
  const tagger = posTagger();

  const docs: Doc[] = [];
  const docFreq = new Map<string, number>();
  for (const c of courses) {
    if (!c.description?.trim()) continue;
    const terms = nounsAndAdjectives(tagger, c.description, opts);
    if (!terms.length) continue;
    docs.push({ code: c.code, terms });
    for (const t of new Set(terms)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }

  const n = docs.length;
  const maxDf = Math.max(2, Math.floor(n * maxDocFraction));
  const byCode = new Map(courses.map((c) => [c.code, c] as const));
  const out = new Map<string, string[]>();

  for (const doc of docs) {
    const title = titleWords(byCode.get(doc.code)?.title ?? "");
    const tf = new Map<string, number>();
    for (const t of doc.terms) tf.set(t, (tf.get(t) ?? 0) + 1);

    const scored: { term: string; score: number }[] = [];
    for (const [term, count] of tf) {
      const df = docFreq.get(term) ?? 0;
      if (df < 3 || df > maxDf || title.has(term)) continue;
      scored.push({ term, score: (1 + Math.log(count)) * Math.log(n / df) });
    }
    // Ties broken alphabetically so a rebuild of the same bytes is identical.
    scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
    const kws = scored.slice(0, limit).map((s) => s.term);
    if (kws.length) out.set(doc.code, kws);
  }
  return out;
}
