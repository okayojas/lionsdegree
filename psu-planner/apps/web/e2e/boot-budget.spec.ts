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
 * MEASURED at 689 KB across 74 requests, stable over three consecutive runs,
 * plus ~15% headroom. Previously 2,896 KB, when the degree audit pulled the
 * entire search index on mount; it now reads the 212 KB audit index instead.
 *
 * The audit index grew 2 KB here, to carry each course's `level` -- it was
 * being invented at hydration, and 5,126 graduate courses were coming back
 * as undergraduate. Correctness bought for 0.3% of the boot payload. The
 * total still fell, which is the ratchet working rather than a reason to
 * stop reading the number.
 *
 * The first draft of this line guessed 2,700 against a real 2,896 — wrong by
 * 200 KB, which is the small version of the mistake that produced #24: a
 * number written from an estimate rather than read off a run.
 *
 * Re-measure by reading the figure this test prints on failure, and record it
 * in the commit that moves this line. Rounding it up to make a build pass is
 * the exact failure ADR 0002 exists to prevent. */
const BOOT_CEILING_KB = 790;

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

  test("fetches the search ranking data only when somebody searches", async ({ page, baseURL }) => {
    // #28. The postings are 1,263 KB gzipped and mean nothing until a student
    // types, so they must not be on the boot path — and must arrive exactly
    // once when they are wanted, not per keystroke.
    const origin = new URL(baseURL!).origin;
    const hits: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.origin === origin && u.pathname.includes("search-postings")) hits.push(u.pathname);
    });

    await seedPlan(page);
    await page.goto("/plan/");
    await page.locator(".card").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    expect(hits, "the ranking data was fetched before anyone searched").toEqual([]);

    const box = page.locator(".searchbox input").first();
    await box.fill("robotics");
    await expect(page.locator(".sr-item").first()).toBeVisible({ timeout: 30_000 });
    expect(hits.length, "the ranking data was not fetched when search was used").toBe(1);

    // Typing more must not refetch: the memo is what makes this affordable.
    await box.fill("");
    await box.fill("machine learning");
    await expect(page.locator(".sr-item").first()).toBeVisible({ timeout: 30_000 });
    expect(hits.length, "the ranking data was fetched again on a second query").toBe(1);
  });

  test("still ranks description matches, not just codes and titles", async ({ page }) => {
    // The split would be worthless if it quietly turned full-text search into
    // prefix matching on the code. "robotics" appears in course DESCRIPTIONS
    // far more than in titles, and finding the right course for it is the
    // incident that produced the index in the first place (DECISIONS.md 4.2).
    await seedPlan(page);
    await page.goto("/plan/");
    await page.locator(".card").first().waitFor({ timeout: 60_000 });

    const box = page.locator(".searchbox input").first();
    await box.fill("robotics");
    await expect(page.locator(".sr-item").first()).toBeVisible({ timeout: 30_000 });
    const codes = (await page.locator(".sr-item .sr-code").allTextContents()).map((t) => t.trim().split("\n")[0]);
    expect(codes.length, "no results for a term that is common in descriptions").toBeGreaterThan(5);
    // At least one hit whose CODE does not contain the query — i.e. it was
    // found by what the course is about, which is the body signal working.
    expect(
      codes.some((c) => !c.toLowerCase().includes("robot")),
      "every result matched the code, so the body signal is not loaded",
    ).toBe(true);
  });

  test("never asks for the retired combined index", async ({ page, baseURL }) => {
    // #29. `search-index.json` is gone: the audit reads the audit index,
    // search adds the postings, course detail reads the subject file. A
    // request for it would mean something had been pointed back at an
    // artifact the pipeline no longer builds — a 404 that degrades silently
    // rather than failing, which is the worst shape for a regression.
    //
    // Exercised across the three paths that used to pull it, not just boot.
    const origin = new URL(baseURL!).origin;
    const asked: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.origin === origin && u.pathname.includes("search-index")) asked.push(u.pathname);
    });

    await seedPlan(page);
    await page.goto("/plan/");
    // This assertion is about REQUESTS, not layout, so it must not depend on
    // which view rendered. A phone opens the list rather than the chart, and
    // waiting on a chart card there spent the whole timeout before asserting
    // anything.
    await page.locator(".card").first().waitFor({ timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Exercise search and course detail where the layout offers them. At
    // phone width the toolbar collapses and the chart becomes a list, so the
    // assertion still runs -- against the boot path alone -- rather than the
    // test pretending those surfaces were checked when they were not.
    const box = page.locator(".searchbox input").first();
    if (await box.isVisible().catch(() => false)) {
      await box.fill("robotics");
      await expect(page.locator(".sr-item").first()).toBeVisible({ timeout: 30_000 });
    }
    // Dismiss the results first. They render over the chart, so a click on a
    // card below is intercepted and Playwright waits for actionability until
    // the test times out -- which looks like a hang, not an overlay.
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await expect(page.locator(".sr-item")).toHaveCount(0, { timeout: 10_000 }).catch(() => {});

    const card = page.locator(".card").first();
    if (await card.isVisible().catch(() => false)) {
      await card.click({ timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    expect(asked, "something still requests the retired combined index").toEqual([]);
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

    // Tightened with #27. The heaviest single request is now the audit index
    // at 210 of 702 KB — 30%. One file being most of the payload is precisely
    // the shape #24 turned out to be, so the threshold tracks reality rather
    // than sitting where no plausible regression would ever reach it.
    expect(
      share,
      `${worstPath} is ${(share * 100).toFixed(0)}% of the boot payload ` +
        `(${worstKb.toFixed(0)} of ${total.toFixed(0)} KB gzipped)`,
    ).toBeLessThan(0.5);
  });
});
