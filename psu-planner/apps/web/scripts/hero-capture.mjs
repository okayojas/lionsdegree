/** Record the hero loop (Landing-Page-UI-Spec.md A1).
 *
 * The sequence that demonstrates the whole engine in one take: drag a course
 * into a term where its prerequisite is not satisfied, the warning appears,
 * click the one-click fix, the card moves and the status clears.
 *
 * Headless capture rather than a screen recording, for three reasons: it has
 * no browser chrome to crop, it is reproducible when the UI changes, and it
 * cannot accidentally film a real student's name. It is a FIRST PASS — the
 * spec asks for a seamless loop cut from a longer take, and a human eye on
 * the pacing. See docs/media-brief.md.
 *
 *   node scripts/hero-capture.mjs            # against a running preview
 *   BASE=http://localhost:4173 node scripts/hero-capture.mjs
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..");
const OUT = path.join(web, "public", "shots");
const RAW = path.join(web, ".hero-raw");
const BASE = process.env.BASE ?? "http://localhost:4173";
const PLAN_KEY = "psu-planner-plan-v1";
const SEEDED = JSON.parse(fs.readFileSync(path.join(web, "e2e", "seeded-plan.json"), "utf-8"));

/** The spec's framing: three to four term columns, roughly eight cards. */
const SIZE = { width: 1280, height: 720 };

fs.rmSync(RAW, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: SIZE,
  recordVideo: { dir: RAW, size: SIZE },
  // No reduced-motion: the route draw and the card transitions are the point.
  reducedMotion: "no-preference",
});
await context.addInitScript(
  ([k, v, t]) => {
    window.localStorage.setItem(k, v);
    window.localStorage.setItem("lionsdegree-theme", t);
  },
  [PLAN_KEY, JSON.stringify(SEEDED), "light"],
);

const page = await context.newPage();
// The fix asks for confirmation. In the recording that native dialog would
// be a grey box over the product, so it is accepted automatically — the
// viewer sees the outcome, which is what the loop is demonstrating.
page.on("dialog", (d) => void d.accept());

const navStart = Date.now();
await page.goto(`${BASE}/plan/`, { waitUntil: "networkidle" });
await page.waitForSelector(".viewport", { timeout: 30_000 });

/** A drawn cursor. Playwright's synthetic mouse moves no real pointer, so
 * without this the video shows cards moving by themselves. */
await page.addStyleTag({
  content: `
    #cap-cursor {
      position: fixed; z-index: 99999; width: 22px; height: 22px;
      margin: -11px 0 0 -11px; border-radius: 50%;
      border: 2px solid rgba(29,98,127,.9);
      background: rgba(29,98,127,.18);
      pointer-events: none; transition: transform .04s linear;
    }
    #cap-cursor.down { background: rgba(29,98,127,.4); transform: scale(.82); }
  `,
});
await page.evaluate(() => {
  const c = document.createElement("div");
  c.id = "cap-cursor";
  document.body.append(c);
  const put = (x, y) => { c.style.left = `${x}px`; c.style.top = `${y}px`; };
  put(-99, -99);
  window.__cur = { put, down: (on) => c.classList.toggle("down", on) };
});

const cursor = {
  /** Move in steps so the drawn dot travels rather than teleporting. The
   * spec asks for slow, deliberate movement; fast reads as frantic. */
  async to(x, y, steps = 26) {
    const from = cursor.at ?? { x, y };
    for (let i = 1; i <= steps; i++) {
      const nx = from.x + ((x - from.x) * i) / steps;
      const ny = from.y + ((y - from.y) * i) / steps;
      await page.mouse.move(nx, ny);
      await page.evaluate(([a, b]) => window.__cur.put(a, b), [nx, ny]);
      await page.waitForTimeout(12);
    }
    cursor.at = { x, y };
  },
  async press(on) {
    await page.evaluate((v) => window.__cur.down(v), on);
    if (on) await page.mouse.down();
    else await page.mouse.up();
  },
};

