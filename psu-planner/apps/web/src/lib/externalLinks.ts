/** External search links (Reddit, Rate My Professors).
 *
 * DATA-BOUNDARY RULE (see spec Part 2 and Part 6): offer the search, never
 * perform it. These functions ONLY construct a URL string; the user's browser
 * navigates. Nothing here fetches, and nothing is stored. The moment the server
 * (or any code here) fetched reddit.com / ratemyprofessors.com, we would become
 * an API consumer needing authorization under their terms — so we never do.
 *
 * Render the results as buttons with target="_blank" rel="noreferrer", and keep
 * labels neutral ("Search r/pennstate for this course"). Never state or imply
 * what the rating or consensus is. */

const REDDIT_SUBS = ["pennstate"]; // add campus/major subs if you find them

// RMP school IDs: read each from the URL bar ONCE, by hand — do NOT build a
// name->ID index or fetch anything (that artifact is what drew the RMP
// cease-and-desists). Visit ratemyprofessors.com, search the campus, and copy
// the number out of /search/professors/<ID>. Each PSU campus is a separate
// school. 0 = not yet filled in (falls back to University Park).
const RMP_SCHOOL_IDS: Record<string, number> = {
  "University Park": 0, // TODO: fill in from the URL bar
  "Abington": 0,        // TODO
  "Behrend": 0,         // TODO
};

/** Search a course code within r/pennstate, recent threads only. The &t=year
 * recency filter matters — a 2019 thread about a since-changed course is noise. */
export function redditCourseSearch(code: string, sub = REDDIT_SUBS[0]): string {
  const q = encodeURIComponent(`"${code}"`);
  return `https://www.reddit.com/r/${sub}/search/?q=${q}&restrict_sr=1&sort=relevance&t=year`;
}

/** Google-scoped fallback across all of reddit.com for the course. */
export function googleRedditSearch(code: string): string {
  const q = encodeURIComponent(`site:reddit.com "${code}" penn state`);
  return `https://www.google.com/search?q=${q}`;
}

/** School-scoped RMP professor search. Needs NO professor ID, so nothing has to
 * be resolved or fetched — accept the one extra click. Keyed off the student's
 * campus (from the catalog) so Abington students aren't sent to the UP list. */
export function rmpProfessorSearch(name: string, campus = "University Park"): string {
  const id = RMP_SCHOOL_IDS[campus] || RMP_SCHOOL_IDS["University Park"];
  return `https://www.ratemyprofessors.com/search/professors/${id}?q=${encodeURIComponent(name)}`;
}
