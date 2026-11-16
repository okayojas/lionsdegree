/** The header every page outside the planner wears.
 *
 * ONE COPY. Connect, Privacy and Terms each used to carry their own, which is
 * how the three drifted: a link added to one was a link missing from two.
 * The legal generator calls this directly (src/legal/render.ts); hand-written
 * pages leave `SITE_HEADER_SLOT` where it goes and the build fills it in
 * (vite.config.ts). The planner is not a caller. It has a toolbar, not a
 * site header, and only the wordmark's markup is shared with it.
 *
 * NO IMPORTS, and it has to stay that way: vite.config.ts loads this file
 * while it is still deciding how to resolve everything else.
 *
 * NO SCRIPT, NO MENU BUTTON. The legal documents ship no JavaScript at all,
 * so a header that needed some to open would be a header they could not
 * have. Instead the links are always on the page, and on a narrow screen
 * they drop to a row of their own (site.css).
 */

/** Where the build writes the header into a hand-written page. An HTML
 * comment, so a page opened straight off the disk still parses. */
export const SITE_HEADER_SLOT = "<!-- site-header -->";

/** The pages the header links to, in the order it lists them. About and
 * Sample plans join this list when those pages exist. */
const NAV: readonly { href: string; label: string }[] = [
  { href: "/plan/", label: "Planner" },
  { href: "/connect/", label: "Connect your AI" },
];

/** @param current the page being rendered, as a site path ("/connect/"). */
export function siteHeader(current: string): string {
  const links = NAV.map(
    ({ href, label }) => `<a href="${href}"${href === current ? ` aria-current="page"` : ""}>${label}</a>`,
  ).join("\n        ");
  // The mark is decoration beside its own name, hence the empty alt: the
  // link is called "LionsDegree" once, not "LionsDegree LionsDegree".
  //
  // `<b>` and not two spans: it colours "Lions" without splitting the word,
  // so it stays one word to a screen reader, to find-in-page and to anyone
  // copying it. The planner's toolbar carries the same run (App.tsx).
  return `<header class="site-head">
      <a class="brand" href="/"><img src="/mark-clear.png" width="185" height="144" alt="" /><span><b>Lions</b>Degree</span></a>
      <nav class="site-nav" aria-label="Site">
        ${links}
      </nav>
      <a class="site-start" href="/plan/">Start my plan<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg></a>
    </header>`;
}
