/** Render a legal Section to HTML, for the static documents at /privacy and
 * /terms. The React renderer lives in LegalModal.tsx; both read `content.ts`,
 * so the two surfaces say the same thing by construction. */
import type { Block, Inline, Section } from "./content.js";

/** Everything interpolated into the page goes through this. The content is
 * ours and contains no markup today, but a policy document that builds HTML
 * by concatenation is one careless edit away from injecting it. */
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
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(section.title)}</title>
    <meta name="description" content="${escapeHtml(section.description)}" />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f1ebdf" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#2b2a27" />
    <link rel="canonical" href="${siteUrl}${path}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="LionsDegree" />
    <meta property="og:url" content="${siteUrl}${path}" />
    <meta property="og:title" content="${escapeHtml(section.title)}" />
    <meta property="og:description" content="${escapeHtml(section.description)}" />
    <link rel="stylesheet" href="/src/landing.css" />
  </head>
  <body class="landing legal-page">
    <a href="#doc" class="skip-link">Skip to the document</a>
    <header class="lp-hero lp-hero-slim">
      <div class="lp-wrap">
        <p class="lp-mark"><a href="/"><i class="lp-dot" aria-hidden="true"></i>LionsDegree</a></p>
        <h1>${escapeHtml(section.heading)}</h1>
      </div>
    </header>
    <main id="doc" class="lp-wrap legal-body">
        ${section.body.map(blockHtml).join("\n        ")}
    </main>
    <footer class="lp-foot">
      <div class="lp-wrap">
        <p class="lp-disclaim">
          <strong>Unofficial.</strong> LionsDegree is not affiliated with,
          endorsed by, or an official product of The Pennsylvania State
          University.
        </p>
        <p class="lp-small">
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