const box = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`nothing at ${sel}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

// Let the route lines finish drawing, and let the generation toast expire.
// Leaving it up puts a dark banner across the bottom third of every frame.
await page.waitForTimeout(2600);
await page.evaluate(() => {
  for (const t of document.querySelectorAll(".toast, [class*='toast']")) t.remove();
});

// Zoom in. At fit-to-content the whole degree is on screen and every card is
// three pixels of grey; the spec asks for three or four term columns and
// roughly eight cards. Wheel events, because that is the zoom the app
// actually implements.
await page.mouse.move(SIZE.width / 2, SIZE.height / 2);
for (let i = 0; i < 5; i++) {
  await page.mouse.wheel(0, -260);
  await page.waitForTimeout(90);
}
await page.waitForTimeout(700);

// Everything from here is the take. Noted so the recording can be trimmed
// back to it: Playwright records the whole context lifetime, and the setup
// above is three seconds of nothing.
const takeStart = Date.now();

// ── The take ──────────────────────────────────────────────────────────────
// 1. Pick a card that has an in-plan prerequisite behind it.
const subject = await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".card")];
  // A card in a later column is the one most likely to have prerequisites
  // already scheduled before it.
  const sorted = cards.sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
  const pick = sorted.find((c) => c.querySelector(".code") && c.getBoundingClientRect().x < window.innerWidth - 60);
  return pick?.dataset.id ?? null;
});
if (!subject) throw new Error("no draggable card found in frame");
console.log("subject:", subject);

// CSS.escape is a browser global; this runs in Node.
const card = `.card[data-id="${subject.replace(/"/g, '\\"')}"]`;
const start = await box(card);

// 2. Approach, pause, and drag it left into an earlier term.
await cursor.to(start.x, start.y, 30);
await page.waitForTimeout(320);
await cursor.press(true);
await cursor.to(start.x - 430, start.y + 40, 34);
await cursor.press(false);
await page.waitForTimeout(900);

// 3. Open it. The warning and the offered fix are the payoff.
const moved = await box(card);
await cursor.to(moved.x, moved.y, 18);
await page.waitForTimeout(260);
await page.mouse.click(moved.x, moved.y);
await page.waitForSelector("[role=dialog]", { timeout: 5000 });
await page.waitForTimeout(1500);

// 4. Take the fix.
const fix = page.locator(".fixrow button");
if (await fix.count()) {
  const f = await box(".fixrow button");
  await cursor.to(f.x, f.y, 22);
  await page.waitForTimeout(340);
  await page.mouse.click(f.x, f.y);
  await page.waitForTimeout(1600);
} else {
  console.warn("no fix offered for this card — the take will be short");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
}

// Poster: the exact opening frame, so there is no flash when the video loads.
await page.evaluate(() => document.getElementById("cap-cursor")?.remove());

// Seconds of setup to cut from the front of the recording.
const trimFrom = (takeStart - navStart) / 1000;

await context.close();
await browser.close();

const raw = fs.readdirSync(RAW).find((f) => f.endsWith(".webm"));
if (!raw) throw new Error("playwright produced no video");

// Trim the setup off the front and re-encode to the spec's budget. Playwright
// writes a high-bitrate VP9 that comes out around 2.4 MB; the spec's ceiling
// is 1.5 MB, and it says shorten rather than compress harder, which is what
// trimming the dead opening does.
const ffmpeg = findFfmpeg();
const src = path.join(RAW, raw);
const dst = path.join(OUT, "hero.webm");
if (ffmpeg) {
  const { execFileSync } = await import("node:child_process");
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(Math.max(0, trimFrom - 0.4)),
    "-i", src,
    "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-an",
    dst,
  ]);
} else {
  console.warn("no ffmpeg found — shipping the raw capture, which is over budget");
  fs.copyFileSync(src, dst);
}
// The poster: the exact first frame, so the element does not flash before
// the video decodes.
if (ffmpeg) {
  const { execFileSync } = await import("node:child_process");
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", dst,
    "-frames:v", "1", path.join(OUT, "hero-poster.png"),
  ]);
  console.log(`shots/hero-poster.png  ${(fs.statSync(path.join(OUT, "hero-poster.png")).size / 1024).toFixed(0)} KB`);
}

// NO hero.mp4. Playwright's bundled ffmpeg is a WebM-only build -- it has no
// MP4 muxer and no libx264 -- so the Safari and iOS fallback cannot be made
// here. It needs a real ffmpeg on PATH:
//
//   ffmpeg -i public/shots/hero.webm -c:v libx264 -crf 26 -profile:v baseline //          -pix_fmt yuv420p -movflags +faststart -an public/shots/hero.mp4
//
// Until that exists, a <video> carrying only the WebM shows a black box on
// iPhone, which is most of the audience for a link shared in a group chat.

fs.rmSync(RAW, { recursive: true, force: true });
const kb = fs.statSync(dst).size / 1024;
console.log(`shots/hero.webm  ${kb.toFixed(0)} KB${kb > 1536 ? "  -- OVER the 1.5 MB budget" : ""}`);

function findFfmpeg() {
  // Playwright bundles one for its own recording; no separate install.
  const base = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (!fs.existsSync(base)) return null;
  const dir = fs.readdirSync(base).filter((d) => d.startsWith("ffmpeg-")).sort().pop();
  if (!dir) return null;
  const exe = path.join(base, dir, "ffmpeg-win64.exe");
  return fs.existsSync(exe) ? exe : null;
}
