/** Discovery: an interest in plain words, a combination of real credentials.
 *
 * The Bulletin lists programs. It does not tell a student that two of them
 * overlap by fourteen credits, which is the fact that makes a second
 * credential worth taking — and the reason this is the one thing here that
 * nothing else does.
 *
 * DETERMINISTIC, like everything else that touches the catalog. Iron rule 1
 * is not only about transcription: a recommender that invents a
 * plausible-sounding minor is the same failure as a transcriber that invents
 * a plausible-sounding course, and harder to notice because the output reads
 * like a suggestion rather than a fact. Every credential returned here is a
 * program in the shipped catalog, and every credit figure is summed from real
 * course records. A model may later phrase or re-rank what this returns; it
 * may not add to it.
 *
 * MATCHING runs against a program's name PLUS the titles of the courses it
 * requires. That is the whole trick: "machine learning" appears in no program
 * name at Penn State, but it is the title of courses that the AI programs
 * require. Searching names alone answers the spec's own example with nothing.
 */
import { stem } from "./search.js";
import type { Catalog } from "./types.js";
import type { ProgramRequirements, ReqRule, ReqSection } from "./requirements.js";

export interface ProgramHit {
  slug: string;
  name: string;
  type: string;
  /** Why it matched: the query terms found in its text. Shown to the student
   * so a surprising suggestion can be understood rather than just trusted. */
  matched: string[];
  score: number;
}

export interface Combination {
  major: ProgramHit;
  /** Minors and certificates that pair with it, best overlap first. */
  extras: ProgramHit[];
  /** Credits countable toward more than one of the credentials above. */
  sharedCredits: number;
  /** The courses behind that number, so it can be checked by hand. */
  sharedCourses: string[];
}

export interface DiscoverOptions {
  requirements: Record<string, ProgramRequirements>;
  catalog: Catalog;
  limit?: number;
}

const STOP = new Set(
  `the and for with that this from are was were has have been will can may its
   their them they not but you your who which what when where while into about
   like love enjoy interested interest want study studying major minor
   certificate degree program programs course courses credit credits`.split(/\s+/),
);

/** Query terms, stemmed.
 *
 * Matching is by substring against course titles, so a plural the catalog
 * does not use finds nothing: "robots" returned no combinations at all while
 * "robot" and "robotics" each returned two, because no course is titled
 * anything-robots. Stemming to "robot" makes all three agree, and it is the
 * same stemmer catalog search already uses -- a second one would be free to
 * drift from it. */
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);

/** Every course code a program's requirements can be satisfied by.
 *
 * Reads the rule shapes directly rather than going through `poolFromRule`:
 * this needs the raw membership, not a resolved Pool with provenance, and
 * pulling in the Pool machinery would make a cheap set intersection depend on
 * the whole requirement-resolution stack. */
function requiredCodes(prog: ProgramRequirements): Set<string> {
  const out = new Set<string>();
  const addRule = (r: ReqRule): void => {
    if (r.type === "course" && r.code) out.add(r.code);
    else if ((r.type === "oneOf" || r.type === "chooseN") && Array.isArray(r.options)) {
      for (const o of r.options) out.add(o);
    } else if (r.type === "selectCredits" && r.from?.kind === "courses") {
      for (const c of r.from.courses) out.add(c);
    }
  };
  for (const s of (prog.requirementSections ?? []) as ReqSection[]) {
    for (const r of s.rules ?? []) addRule(r as ReqRule);
  }
  return out;
}

/**
 * The text a program is searchable by: its own name, plus the TITLE of every
 * course it requires.
 *
 * Course titles are what make a plain-English interest findable. A student
 * typing "machine learning" matches no program name in the catalog; it
 * matches the courses the AI programs require.
 */
export function programSearchText(prog: ProgramRequirements, catalog: Catalog): string {
  const titles: string[] = [];
  for (const code of requiredCodes(prog)) {
    const t = catalog[code]?.title;
    if (t) titles.push(t);
  }
  return [prog.name, ...titles].join(" ");
}

export interface Overlap {
  credits: number;
  courses: string[];
}

/**
 * Credits countable toward BOTH programs, and the courses behind them.
 *
 * NOT the sum of every course in the intersection. That was the first
 * version, and it reported 71 shared credits between Engineering Science and
 * the Environmental Engineering minor — a minor whose rules total 9. The
 * error is that an elective pool lists every course that COULD satisfy a
 * requirement, while the requirement only ever consumes the credits it asks
 * for: "select 3 credits from the following" offers forty courses and can
 * double-count three credits, not a hundred and twenty.
 *
 * So each program is asked, rule by rule, how much of its OWN requirement
 * the shared courses could satisfy, and the answer is the smaller of the two.
 * Neither credential can double-count more than it requires in total.
 *
 * This is the number a student plans a year around, so it errs low.
 */
