/** robots.txt and sitemap.xml, generated from the real page list.
 *
 * Hand-written versions of these go stale the moment a page is added or
 * renamed, and a sitemap advertising a 404 is worse than no sitemap. The page
 * list comes from the same source the build does: the static documents the
 * legal generator emits, plus the two hand-authored entry points.
 *
 * `/plan/` is listed but given a low priority: it is the application, and what
 * a search result should land on is the landing page that explains what the
 * application is. The catalog JSON is disallowed outright -- tens of megabytes
 * of derived data that is Penn State's to publish, not ours to get indexed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECTIONS } from "../src/legal/content.js";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SITE_URL = (process.env.SITE_URL ?? process.env.CF_PAGES_URL ?? "https://lionsdegree.com").replace(/\/$/, "");

interface Entry {
  path: string;
  priority: string;
  changefreq: string;
}

const pages: Entry[] = [
  { path: "/", priority: "1.0", changefreq: "monthly" },
  { path: "/plan/", priority: "0.5", changefreq: "monthly" },
  ...SECTIONS.filter((s) => s.path).map((s) => ({ path: s.path!, priority: "0.3", changefreq: "yearly" })),
];

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (p) =>
      `  <url>\n    <loc>${SITE_URL}${p.path}</loc>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`,
  )
  .join("\n")}
</urlset>
`;

const robots = `# LionsDegree — an unofficial Penn State degree planner.
# Source: https://github.com/okayojas/lionsdegree

User-agent: *
Allow: /

# Derived catalog data. Large, machine-oriented, and the underlying course
# information is Penn State's — crawl their bulletin, not our copy of it.
Disallow: /catalog/

Sitemap: ${SITE_URL}/sitemap.xml
`;

fs.writeFileSync(path.join(web, "public", "robots.txt"), robots, "utf-8");
fs.writeFileSync(path.join(web, "public", "sitemap.xml"), sitemap, "utf-8");

console.log(`site-index: robots.txt + sitemap.xml for ${SITE_URL} (${pages.length} pages)`);
