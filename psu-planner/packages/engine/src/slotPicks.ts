/** Ranked course suggestions for one Slot.
 *
 * Gen-ed Slots and elective Slots used to be answered by two different code
 * paths, which meant two different ideas of what a good suggestion is. This is
 * the single path: it takes a Pool, which already knows where its courses came
 * from, and ranks whatever that Pool admits.
 *
 * The ranking answers one question in order of how much it helps a student:
 * can I take this next, does it also close something else, and does it fit. */
import { domainsOf, isInterdomain, rankGenEdPicks, BUCKET_BY_KEY, IL_ATTR, US_ATTR } from "./genEd.js";
import { checkCourse } from "./evaluate.js";
import { codeMatchesPool, type Pool } from "./requirements.js";
import type { Catalog, Course, Schedule } from "./types.js";

export interface SlotPick {
  course: Course;
  /** The course has prerequisites AND the plan satisfies them by this term.
   * A SEPARATE field rather than another entry in `bonuses`, because the view
   * styles this one differently and deciding which chip it is by position in
   * an array is how a "not ready" course ends up wearing a green badge.
   *
   * False for a course with no prerequisites at all: "prerequisites met" is
   * noise when there were none to meet, and the chip should mean something. */
  ready: boolean;
  /** Why else this one is worth choosing — rendered as neutral chips. */
  bonuses: string[];
  score: number;
}

/** Where this Slot's answer came from, and how far to trust it.
 *
 * Separate fields rather than one prose blob: the view renders a department
 * list differently from a bulletin table, and parsing a sentence to decide
 * which is how the two end up looking the same. */
export interface SlotProvenance {
  source: "bulletin" | "pattern" | "genEd" | "department-list" | "adviser" | "unreadable";
  /** A department list read off the bulletin: the page, and when we read it. */
  readFrom?: { url: string; fetchedAt: string };
  /** A person checked this list against its source, rather than only a parser. */
  humanChecked?: boolean;
  /** Set when the list speaks for a campus other than the student's. */
  campusCaveat?: string;
}

export interface SlotSuggestions {
  pool: Pool | null;
  picks: SlotPick[];
  provenance: SlotProvenance;
  /** Where no list can be derived, the topic the requirement DOES constrain,
   * as a catalog query. "6 credits in art history" names no courses but it
   * does name a subject, and handing the student that search beats leaving
   * them with nothing to click. Absent when the prose constrains nothing. */
  searchHint?: string;
  /** What this Slot is, in the student's terms. For a Pool with no list, this
   * is the requirement's own wording: the absence IS the answer. */
  poolNote: string;
  /** Always shown alongside picks. We cannot see course offerings -- LionPATH
   * disallows crawling -- so nothing here may imply a course runs in a term. */
  offeringsNote: string;
}

export interface SlotPickOptions {
  /** Courses already in the plan or completed; never suggested again. */
  exclude: Set<string>;
  /** Subjects belonging to the student's major, for the gen-ed department
   * restriction. */
  majorPrefixes: Set<string>;
  needUS: boolean;
  needIL: boolean;
  /** Schreyer Scholars earn honors credit from the same card. */
  preferHonors?: boolean;
  /** The plan's schedule and the term this Slot sits in, so a course the
   * student can actually take next ranks first. Omit for no prereq signal. */
  sched?: Schedule;
  termIndex?: number;
  /** How many suggestions to return. */
  limit?: number;
  /** The student's campus, so a list belonging to a different one is flagged
   * rather than presented as theirs. */
  campus?: string;
}

const CAMPUS_LABEL: Record<string, string> = {
  "university-park": "University Park",
};
const campusName = (slug: string) =>
  CAMPUS_LABEL[slug] ?? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Words that are requirement boilerplate, not topic. A word SET rather than
 * one large regex: a regex that silently matches nothing looks identical to
 * one that works, which is exactly what happened the first time. */
const HINT_NOISE = new Set(
  ("in consultation with an a the adviser advisor select choose take complete credit credits from " +
    "following departmental department college list lists approved course courses minimum at least of " +
    "and or any one two three level other each two-of to be must student students").split(" "),
);