export function sharedCredits(a: ProgramRequirements, b: ProgramRequirements, catalog: Catalog): Overlap {
  const codesB = requiredCodes(b);
  const shared = new Set<string>();
  for (const code of requiredCodes(a)) {
    // A code the catalog does not have is not a course a student can take,
    // so it cannot count toward anything.
    if (codesB.has(code) && catalog[code]) shared.add(code);
  }
  if (!shared.size) return { credits: 0, courses: [] };

  const credits = Math.min(realisable(a, shared, catalog), realisable(b, shared, catalog));
  return { credits, courses: [...shared].sort() };
}

/** Credits of `prog`'s own requirements that `shared` could satisfy. */
function realisable(prog: ProgramRequirements, shared: Set<string>, catalog: Catalog): number {
  const cr = (code: string) => catalog[code]?.creditsParsed?.min ?? 0;
  let total = 0;
  for (const section of (prog.requirementSections ?? []) as ReqSection[]) {
    for (const rule of (section.rules ?? []) as ReqRule[]) {
      if (rule.type === "course") {
        if (shared.has(rule.code)) total += rule.credits ?? cr(rule.code);
      } else if (rule.type === "oneOf" || rule.type === "chooseN") {
        // One rule, satisfied once, however many of its options are shared.
        const hit = rule.options.find((o) => shared.has(o));
        if (hit) total += rule.credits ?? cr(hit);
      } else if (rule.type === "selectCredits" && rule.from?.kind === "courses") {
        const available = rule.from.courses.filter((c) => shared.has(c)).reduce((n, c) => n + cr(c), 0);
        if (!available) continue;
        // Bounded by what the rule asks for. An unstated credit count is the
        // only case where the pool itself is the bound, and it is rare.
        total += rule.credits == null ? available : Math.min(rule.credits, available);
      }
    }
  }
  return total;
}

function scoreProgram(text: string, terms: string[]): { score: number; matched: string[] } {
  const hay = text.toLowerCase();
  const matched: string[] = [];
  let score = 0;
  for (const t of terms) {
    // Count occurrences, capped: a program requiring nine courses with
    // "design" in the title is not nine times more about design than one
    // requiring two.
    const n = hay.split(t).length - 1;
    if (!n) continue;
    matched.push(t);
    score += Math.min(n, 4);
  }
  // Every term present beats more hits on one term. "machine learning and
  // clean energy" should favour a program touching both over one that
  // mentions energy nine times.
  if (matched.length === terms.length && terms.length > 1) score += 6;
  return { score, matched };
}

/**
 * Combinations of real credentials for an interest expressed in plain words.
 *
 * Empty for an interest the catalog has no answer to. That is deliberate and
 * is the hardest part to get right: the failure to avoid is a confident,
 * plausible-looking combination for a query nothing actually matches.
 */
export function discover(query: string, opts: DiscoverOptions): Combination[] {
  const terms = words(query);
  if (!terms.length) return [];

  const limit = opts.limit ?? 3;
  const hits: ProgramHit[] = [];
  for (const [slug, prog] of Object.entries(opts.requirements)) {
    const { score, matched } = scoreProgram(programSearchText(prog, opts.catalog), terms);
    if (!score) continue;
    hits.push({ slug, name: prog.name, type: prog.type, matched, score });
  }
  if (!hits.length) return [];

  // Ties broken by slug so the same words always give the same answer: a
  // student comparing two sessions must not see the list reshuffle.
  hits.sort((x, y) => y.score - x.score || x.slug.localeCompare(y.slug));

  const majors = hits.filter((h) => h.type === "major");
  const extrasPool = hits.filter((h) => h.type === "minor" || h.type === "certificate");
  if (!majors.length) return [];

  const out: Combination[] = [];
  for (const major of majors.slice(0, limit)) {
    // Pair by OVERLAP, not by score. The second credential is worth taking
    // because it reuses work already required, and ranking those by how well
    // they matched the query would recommend the most on-topic minor rather
    // than the most achievable one.
    const ranked = extrasPool
      .filter((e) => e.slug !== major.slug)
      .map((e) => ({ e, ov: sharedCredits(opts.requirements[major.slug], opts.requirements[e.slug], opts.catalog) }))
      .sort((p, q) => q.ov.credits - p.ov.credits || p.e.slug.localeCompare(q.e.slug));

    const extras: ProgramHit[] = [];
    const sharedCourses = new Set<string>();
    let credits = 0;
    // At most one minor and one certificate: three credentials is already a
    // lot to put in front of someone, and a list of eight is not a plan.
    for (const kind of ["minor", "certificate"]) {
      const pick = ranked.find((r) => r.e.type === kind);
      if (!pick) continue;
      extras.push(pick.e);
      credits += pick.ov.credits;
      for (const c of pick.ov.courses) sharedCourses.add(c);
    }
    out.push({ major, extras, sharedCredits: credits, sharedCourses: [...sharedCourses].sort() });
  }
  return out;
}
