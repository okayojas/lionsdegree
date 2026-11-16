/** The Sample plans page's list, as markup (#60, #67).
 *
 * IN THE DOCUMENT, NOT FETCHED INTO IT. The page is a list of every Program
 * that publishes a suggested plan, each with a link that opens it in the
 * planner. A crawler, a link previewer and a student with scripts off all get
 * that list, because the build writes it into the page (vite.config.ts) from
 * the Edition's own Template index (scripts/template-index.mjs). The script
 * the page loads only narrows what is already there.
 *
 * NO IMPORTS, and it has to stay that way: vite.config.ts loads this file
 * while it is still deciding how to resolve everything else.
 */

/** One Program that has a Template, as the published index carries it. */
export interface TemplateEntry {
  /** The Program's identifier in the catalog. */
  program: string;
  name: string;
  /** The campuses its suggested plans are for, in the Bulletin's own words.
   * Empty where the Bulletin names none. */
  campuses: readonly string[];
}

/** The comment in the page that the build replaces with the list. */
export const PROGRAM_LIST_MARKER = "<!-- sample-plans-list -->";

/** The planner's own Program link (src/data/deepLink.ts): it opens with this
 * Program chosen, and generates nothing until the student says so. */
export const plannerLink = (program: string): string => `/plan/?programs=${encodeURIComponent(program)}`;

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Text as it is compared: lower case, accents taken off, and anything that
 * is not a letter or a digit turned into a space. Full stops and apostrophes
 * go without leaving a space behind, so "B.S." is the word "bs" and
 * "Women's" is "womens", which is how they get typed. The list is folded
 * with this at build time and what a student types is folded with it in the
 * page, so the two cannot drift apart. */
export const fold = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.'\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Whether what was typed finds an entry: every word typed begins some word
 * of the entry's name or campuses, in any order. "comp sci erie" finds
 * Computer Science at Erie; "ba" finds the B.A.s and not Abington.
 * Nothing typed finds everything. */
export function finds(findableText: string, typed: string): boolean {
  const words = findableText.split(" ");
  return fold(typed)
    .split(" ")
    .filter(Boolean)
    .every((start) => words.some((word) => word.startsWith(start)));
}

/** What typing is matched against: the Program's name and its campuses. */
export const findable = (entry: TemplateEntry): string => fold([entry.name, ...entry.campuses].join(" "));

/** The list's items. Each is a Program: its name, where its suggested plans
 * are for, and the way into the planner.
 *
 * "Open in the planner" would be the same words three hundred times over to
 * a screen reader's list of links, so each carries its Program's name out of
 * sight after the visible words. */
export function programListHtml(entries: readonly TemplateEntry[]): string {
  return entries
    .map((entry) => {
      const name = escapeHtml(entry.name);
      // Never a guess: where the Bulletin names no campus, the page says so.
      const campuses = entry.campuses.length
        ? entry.campuses.map(escapeHtml).join(" · ")
        : "The Bulletin names no campus for this plan";
      return `<li class="program" data-find="${escapeHtml(findable(entry))}">
            <p class="program-name">${name}</p>
            <p class="program-campus">${campuses}</p>
            <a class="program-open" href="${plannerLink(entry.program)}">Open in the planner<span class="sr-only">: ${name}</span></a>
          </li>`;
    })
    .join("\n          ");
}