/** The topic a requirement constrains, if any.
 *
 * "In consultation with adviser, select 6 credits in art history" constrains
 * no course list but it does name a subject, and handing a student that
 * search beats leaving them with nothing to click. */
export function searchHintFrom(prose: string): string | undefined {
  const words = prose
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !HINT_NOISE.has(w));
  if (!words.length) return undefined;
  const hint = words.join(" ").trim();
  // A single short fragment is noise, not a topic worth offering.
  return hint.length >= 4 ? hint : undefined;
}

const OFFERINGS_NOTE =
  "We can't see which semesters a course actually runs — check LionPATH before you commit to one.";

/** Any gen-ed course at all. Used by plans generated before gen-ed slots were
 * refined into framework categories. */
const ANY_GENED = "GE";

function provenanceOf(pool: Pool | null, opts?: SlotPickOptions): SlotProvenance {
  if (!pool) return { source: "unreadable" };
  switch (pool.kind) {
    case "listed":
      return { source: "bulletin" };
    case "patterned":
      return { source: "pattern" };
    case "genEd":
      return { source: "genEd" };
    case "adviser":
      return { source: "adviser" };
    case "unreadable":
      return { source: "unreadable" };
    case "registry": {
      const p: SlotProvenance = {
        source: "department-list",
        readFrom: { url: pool.sourceUrl, fetchedAt: pool.fetchedAt },
        humanChecked: pool.confirmedBy === "human",
      };
      // A University Park list does not silently speak for a branch campus.
      if (opts?.campus && opts.campus !== pool.campusScope) {
        p.campusCaveat =
          `This is the ${campusName(pool.campusScope)} list. Your campus may approve a different set — ` +
          `check with your campus adviser before you rely on it.`;
      }
      return p;
    }
  }
}

function describePool(pool: Pool | null, opts?: SlotPickOptions): string {
  if (!pool) return "We couldn't match this requirement to a course list.";
  switch (pool.kind) {
    case "listed":
      return `From this requirement's published list (${pool.courses.length} courses).`;
    case "registry":
      return `From ${pool.campusScope === "university-park" ? "the University Park" : "your campus's"} department list, read ${pool.fetchedAt}.`;
    case "patterned": {
      const subjects = pool.subjects.join(", ");
      const level = pool.minLevel ? `${pool.minLevel}-level and above` : "any level";
      return `Any ${level} course in ${subjects}.`;
    }
    case "genEd": {
      // pool.domain is a framework BUCKET KEY ("EXPGN", "INTER"), not a
      // designation a course carries. Rendering it raw produced "Courses
      // carrying the EXPGN designation", which names nothing that exists --
      // and every plan has those slots.
      const bucket = BUCKET_BY_KEY.get(pool.domain);
      const what = bucket ? bucket.label : pool.domain === ANY_GENED ? "any General Education" : `${pool.domain}`;
      const hint =
        opts && (opts.needUS || opts.needIL)
          ? " A course marked “also fulfills US/IL” closes two requirements at once."
          : "";
      return `${what} — qualifying courses.${hint}`;
    }
    case "adviser":
      // The requirement's own words. There is no list to show, and saying so
      // plainly beats an empty one, which reads as "nothing qualifies".
      return `${pool.prose} — your adviser decides what counts here.`;
    case "unreadable":
      return pool.prose
        ? `We couldn't read this requirement's course list. It says: "${pool.prose}" — check with your adviser.`
        : "We couldn't read this requirement's course list — check with your adviser.";
  }
}

