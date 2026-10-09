/** Choosing the bulletin Edition that governs a student (#3).
 *
 * Penn State fixes a degree's requirements to the Edition in force when the
 * student entered their major. A planner that always reads the newest
 * bulletin is confidently wrong for everyone except this year's first-years,
 * and wrong in the direction that matters: it adds requirements they do not
 * have and drops ones they do.
 */
import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";

/** The editions this build actually ships.
 *
 * Fetched through Playwright's request context rather than from inside the
 * page: a relative URL has no base until the page has navigated, and several
 * of these tests need the list BEFORE they open anything. */
async function published(page: Page): Promise<{ editions: string[]; latest: string }> {
  const res = await page.request.get("/catalog/editions.json");
  expect(res.ok(), "could not read editions.json from the built site").toBe(true);
  return res.json();
}

/** A fresh planner with no saved plan, so onboarding is what renders. */
async function onboarding(page: Page) {
  await page.goto("/plan/");
  await expect(page.getByText(/Chart your degree/i)).toBeVisible({ timeout: 30_000 });
}

const editionPicker = (page: Page) => page.getByLabel(/bulletin|edition/i).first();

test.describe("onboarding asks which bulletin governs you", () => {
  test("offers the editions this build ships, and nothing else", async ({ page }) => {
    await onboarding(page);
    const { editions } = await published(page);
    const offered = await editionPicker(page).locator("option").allTextContents();

    for (const ed of editions) {
      expect(offered.join(" "), `${ed} is published but not offered`).toContain(ed);
    }
    // Every concrete year-pair offered has to be one we actually have. The
    // "earlier than" option is deliberately not a year pair.
    for (const label of offered) {
      const years = label.match(/\d{4}-\d{4}/);
      if (years) expect(editions, `${years[0]} is offered but not published`).toContain(years[0]);
    }
  });

  test("defaults to the newest, so the common path needs no decision", async ({ page }) => {
    await onboarding(page);
    const { latest } = await published(page);
    await expect(editionPicker(page)).toHaveValue(latest);
  });

  test("explains what the choice means in words a student recognises", async ({ page }) => {
    // "Bulletin edition" is registrar vocabulary. A student knows when they
    // started their major, so the help text has to bridge the two.
    await onboarding(page);
    await expect(page.getByText(/entered|started|in force/i).first()).toBeVisible();
  });
});

test.describe("an edition older than everything published", () => {
  test("is offered, and says plainly that it is not theirs", async ({ page }) => {
    await onboarding(page);
    const { editions } = await published(page);
    const oldest = editions[0];

    const options = await editionPicker(page).locator("option").all();
    const earlier = [];
    for (const o of options) {
      const v = await o.getAttribute("value");
      if (v === "older") earlier.push(o);
    }
    expect(earlier.length, "no option for a student who started before our oldest bulletin").toBe(1);

    await editionPicker(page).selectOption("older");
    // Scoped to the notice itself: an unscoped text match finds the hidden
    // <option> carrying the same year pair and proves nothing.
    const note = page.locator(".ed-warn");
    await expect(note).toBeVisible();
    await expect(note, "the notice does not say which bulletin they get instead")
      .toContainText(oldest);
    await expect(note, "the notice does not say we lack theirs")
      .toContainText(/do not have|don.t have|oldest/i);
    // And it must not read as a dead end: the plan is still built.
    await expect(note).toContainText(/adviser/i);
  });
});

test.describe("the chosen edition governs the plan", () => {
  // These run onboarding end to end: pick a program, fetch its templates,
  // load the courses they name, generate and optimise. Genuinely slower than
  // the 30s default.
  test.setTimeout(120_000);

  // ONE project. Which bulletin a plan is pinned to has nothing to do with
  // theme or viewport, and running four concurrent plan generations starves
  // the machine badly enough that they time out -- each project passes on its
  // own. The picker's layout and colour ARE project-dependent and are covered
  // by the tests above, which run everywhere.
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "the generation path is identical across themes and viewports",
    );
  });

  /** Run onboarding to completion with a given edition. */
  async function generateWith(page: Page, edition: string) {
    await onboarding(page);
    await editionPicker(page).selectOption(edition);
    // Forget everything fetched before the choice. The picker defaults to the
    // newest edition, so the default view legitimately reads that catalog;
    // what matters is that nothing read from it AFTER the student chose.
    await page.evaluate(() => performance.clearResourceTimings());
    await page.getByPlaceholder(/Search majors and minors/i).fill("Computer Science");
    // Wait for the filtered list rather than racing it: the index reloads
    // whenever the edition changes, so the row can be mid-render here.
    const row = page.locator(".prog-item", { hasText: /Computer Science/i }).first();
    await expect(row).toBeVisible();
    await row.click();
    // The program has to actually BE picked. Without this the next step waits
    // on a button that is disabled precisely because nothing is selected, and
    // reports a timeout rather than the real cause.
    await expect(row, "clicking the program did not select it").toHaveClass(/picked/);

    // Its template has to finish loading too -- Build stays disabled until it
    // does, and on a phone profile that is well past the default timeout.
    const build = page.getByRole("button", { name: /Build my flowchart/i });
    await expect(build).toBeEnabled({ timeout: 60_000 });
    await build.click();
    await expect(page.getByRole("banner")).toBeVisible({ timeout: 90_000 });
  }

  test("is written onto the plan and survives a reload", async ({ page }) => {
    const { editions } = await published(page);
    const older = editions[0];
    await generateWith(page, older);

    const stored = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("psu-planner-plan-v1")!).edition,
    );
    expect(stored, "the plan did not record the chosen edition").toBe(older);
  });

  test("is visible on the plan, where a student can quote it to an adviser", async ({ page }) => {
    const { editions } = await published(page);
    const older = editions[0];
    await generateWith(page, older);
    await expect(page.getByText(new RegExp(older)).first()).toBeVisible();
  });

  test("never mixes one edition's courses with another's requirements", async ({ page }) => {
    // The failure this guards: the program templates are fetched BEFORE the
    // edition is pinned, so picking an older bulletin produced a plan built
    // from the newest catalog and then labelled with the older year.
    const { editions, latest } = await published(page);
    const older = editions[0];
    test.skip(editions.length < 2, "only one edition is published in this build");

    await generateWith(page, older);
    const fetched = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .filter((n) => n.includes("/catalog/") && /\d{4}-\d{4}/.test(n)),
    );
    const wrong = fetched.filter((u) => u.includes(latest) && !u.includes(older));
    expect(wrong, `catalog files read from ${latest} while the plan is pinned to ${older}:\n  ${wrong.slice(0, 5).join("\n  ")}`)
      .toEqual([]);
  });
});

test.describe("a plan saved before editions existed", () => {
  test("reads as the oldest published edition, which is what it was built against", async ({ planner }) => {
    // Editions accumulate forward (ADR-0001), so a plan older than our range
    // is nearer the oldest in requirements than the newest.
    const { editions } = await published(planner);
    await planner.addInitScript(() => {
      const key = "psu-planner-plan-v1";
      const plan = JSON.parse(window.localStorage.getItem(key)!);
      delete plan.edition;
      window.localStorage.setItem(key, JSON.stringify(plan));
    });
    await planner.reload();
    await expect(planner.getByRole("banner")).toBeVisible({ timeout: 30_000 });
    await expect(planner.getByText(new RegExp(editions[0])).first()).toBeVisible();
  });
});
