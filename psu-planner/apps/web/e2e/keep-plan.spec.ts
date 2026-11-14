/** "This plan is only in this browser" — the offer, in a real browser.
 *
 * A plan lives in localStorage until the student signs in, and until now
 * nothing in the product ever said so. These cover what a student can see
 * and do: that the offer arrives with the plan and not before it, that
 * refusing it costs nothing, and — the #23 lesson — that it does not take
 * the screen away from the thing they came for.
 *
 * NOT COVERED HERE: the build with no Supabase configured, where the offer
 * must not exist at all. `syncConfigured` is baked in at build time, so
 * proving that in a browser would mean a third build on a third port for
 * one assertion. It is covered at the seam instead, in
 * `test/keep-plan-offer.test.ts`, where the three conditions are the
 * subject — and the bar is asserted there to read the same rule rather
 * than a copy of it.
 */
import { test, expect, SEEDED_PLAN } from "./fixtures.js";
import type { Page, Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const BAR = ".keep-plan-bar";

/** Is account sync configured in the build under test?
 *
 * Without it the offer can never appear and every assertion below would be
 * meaningless. The account control is the visible consequence of the same
 * flag, so it is what gets asked — and a build without it fails with a
 * sentence naming the cause rather than with "element not found". */
async function syncIsConfigured(page: Page): Promise<boolean> {
  return (await page.getByRole("button", { name: /^Sign in$/ }).count()) > 0;
}

/** A real major WITH a suggested-plan grid, so onboarding will offer to
 * generate from it. Fetched in parallel and memoised per worker, the same
 * way `deep-link.spec.ts` and `no-horizontal-overflow.spec.ts` each do it:
 * this file wants its own cache rather than a shared one across files that
 * run in separate workers anyway. */
let slugCache: Promise<string> | null = null;
function aMajorWithAGrid(baseURL: string): Promise<string> {
  slugCache ??= (async () => {
    const idx = (await (await fetch(`${baseURL}/catalog/2026-2027/programs_index.json`)).json()) as {
      slug: string; type: string;
    }[];
    const grids = await Promise.all(
      idx.filter((p) => p.type === "major").slice(0, 6).map(async (p) => {
        try {
          const prog = (await (
            await fetch(`${baseURL}/catalog/2026-2027/programs/majors/${p.slug}.json`)
          ).json()) as { suggestedPlans?: { semesters?: unknown[] }[] };
          return prog.suggestedPlans?.some((sp) => (sp.semesters?.length ?? 0) > 0) ? p.slug : null;
        } catch {
          return null;
        }
      }),
    );
    const major = grids.find(Boolean);
    if (!major) throw new Error("no major in the first 6 of the shipped catalog has a plan grid");
    return major;
  })();
  return slugCache;
}

test("arrives with the plan, and not before it", async ({ page, baseURL }) => {
  // THE WHOLE TIMING DECISION, end to end. Nothing is said while the
  // student is still choosing programs — there is no plan to keep yet, and
  // "keep this" names nothing they have seen. The build itself is not the
  // moment either: 968-1008ms across these four profiles, timed from the
  // press to the first card, so it is over before a prompt could be read.
  // The beat AFTER is where the offer lands, and it needs no new
  // stage in `BuildOverlay` to get there — it simply renders with the
  // chart, which is the screen that only exists once a plan does.
  test.setTimeout(120_000);
  await page.goto(`/plan/?programs=${await aMajorWithAGrid(baseURL!)}`);
  await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
  test.skip(!(await syncIsConfigured(page)), "this build has no VITE_SUPABASE_URL, so there is no account to offer");

  await expect(page.locator(BAR), "the offer was made before there was a plan to keep").toHaveCount(0);

  const generate = page.getByRole("button", { name: /build my flowchart/i }).first();
  await generate.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await generate.click();

  const codes = page.locator(".card .code, .lv-code");
  await expect
    .poll(() => codes.count(), { timeout: 60_000, message: "the plan never generated" })
    .toBeGreaterThan(5);
  await expect(
    page.locator(BAR),
    "a student who just built a plan is never told it is only in this browser",
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(BAR)).toContainText(/only in this browser/i);
});

test("offers to keep the plan a returning student already has", async ({ planner }) => {
  // The seeded fixture is the same situation one load later: a plan on the
  // device, nobody signed in. The condition is that a plan EXISTS, not
  // that it was built in this second.
  test.skip(!(await syncIsConfigured(planner)), "this build has no VITE_SUPABASE_URL, so there is no account to offer");
  await expect(planner.locator(BAR)).toBeVisible({ timeout: 15_000 });
  await expect(planner.locator(BAR).getByRole("button", { name: /keep this plan/i })).toBeVisible();
  await expect(planner.locator(BAR).getByRole("button", { name: /not now/i })).toBeVisible();
});

test("takes no for an answer, and does not ask again in the same sitting", async ({ planner }) => {
  test.skip(!(await syncIsConfigured(planner)), "this build has no VITE_SUPABASE_URL, so there is no account to offer");
  const bar = planner.locator(BAR);
  await expect(bar).toBeVisible({ timeout: 15_000 });

  // By keyboard, because a bar a student can see and cannot reach is a
  // trap in the tab order rather than an offer.
  const notNow = bar.getByRole("button", { name: /not now/i });
  await notNow.focus();
  await expect(notNow).toBeFocused();
  await planner.keyboard.press("Enter");
  await expect(bar, "Enter on Not now did not dismiss the offer").toHaveCount(0);

  // The plan is still there and still usable afterwards — the planner does
  // not need an account and must not start needing one here.
  await planner.getByRole("button", { name: /List view/i }).click();
  await expect(planner.getByRole("region", { name: /list view/i })).toBeVisible();

  await planner.reload();
  await expect(planner.getByRole("banner")).toBeVisible({ timeout: 30_000 });
  // Whichever view the reload lands in — the choice is remembered, and a
  // card-only selector would wait for a canvas that is not coming.
  await expect
    .poll(() => planner.locator(".card .code, .lv-code").count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect(planner.locator(BAR), "the offer came back in the same session after being refused").toHaveCount(0);
});

/** The project this build points at, read from `.env.local` exactly as
 * `plan-conflict.spec.ts` reads it: Vite bakes the value into the bundle,
 * and Playwright's own process never sees it, so a session has to be
 * stored under the key the client will actually look for. The anon key and
 * project ref are public by design and ship in the bundle. */
const PROJECT_REF = (() => {
  try {
    const env = fs.readFileSync(path.resolve(here, "..", ".env.local"), "utf-8");
    const url = /^VITE_SUPABASE_URL=(.+)$/m.exec(env)?.[1]?.trim() ?? "";
    return /https?:\/\/([^.]+)\./.exec(url)?.[1] ?? "";
  } catch {
    return "";
  }
})();

test("says nothing at all to a student who is already signed in", async ({ page, colorScheme }) => {
  // Their plan is already being kept. A bar promising to keep it would be
  // the chart carrying a message about something already true.
  test.skip(!PROJECT_REF, "no .env.local, so no session can be stored under the key this build reads");

  await page.route("**/auth/v1/**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "student@psu.edu" }),
    }),
  );
  // The account holds nothing, which is the ordinary case for a student
  // who signed in from this very offer. Both the read and the write that
  // follows it are answered here so no request leaves the machine.
  await page.route("**/rest/v1/plans**", (route: Route) =>
    route.fulfill({ status: route.request().method() === "GET" ? 200 : 201, contentType: "application/json", body: "[]" }),
  );

  const far = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  await page.addInitScript(
    ([planKey, plan, theme, authKey, session]) => {
      window.localStorage.setItem(planKey as string, plan as string);
      window.localStorage.setItem("lionsdegree-theme", theme as string);
      window.localStorage.setItem(authKey as string, session as string);
    },
    [
      "psu-planner-plan-v1",
      JSON.stringify(SEEDED_PLAN),
      colorScheme === "dark" ? "dark" : "light",
      `sb-${PROJECT_REF}-auth-token`,
      JSON.stringify({
        access_token: "test-token-not-a-real-jwt",
        token_type: "bearer",
        expires_at: far,
        expires_in: 60 * 60 * 24 * 365,
        refresh_token: "test-refresh",
        user: {
          id: "00000000-0000-0000-0000-000000000001",
          aud: "authenticated", role: "authenticated", email: "student@psu.edu",
          app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString(),
        },
      }),
    ] as const,
  );

  await page.goto("/plan/");
  await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
  // NOT VACUOUS: the session has to have been believed, or this would pass
  // on a page where nobody is signed in and the bar is simply late.
  await expect(page.getByRole("button", { name: /student/i }), "the stored session was not believed").toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(2000);
  await expect(page.locator(BAR), "a signed-in student was offered an account").toHaveCount(0);
});

