/** Nothing on a phone may be wider than the phone (#23).
 *
 * THE FAILURE THIS GUARDS, and it is worse than a sideways scrollbar.
 * Onboarding's prior-credit step renders each requirement as a row of
 * checkboxes — the course, then every same-credit alternative beside it.
 * ACCTG 410 lists ten, and the row could not wrap, so it laid out 865px
 * wide on a 412px screen.
 *
 * Chrome does not simply clip that. On a touch device it widens the
 * LAYOUT VIEWPORT to fit the content and scales the whole page down:
 * `innerWidth` went 412 -> 907, `innerHeight` 839 -> 1845, the document
 * grew from 2455px to 3687px, and "Build my flowchart" settled 827px
 * below the furthest a student could scroll. One un-wrappable row made it
 * impossible to create a plan on a phone at all.
 *
 * So the property asserted here is not "no sideways scrolling" but the
 * thing that goes wrong first: the layout viewport must still be the
 * screen. A page that has been silently zoomed out fails here, which is
 * what nothing caught for the three weeks #23 sat open as a question.
 */
import { test, expect, type Page } from "@playwright/test";

/** A real major WITH a suggested-plan grid, so onboarding will offer to
 * generate from it. Duplicated from `deep-link.spec.ts` rather than
 * shared: that file memoises per worker and this one wants its own. */
async function aMajorWithAGrid(baseURL: string): Promise<string> {
  const idx = (await (await fetch(`${baseURL}/catalog/2026-2027/programs_index.json`)).json()) as {
    slug: string; type: string;
  }[];
  for (const p of idx.filter((x) => x.type === "major").slice(0, 6)) {
    const prog = (await (
      await fetch(`${baseURL}/catalog/2026-2027/programs/majors/${p.slug}.json`)
    ).json()) as { suggestedPlans?: { semesters?: unknown[] }[] };
    if (prog.suggestedPlans?.some((sp) => (sp.semesters?.length ?? 0) > 0)) return p.slug;
  }
  throw new Error("no major in the first 6 of the shipped catalog has a plan grid");
}

/** The measurement, plus the widest thing on the page so a failure names
 * the culprit instead of only the symptom. */
async function overflow(page: Page, screenWidth: number) {
  // Measured against the SCREEN, not `innerWidth`. Once Chrome has widened
  // the layout viewport to fit the offender, nothing is wider than
  // `innerWidth` any more — the first version of this reported an empty
  // list on exactly the failure it was written for.
  return page.evaluate((screen) => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    widest: [...document.querySelectorAll("*")]
      .map((e) => ({ e, w: e.getBoundingClientRect().width }))
      .filter((x) => x.w > screen + 1)
      .sort((a, b) => b.w - a.w)
      .slice(0, 3)
      .map((x) => `<${x.e.tagName.toLowerCase()}${typeof x.e.className === "string" && x.e.className ? ` class="${x.e.className}"` : ""}> ${Math.round(x.w)}px: ${(x.e.textContent ?? "").slice(0, 60)}`),
  }), screenWidth);
}

test("onboarding fits the screen it is on", async ({ page, baseURL }, testInfo) => {
  // Desktop too. The property is "the page fits its viewport", which is
  // true of every width or the layout is wrong somewhere.
  test.setTimeout(120_000);
  const screen = page.viewportSize()!;
  await page.goto(`/plan/?programs=${await aMajorWithAGrid(baseURL!)}`);
  await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
  // The prior-credit step renders from the program's requirement sections,
  // which arrive after the first paint.
  await expect(page.getByRole("button", { name: /build my flowchart/i }).first()).toBeVisible({ timeout: 30_000 });

  // NOT VACUOUS. The bug needs a requirement with several alternatives
  // beside it; a program offering none would pass this test while the
  // layout was still broken for every student who picked a different one.
  const alternatives = page.locator(".onboard .step .grid label.check", { hasText: /^or / });
  await expect
    .poll(() => alternatives.count(), { timeout: 30_000, message: "no same-credit alternatives rendered, so the row this test is about does not exist on the page" })
    .toBeGreaterThan(3);

  const m = await overflow(page, screen.width);
  // The layout viewport is still the screen — i.e. the page has not been
  // zoomed out to fit something too wide for it.
  expect(
    m.innerWidth,
    `the page was scaled down to fit its own content: the layout viewport is ${m.innerWidth}px on a ${screen.width}px ${testInfo.project.name} screen. Widest: ${m.widest.join(" | ")}`,
  ).toBeLessThanOrEqual(screen.width);
  expect(
    m.scrollWidth,
    `the page is ${m.scrollWidth}px wide in a ${m.innerWidth}px viewport. Widest: ${m.widest.join(" | ")}`,
  ).toBeLessThanOrEqual(m.innerWidth);
});

test("the button that generates the plan is reachable by scrolling", async ({ page, baseURL }) => {
  // The consequence, measured directly rather than inferred. Scrolling as
  // far as the page allows has to bring the button onto the PHYSICAL
  // screen — not into `innerHeight`, which is the number that lied.
  test.setTimeout(120_000);
  const screen = page.viewportSize()!;
  await page.goto(`/plan/?programs=${await aMajorWithAGrid(baseURL!)}`);
  await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
  const generate = page.getByRole("button", { name: /build my flowchart/i }).first();
  await expect(generate).toBeVisible({ timeout: 30_000 });

  // RE-SCROLLED EACH TIME, because the page is still growing. The button
  // renders before the programs finish loading, so a single
  // `scrollTo(0, 999999)` pins to a maximum that is already stale by the
  // time the deep link's courses arrive — and the button ends up below
  // the viewport for a reason that has nothing to do with the bug. A
  // fixed sleep would paper over that; this waits for the thing it is
  // actually about.
  //
  // It still catches #23. When the layout viewport is scaled, the button
  // sits ~800px below the screen at a maximum scroll that never moves,
  // so re-scrolling changes nothing and this times out red.
  const whereIsIt = async () =>
    page.evaluate(() => {
      window.scrollTo(0, 999999);
      const b = [...document.querySelectorAll("button")].find((x) => /build my flowchart/i.test(x.textContent ?? ""))!;
      return b.getBoundingClientRect().y;
    });
  await expect
    .poll(whereIsIt, {
      timeout: 15_000,
      message: `the generate button never came within a ${screen.height}px screen at maximum scroll — a student cannot reach it`,
    })
    .toBeLessThanOrEqual(screen.height);
  expect(await whereIsIt(), "the generate button scrolled off the top instead of into view").toBeGreaterThan(-1);
});
