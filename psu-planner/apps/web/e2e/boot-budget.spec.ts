/** What the planner makes a student download before they can use it (#25).
 *
 * THE METRIC EXISTS BECAUSE IT DID NOT. The catalog loader carried a comment
 * reading "~0.7 MB over the wire" while shipping 2.36 MB: the index had grown
 * 3.4x and no test, budget or review caught it, because nothing anywhere
 * measured the planner's boot payload. #24 is the consequence — about four
 * seconds before a plan is usable, 77% of it one file.
 *
 * ADR 0002 settled the discipline for the landing page and it applies here
 * unchanged: fix the metric first, then move the number. So this lands with
 * the ceiling at TODAY's measured figure plus headroom. It is green on the
 * day it ships and it can only ever ratchet downward — every later ticket on
 * #24 lowers it, with the new measurement recorded in that commit.
 *
 * GZIPPED, not bytes on disk, because that is what a student on campus wifi
 * actually waits for. The two numbers lead to different decisions: the search
 * index is 10.5 MB on disk and 2.36 MB on the wire.
 *
 * Why the browser and not a static import walk, as on the landing page: most
 * of this weight is fetched at RUNTIME from the catalog, by code that decides
 * what it needs from the student's own plan. There is no import graph to
 * follow — only a real page load tells you what is really requested.
 */
import { test, expect, SEEDED_PLAN } from "./fixtures.js";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** Total gzipped weight of the planner's boot payload, in KB.
 *
 * MEASURED at 2,896 KB across 74 requests, plus ~15% headroom. The first
 * draft of this line guessed 2,700 and was wrong by 200 KB, which is the
 * small version of the mistake that produced #24 — a number written from an
 * estimate rather than read off a run.
 *
 * Re-measure by reading the figure this test prints on failure, and record it
 * in the commit that moves this line. Rounding it up to make a build pass is
 * the exact failure ADR 0002 exists to prevent. */
const BOOT_CEILING_KB = 3330;

/** Gzip the file a request resolved to.
 *
 * The preview server's own `Content-Length` reports whatever it decided to
 * do about compression, which varies between the dev server, the preview
 * server and Cloudflare. Compressing the bytes ourselves measures the
 * artifact rather than the server's configuration, and is what makes this
 * number comparable across runs. */
function gzippedKb(urlPath: string): number {
  const rel = decodeURIComponent(urlPath.replace(/^\//, "").split("?")[0]);
  const file = path.join(dist, rel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return 0;
  return zlib.gzipSync(fs.readFileSync(file)).length / 1024;
}

/** Seed a plan WITHOUT navigating, so the response listener is attached
 * before the first byte. The `planner` fixture navigates as part of its
 * setup, which would mean measuring only whatever was still outstanding by
 * the time the test body ran. */
async function seedPlan(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(
    ([key, plan]) => window.localStorage.setItem(key as string, plan as string),
    ["psu-planner-plan-v1", JSON.stringify(SEEDED_PLAN)] as const,
  );
}

test.describe("the planner's boot payload", () => {
  // A full catalog download on a cold cache is slower than the default.
  test.setTimeout(120_000);

  test("stays within its measured ceiling", async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const seen = new Map<string, number>();

    page.on("response", (res) => {
      const url = new URL(res.url());
      if (url.origin !== origin) return;
      // DISTINCT paths: a browser fetches a file once, and counting a cached
      // second request would measure the test rather than the payload.
      if (seen.has(url.pathname)) return;
      seen.set(url.pathname, gzippedKb(url.pathname));
    });

    await seedPlan(page);
    await page.goto("/plan/");
    // "Usable" is the honest boundary: the student can see their plan and act
    // on it. Anything the app fetches after this is not what they waited for.
    await page.locator(".card").first().waitFor({ timeout: 60_000 });

    const total = [...seen.values()].reduce((a, b) => a + b, 0);
    const heaviest = [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([p, kb]) => `${kb.toFixed(0)} KB ${p}`)
      .join("\n    ");

    expect(
      total,
      `the planner downloads ${total.toFixed(0)} KB gzipped before a plan is usable ` +
        `(${seen.size} requests). Heaviest:\n    ${heaviest}\n  ` +
        `If this is a deliberate increase, re-measure and move BOOT_CEILING_KB with the figure in the commit message.`,
    ).toBeLessThan(BOOT_CEILING_KB);
  });

  test("reports which single file dominates it", async ({ page, baseURL }) => {
    // Not a size assertion — a shape assertion. The thing that went wrong on
    // #24 was one file quietly becoming most of the payload, so this fails
    // when any single request exceeds half the total and names it. A budget
    // that only reports a sum tells you that you are over, never why.
    const origin = new URL(baseURL!).origin;
    const seen = new Map<string, number>();
    page.on("response", (res) => {
      const url = new URL(res.url());
      if (url.origin !== origin || seen.has(url.pathname)) return;
      seen.set(url.pathname, gzippedKb(url.pathname));
    });

    await seedPlan(page);
    await page.goto("/plan/");
    await page.locator(".card").first().waitFor({ timeout: 60_000 });

    const total = [...seen.values()].reduce((a, b) => a + b, 0);
    const [worstPath, worstKb] = [...seen.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    const share = total > 0 ? worstKb / total : 0;

    // Deliberately loose: today `search-index.json` is 84% of the payload
    // (2,419 of 2,896 KB) and this records that rather than pretending
    // otherwise. #27 and #28 are what bring it down — tighten this with them,
    // and it becomes a real guard once no single file dominates.
    expect(
      share,
      `${worstPath} is ${(share * 100).toFixed(0)}% of the boot payload ` +
        `(${worstKb.toFixed(0)} of ${total.toFixed(0)} KB gzipped)`,
    ).toBeLessThan(0.9);
  });
});
