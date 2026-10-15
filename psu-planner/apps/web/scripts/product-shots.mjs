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

const shots = [
  // The chart itself: course cards and the prerequisite lines between them.
  { name: "flowchart", clip: { x: 10, y: 70, width: 920, height: 700 } },
  // The audit panel: what the plan still owes, checked against the catalog.
  { name: "audit", clip: { x: 1010, y: 70, width: 480, height: 700 } },
];

for (const { name, clip } of shots) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip });
  console.log(`shots/${name}.png`);
}

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
await phone.screenshot({ path: path.join(OUT, "mobile.png") });
console.log("shots/mobile.png");
await phone.close();

await browser.close();
