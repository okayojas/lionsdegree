/** Render the link-preview card.
 *
 * A student shares the link in a group chat and the previewer shows a card.
 * Drawing that card by hand in an image editor would mean a second place the
 * identity lives, and it would drift the first time the palette moves. So it
 * is rendered from the BUILT stylesheet with the real tokens and the real
 * self-hosted faces, and screenshotted.
 *
 *   node scripts/make-og.mjs      (after `npm run build`)
 *
 * Writes public/og.png, which the next build copies to dist/og.png -- the URL
 * the og:image meta tag points at. Committed, because a previewer fetches it
 * from the deployed site and nothing regenerates it there.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..");
const dist = path.join(web, "dist");

const indexHtml = path.join(dist, "index.html");
if (!fs.existsSync(indexHtml)) {
  console.error("dist/index.html is missing — run `npm run build` first.");
  process.exit(1);
}

// Find the built stylesheet rather than guessing its hashed name.
const cssHref = /<link rel="stylesheet"[^>]*href="([^"]+)"/.exec(fs.readFileSync(indexHtml, "utf-8"))?.[1];
if (!cssHref) {
  console.error("no stylesheet found in dist/index.html — did the build change?");
  process.exit(1);
}

/** The card. Deliberately NOT the landing page shrunk to 1200x630: a preview
 * card is read at thumbnail size in a chat list, so it carries the wordmark,
 * one line of what this is, and the route -- and nothing else. */
const card = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="${cssHref.replace(/^\//, "")}">
<style>
  html, body { margin: 0; padding: 0; width: 1200px; height: 630px; overflow: hidden; }
  body {
    background: var(--bg);
    background-image: radial-gradient(color-mix(in srgb, var(--text) 8%, transparent) 1px, transparent 1px);
    background-size: 32px 32px;
    font-family: var(--font-sans);
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 84px; box-sizing: border-box;
  }
  .mark { display: flex; align-items: center; gap: 16px; margin-bottom: 26px; }
  .dot { width: 26px; height: 26px; border-radius: 50%; background: var(--surface); border: 8px solid var(--primary); box-sizing: content-box; }
  .mark span { font-size: 38px; font-weight: 800; color: var(--navy); letter-spacing: var(--track-tight); }
  h1 { font-size: 78px; line-height: 1.02; margin: 0 0 22px; color: var(--navy); font-weight: 800; letter-spacing: -0.03em; }
  p { font-size: 28px; line-height: 1.4; margin: 0; color: var(--text); max-width: 30ch; }
  .route { position: absolute; right: 40px; bottom: 60px; }
  /* The animated variants would be mid-flight when the screenshot is taken. */
  .route path { fill: none; stroke-width: 7; stroke-linecap: round; }
  .route circle { fill: var(--surface); stroke: var(--text); stroke-width: 6; }
  .route text { font-family: var(--font-mono); font-size: 19px; fill: var(--text-muted); }
  .foot { position: absolute; left: 84px; bottom: 44px; font-size: 20px; color: var(--text-muted); }
</style>
</head>
<body>
  <div class="mark"><i class="dot"></i><span>LionsDegree</span></div>
  <h1>Your degree<br>is a route.</h1>
  <p>Prerequisite-aware degree planning for Penn State.</p>
  <!-- Three stations, three labels, set as SVG text so each one is anchored
       to its own stop. An earlier version had a branch line ending at a fourth,
       unlabelled dot, which at thumbnail size read as the image being cut off. -->
  <svg class="route" width="560" height="300" viewBox="0 0 560 300" aria-hidden="true">
    <path d="M60 120 H280 H500" style="stroke: var(--primary)"/>
    <circle cx="60" cy="120" r="15"/>
    <circle cx="280" cy="120" r="15"/>
    <circle cx="500" cy="120" r="15"/>
    <text x="60"  y="178" text-anchor="middle">MATH 140</text>
    <text x="280" y="178" text-anchor="middle">MATH 141</text>
    <text x="500" y="178" text-anchor="middle">MATH 230</text>
  </svg>
  <div class="foot">Unofficial · not affiliated with Penn State</div>
</body>
</html>`;

const tmp = path.join(dist, "_og-card.html");
fs.writeFileSync(tmp, card, "utf-8");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(`file://${tmp.replace(/\\/g, "/")}`);
  // Wait for the self-hosted faces, or the card screenshots in a fallback
  // face and the wordmark sets wrong.
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(web, "public", "og.png");
  await page.screenshot({ path: out, type: "png" });
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`og.png written to public/ (1200x630, ${kb} KB)`);
} finally {
  await browser.close();
  fs.rmSync(tmp, { force: true });
}
