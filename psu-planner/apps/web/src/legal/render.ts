/** Render a legal Section to HTML, for the static documents at /privacy and
 * /terms. The React renderer lives in LegalModal.tsx; both read `content.ts`,
 * so the two surfaces say the same thing by construction. */
import type { Block, Inline, Section } from "./content.js";
import { siteHeader } from "../site/header.js";

/** Every piece of CONTENT interpolated into the page goes through this. The
 * content is ours and contains no markup today, but a policy document that
 * builds HTML by concatenation is one careless edit away from injecting it.
 * The one thing written in unescaped is `siteHeader()`, which is markup by
 * design and takes nothing from the content module. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(run: Inline): string {
  if (typeof run === "string") return escapeHtml(run);
  if ("b" in run) return `<strong>${escapeHtml(run.b)}</strong>`;
  if ("i" in run) return `<em>${escapeHtml(run.i)}</em>`;
  const external = !run.href.startsWith("mailto:");
  const attrs = external ? ` target="_blank" rel="noopener noreferrer"` : "";
  return `<a href="${escapeHtml(run.href)}"${attrs}>${escapeHtml(run.a)}</a>`;
}

const runs = (list: Inline[]): string => list.map(inline).join("");

export function blockHtml(b: Block): string {
  if ("p" in b) return `<p>${runs(b.p)}</p>`;
  return `<ul>\n${b.ul.map((li) => `          <li>${runs(li)}</li>`).join("\n")}\n        </ul>`;
}

/** A complete, self-contained document. No script tag: these pages must be
 * readable by a crawler, an OAuth reviewer and a browser with JavaScript off,
 * which is the entire reason they are not the modal. */
export function pageHtml(section: Section, siteUrl = "%SITE_URL%"): string {
  const path = section.path ?? "/";
  return `<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(section.title)}</title>
    <meta name="description" content="${escapeHtml(section.description)}" />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="theme-color" content="#f1ebdf" />
    <link rel="canonical" href="${siteUrl}${path}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="LionsDegree" />
    <meta property="og:url" content="${siteUrl}${path}" />
    <meta property="og:title" content="${escapeHtml(section.title)}" />
    <meta property="og:description" content="${escapeHtml(section.description)}" />
    <link rel="stylesheet" href="/src/site.css" />
  </head>
  <body class="site legal-page">
    <a href="#doc" class="skip-link">Skip to the document</a>
    ${siteHeader(path)}
    <main id="doc" class="wrap">
      <div class="page-head">
        <h1>${escapeHtml(section.heading)}</h1>
      </div>
      <div class="doc-body">
        ${section.body.map(blockHtml).join("\n        ")}
      </div>
    </main>
    <footer class="foot">
      <div class="wrap">
        <p class="disclaim">
          <strong>Unofficial.</strong> LionsDegree is not affiliated with,
          endorsed by, or an official product of The Pennsylvania State
          University.
        </p>
        <p class="small">
          <a href="/">Home</a> ·
          <a href="/plan/">Open the planner</a> ·
          <a href="/privacy/">Privacy</a> ·
          <a href="/terms/">Terms</a> ·
          <a href="https://github.com/okayojas/lionsdegree">Source</a>
        </p>
      </div>
    </footer>
  </body>
</html>
`;
}