export function rankSlotPicks(catalog: Catalog, pool: Pool | null, opts: SlotPickOptions): SlotSuggestions {
  const result: SlotSuggestions = {
    pool,
    picks: [],
    provenance: provenanceOf(pool, opts),
    poolNote: describePool(pool, opts),
    offeringsNote: OFFERINGS_NOTE,
  };
  if (pool && (pool.kind === "adviser" || pool.kind === "unreadable")) {
    result.searchHint = searchHintFrom(pool.prose);
  }
  // An adviser or unreadable Pool has nothing to enumerate. Returning an empty
  // list here is correct BECAUSE the note carries the explanation; an empty
  // list on its own would read as "no course qualifies", which is false.
  if (!pool || pool.kind === "adviser" || pool.kind === "unreadable") return result;

  // Gen-ed keeps its own ranker: it encodes the framework's double-count and
  // department rules, and reimplementing them here would be two ideas of the
  // same thing again.
  if (pool.kind === "genEd") {
    const bucketKey = BUCKET_BY_KEY.has(pool.domain) ? pool.domain : null;
    const picks = bucketKey
      ? rankGenEdPicks(catalog, bucketKey, {
          majorPrefixes: opts.majorPrefixes,
          needUS: opts.needUS,
          needIL: opts.needIL,
          exclude: opts.exclude,
          preferHonors: opts.preferHonors,
        })
      : Object.values(catalog)
          .filter((c) => {
            if (opts.exclude.has(c.code) || c.level !== "undergraduate") return false;
            // "GE" is not a designation any course carries; it means ANY
            // gen-ed course. Matching it literally returned zero picks under a
            // confident heading -- an empty list reading as "nothing
            // qualifies", which is the failure this whole panel exists to
            // avoid.
            return pool.domain === ANY_GENED ? c.genEd.length > 0 : c.genEd.includes(pool.domain);
          })
          .map((course) => ({ course, bonuses: [] as string[], score: 0 }));
    result.picks = withPrereqRanking(picks.map((p) => ({ ...p, ready: false })), catalog, opts);
    return result;
  }

  const seen = new Set<string>();
  const picks: SlotPick[] = [];
  for (const c of Object.values(catalog)) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    if (c.level !== "undergraduate" || opts.exclude.has(c.code)) continue;
    if (!codeMatchesPool(c.code, pool)) continue;

    const bonuses: string[] = [];
    let score = 0;
    if (opts.needIL && c.attributes.includes(IL_ATTR)) { bonuses.push("also fulfills IL"); score += 4; }
    else if (opts.needUS && c.attributes.includes(US_ATTR)) { bonuses.push("also fulfills US"); score += 4; }
    if (opts.preferHonors && (c.attributes.includes("Honors") || /[HM]$/.test(c.number))) {
      bonuses.push("honors credits");
      score += 2;
    }
    // A course that also carries a gen-ed designation closes two requirements.
    const doms = domainsOf(c);
    if (doms.length) { bonuses.push(`also counts as ${doms.join("+")}`); score += isInterdomain(c) ? 2 : 1; }
    picks.push({ course: c, ready: false, bonuses, score });
  }
  result.picks = withPrereqRanking(picks, catalog, opts);
  return result;
}

/** Prerequisite readiness dominates every other signal: a course the student
 * cannot take yet is not a useful suggestion however well it scores
 * otherwise.
 *
 * Readiness is computed for EVERY candidate before `limit` slices, which
 * looks wasteful on a gen-ed bucket of several thousand courses. It is not,
 * and it cannot be moved after the slice anyway: readiness is worth +10, so
 * it decides the order the slice is taken from. Measured on the shipped
 * 2026-2027 catalog, checkCourse over all 14,656 courses -- far more than any
 * single slot offers -- takes 4 ms. The re-parse branch inside checkCourse
 * never fires either: all 3,394 courses that state prerequisites ship a
 * precomputed prereqAst. */
function withPrereqRanking(picks: SlotPick[], catalog: Catalog, opts: SlotPickOptions): SlotPick[] {
  const ranked = picks.map((p) => {
    if (!opts.sched || opts.termIndex === undefined) return p;
    // A course with no stated prerequisites has nothing to be "met". Saying so
    // would make the chip meaningless on the many courses that simply have
    // none, and would dress the absence of data up as a verified fact.
    const hasPrereqs = !!(p.course.prereqAst ?? p.course.enforced);
    if (!hasPrereqs) return p;
    const chk = checkCourse(catalog, p.course.code, opts.termIndex, opts.sched);
    // 2 = satisfied. 1 means the requirement is free text we could not judge,
    // which is not the same as met and must not be presented as met.
    if (chk.value === 2) return { ...p, ready: true, score: p.score + 10 };
    return p;
  });
  ranked.sort((a, b) =>
    b.score - a.score ||
    a.course.subject.localeCompare(b.course.subject) ||
    a.course.number.localeCompare(b.course.number, undefined, { numeric: true }),
  );
  return opts.limit ? ranked.slice(0, opts.limit) : ranked;
}