test("does not take the screen away from the plan", async ({ planner }) => {
  // #23 IS THE PRECEDENT. One element wider than a phone made the page
  // impossible to use, and the lesson was that a phone has no room to
  // spare. So this is in the layout rather than floating over the chart:
  // it sits below it, the chart keeps the rest, and the document is still
  // the width of the screen.
  test.skip(!(await syncIsConfigured(planner)), "this build has no VITE_SUPABASE_URL, so there is no account to offer");
  await planner.setViewportSize({ width: 412, height: 915 });
  const bar = planner.locator(BAR);
  await expect(bar).toBeVisible({ timeout: 15_000 });

  const boxes = await planner.evaluate((sel) => {
    const b = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
    const chart = document.querySelector<HTMLElement>(".viewport, .listview")!.getBoundingClientRect();
    // `#main`, not the chart alone. A floating bar at the bottom of the
    // screen can sit below the chart and still be ON TOP of the main
    // region — which is exactly the layout this decision rejected, and a
    // chart-only measurement passes it.
    const main = document.querySelector<HTMLElement>("#main")!.getBoundingClientRect();
    const d = document.documentElement;
    return {
      barTop: b.top, barHeight: b.height, barRight: b.right,
      mainBottom: main.bottom, chartHeight: chart.height,
      overflow: Math.max(d.scrollWidth - d.clientWidth, document.body.scrollWidth - d.clientWidth),
      screen: d.clientWidth, viewportHeight: window.innerHeight,
    };
  }, BAR);

  expect(
    boxes.barTop,
    `the offer overlaps the plan by ${Math.round(boxes.mainBottom - boxes.barTop)}px instead of taking a row of its own`,
  ).toBeGreaterThanOrEqual(boxes.mainBottom - 1);
  expect(boxes.barRight, "the offer runs off the side of the screen").toBeLessThanOrEqual(boxes.screen + 1);
  expect(boxes.overflow, "the offer made the page scroll sideways").toBeLessThanOrEqual(1);
  expect(
    boxes.barHeight,
    `the offer takes ${Math.round((boxes.barHeight / boxes.viewportHeight) * 100)}% of a 915px screen`,
  ).toBeLessThan(boxes.viewportHeight * 0.25);
  expect(boxes.chartHeight, "the chart was squeezed to nothing").toBeGreaterThan(boxes.viewportHeight * 0.3);
});
