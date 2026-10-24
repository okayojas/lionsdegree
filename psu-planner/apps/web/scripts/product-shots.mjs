/** Capture the planner for the landing page.
 *
 * The imagery is the PRODUCT, not an illustration of it. For software, a real
 * screenshot is both the most characteristic visual available and the only
 * honest one -- a stylised mock of a degree map would be a picture of a plan
 * no student can actually get. (It is also free, and needs no image model.)
 *
 * Uses the browser suite's own seeded plan, so what the page shows is a plan
 * the engine really generated from the real catalog rather than a mock-up.
 *
 *   node scripts/product-shots.mjs            # against a running preview
 *   BASE=http://localhost:4173 node scripts/...
 */
import { chromium } from "@playwright/test";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..");
const OUT = path.join(web, "public", "shots");
const BASE = process.env.BASE ?? "http://localhost:4173";
const PLAN_KEY = "psu-planner-plan-v1";

const SEEDED = JSON.parse(fs.readFileSync(path.join(web, "e2e", "seeded-plan.json"), "utf-8"));

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1500, height: 940 },
  deviceScaleFactor: 2,
});
await page.addInitScript(
  ([k, v, t]) => {
    window.localStorage.setItem(k, v);
    window.localStorage.setItem("lionsdegree-theme", t);
  },
  [PLAN_KEY, JSON.stringify(SEEDED), "light"],
);

await page.goto(`${BASE}/plan/`, { waitUntil: "networkidle" });
await page.waitForSelector(".viewport", { timeout: 30_000 });
// Let the route lines finish drawing: a half-drawn chart reads as a bug.
await page.waitForTimeout(2600);

// Zoom in before capturing. At the default fit-to-content scale the whole
// degree is on screen but every card is three pixels of grey, which says
// "busy" rather than "legible".
await page.mouse.move(430, 430);
for (let i = 0; i < 4; i++) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(140);
}
await page.waitForTimeout(500);

/* ── Framing ────────────────────────────────────────────────────────────
   These clips used to be four hardcoded pixel rectangles guessed against a
   1500x940 viewport. Any layout change -- a wider panel, a taller toolbar --
   slid the subject off-centre, and nothing failed, so the shots quietly
   drifted until someone looked at the landing page and said the photos were
   badly framed.

   Now the crop is DERIVED: measure where the subject actually is, then build
   a window centred on it. Content is centred by construction rather than by
   a number somebody typed once. */

/** Union of every match's box, in page coordinates — the real extent of the
 * content, as opposed to the extent of the surface it is drawn on. The chart
 * lives inside a pan/zoom viewport that always fills its pane, so measuring
 * the container tells you nothing about where the cards ended up. */
async function contentBox(page, selector) {
  return page.evaluate((sel) => {
    const seen = [...document.querySelectorAll(sel)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!seen.length) return null;
    const box = seen.reduce(
      (acc, el) => {
        const r = el.getBoundingClientRect();
        return {
          left: Math.min(acc.left, r.left),
          top: Math.min(acc.top, r.top),
          right: Math.max(acc.right, r.right),
          bottom: Math.max(acc.bottom, r.bottom),
        };
      },
      { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
    return { ...box, count: seen.length };
  }, selector);
}

/** The subject plus breathing room, clamped to the page.
 *
 * SIZED by the content, not just positioned by it. A fixed 920x700 window
 * centred on the cards still left half the frame as empty canvas, because
 * the plan does not happen to be 700px tall — centring the subject inside a
 * frame it does not fill just moves the dead space around. Deriving both the
 * origin and the extent means the subject fills the shot by construction. */
function frame(subject, { pad, bounds }) {
  const x = Math.max(bounds.left, subject.left - pad);
  const y = Math.max(bounds.top, subject.top - pad);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.min(subject.right + pad, bounds.right) - x),
    height: Math.round(Math.min(subject.bottom + pad, bounds.bottom) - y),
  };
}

const page1 = { left: 0, top: 0, right: 1500, bottom: 940 };

// The chart: frame the COURSE CARDS, not the viewport that holds them. This
// also crops the toolbar out, which the old fixed rectangle used to slice
// through mid-word.
const cards = await contentBox(page, ".viewport .card");
if (!cards) throw new Error("no course cards found — did the seeded plan load?");
console.log(`  framing the chart on ${cards.count} cards`);
const flowchart = frame(cards, { pad: 28, bounds: page1 });

// The audit panel is a fixed pane, so its own box IS the subject. Trim a few
// pixels off the resizer edge so the shot does not include a grab handle.
const panel = await contentBox(page, ".sidepanel");
if (!panel) throw new Error("no .sidepanel found");
const audit = {
  x: Math.round(panel.left + 6),
  y: Math.round(panel.top),
  width: Math.round(panel.right - panel.left - 6),
  height: Math.round(Math.min(panel.bottom, page1.bottom) - panel.top),
};

/** Screenshot, then quantise.
 *
 * Playwright writes full-depth PNG. These shots are flat UI -- a handful of
 * fills, text, and thin strokes -- so a palette costs nothing visible and
 * saves two thirds of the bytes. Framing the shots properly made them larger
 * (the subject now fills the frame instead of sharing it with empty canvas),
 * which pushed `mobile.png` from 45 KB to 214 KB and straight through the
 * 140 KB-per-image budget. The budget is right and the shot is right; what
 * was missing was this step.
 *
 * Same scar as the brand mark, which shipped as 192 KB of full-depth PNG for
 * four flat colours. */
async function capture(target, name, clip) {
  const raw = await target.screenshot(clip ? { clip } : { fullPage: false });
  const out = path.join(OUT, `${name}.png`);
  await sharp(raw)
    .png({ palette: true, quality: 82, effort: 10 })
    .toFile(out);
  const meta = await sharp(out).metadata();
  const kb = fs.statSync(out).size / 1024;
  console.log(`shots/${name}.png  ${meta.width}x${meta.height}  ${kb.toFixed(0)} KB`);
  return { width: meta.width, height: meta.height, kb };
}

await capture(page, "flowchart", flowchart);
await capture(page, "audit", audit);

// The phone shot is the LIST view, not the canvas shrunk down: the list is
// the mobile experience, and photographing a drag surface nobody can drag
// would be selling the wrong thing.
const phone = await browser.newPage({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2 });
await phone.addInitScript(
  ([k, v, t]) => {
    window.localStorage.setItem(k, v);
    window.localStorage.setItem("lionsdegree-theme", t);
    window.localStorage.setItem("lionsdegree-view", "list");
  },
  [PLAN_KEY, JSON.stringify(SEEDED), "light"],
);
await phone.goto(`${BASE}/plan/`, { waitUntil: "networkidle" });
await phone.waitForTimeout(2200);
await capture(phone, "mobile");
await phone.close();

await browser.close();
