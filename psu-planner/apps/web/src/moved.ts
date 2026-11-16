/** Old addresses on the landing page, for things that are pages now.
 *
 * About and Contact were sections of the landing page, and the discovery
 * prompt was a box on it, so `/#about`, `/#contact` and `/#discovery` are in
 * bookmarks, in chat histories and in whatever has linked here since. A
 * fragment never reaches the server, which rules out a redirect rule: only
 * the page itself can see it.
 *
 * `replace`, not `assign`. The old address must not stay in the history, or
 * Back returns to it and it sends the visitor forward again.
 *
 * Without this script the same addresses still work, more plainly: the
 * landing page's own links to each of these places carry the old ids, so the
 * browser scrolls to the link that goes where the thing went.
 *
 * Its own file, loaded by the landing document, so that it outlives whatever
 * else that page's scripts become. e2e/about.spec.ts and e2e/connect.spec.ts
 * hold it there.
 */
const MOVED: Readonly<Record<string, string>> = {
  "#about": "/about/",
  "#contact": "/about/#contact",
  "#discovery": "/connect/#discovery",
};

const to = MOVED[location.hash];
if (to) location.replace(to);
