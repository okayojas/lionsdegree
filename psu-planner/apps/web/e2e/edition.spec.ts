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

    // The picker is disabled until editions.json lands, and reports no
    // options at all until then -- reading it immediately measured nothing.
    await expect(editionPicker(page)).toBeEnabled({ timeout: 30_000 });
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

// SERIAL. Each of these generates a whole plan -- fetching templates, loading
// every course they name, then optimising. Run concurrently they starve each
// other and time out; run one at a time each takes about thirteen seconds.
test.describe.configure({ mode: "serial" });

test.describe("the chosen edition governs the plan", () => {
  // This runs onboarding end to end: pick a program, fetch its templates, load
  // every course they name, generate and optimise. It takes ~15s alone and
  // several times that when the rest of the suite is competing for the
  // machine, so the budget is generous on purpose -- a timeout here would be
  // a statement about the hardware, not about the code.
  test.setTimeout(240_000);

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

  /** Run onboarding to completion with a given edition.
   *
   * Returns the moment of choice, so the caller can judge requests by when
   * they STARTED. Clearing the buffer is not enough on its own: a request
   * issued under the default edition is recorded when it COMPLETES, which can
   * be after the clear, and it then looks like a post-choice read of the
   * wrong bulletin. (Its response is discarded by the generation guard in
   * catalogClient, so the plan is unaffected -- this is about measuring the
   * right thing.) */
  async function generateWith(page: Page, edition: string): Promise<number> {
    await onboarding(page);
    await editionPicker(page).selectOption(edition);
    const chosenAt = await page.evaluate(() => {
      performance.clearResourceTimings();
      return performance.now();
    });
    await page.getByPlaceholder(/Search majors and minors/i).fill("Computer Science");
    // Wait for the filtered list rather than racing it: the index reloads
    // whenever the edition changes, so the row can be mid-render here.
    const row = page.locator(".prog-item", { hasText: /Computer Science/i }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.click();
    // The program has to actually BE picked. Without this the next step waits
    // on a button that is disabled precisely because nothing is selected, and
    // reports a timeout rather than the real cause.
    await expect(row, "clicking the program did not select it").toHaveClass(/picked/);

    // Its template has to finish loading too -- Build stays disabled until it
    // does, and on a phone profile that is well past the default timeout.
    // Generous INNER budgets. The describe-level timeout covers the test as a
    // whole, but each of these waits has its own, and under full-suite load
    // they were the ones expiring -- which reads as a product failure rather
    // than as a saturated machine.
    const build = page.getByRole("button", { name: /Build my flowchart/i });
    await expect(build).toBeEnabled({ timeout: 120_000 });
    await build.click();
    await expect(page.getByRole("banner")).toBeVisible({ timeout: 180_000 });
    return chosenAt;
  }

  // ONE generation, three claims. Each of these used to build a whole plan of
  // its own -- three full catalog loads and optimiser runs for three
  // assertions about the same artifact, which was slow enough to make the
  // whole suite flaky under load.
  test("records it, shows it, and reads nothing from another bulletin", async ({ page }) => {
    const { editions, latest } = await published(page);
    const older = editions[0];
    test.skip(editions.length < 2, "only one edition is published in this build");

    const chosenAt = await generateWith(page, older);

    // Recorded. Waited for rather than assumed: the banner appears when the
    // store finishes, and reading storage in the same tick found it empty.
    await page.waitForFunction(
      () => !!window.localStorage.getItem("psu-planner-plan-v1"),
      undefined,
      { timeout: 60_000 },
    );
    const stored = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("psu-planner-plan-v1")!).edition,
    );
    expect(stored, "the plan did not record the chosen edition").toBe(older);

    // Shown, where a student can quote it to an adviser.
    await expect(
      page.getByText(new RegExp(older)).first(),
      "the chosen edition is nowhere on the plan",
    ).toBeVisible();

    // And nothing was read from a different bulletin after the choice.
    const fetched = await page.evaluate(
      (since) =>
        performance
          .getEntriesByType("resource")
          .filter((r) => r.startTime >= since)
          .map((r) => r.name)
          .filter((n) => n.includes("/catalog/") && /\d{4}-\d{4}/.test(n)),
      chosenAt,
    );
    expect(fetched.length, "no edition-scoped catalog files were read at all").toBeGreaterThan(0);
    const wrong = fetched.filter((u) => u.includes(latest) && !u.includes(older));
    expect(
      wrong,
      `read from ${latest} after the student chose ${older}: ${wrong.slice(0, 5).join(", ")}`,
    ).toEqual([]);
  });
});

test.describe("switching edition after choosing programs", () => {
  test.setTimeout(120_000);
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "catalog loading is not theme-dependent");
  });

  test("drops everything derived from the edition that was left behind", async ({ page }) => {
    // The scenario criterion 8 actually names. Every other test here picks the
    // edition FIRST, so none of them exercised a switch with state already on
    // screen -- which is where the mixing happens.
    const { editions, latest } = await published(page);
    test.skip(editions.length < 2, "only one edition is published in this build");

    await onboarding(page);
    await page.getByPlaceholder(/Search majors and minors/i).fill("Computer Science");
    const row = page.locator(".prog-item", { hasText: /Computer Science/i }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(row).toHaveClass(/picked/);

    // Tick a course off the template, so there is derived state to lose.
    const box = page.locator(".onboard input[type=checkbox]").first();
    const hadTrack = await box.count();
    if (hadTrack) await box.check();

    await editionPicker(page).selectOption(editions[0]);

    // WAIT for the new edition's list to render before asserting. Switching
    // blanks the index while it reloads, so "no picked item" is trivially
    // true for a moment -- this assertion passed with the clearing code
    // deleted until it waited for the list to come back.
    await expect(page.locator(".prog-item").first()).toBeVisible({ timeout: 30_000 });

    // The selection cannot carry: program slugs are not stable across
    // bulletins, and a course ticked off one template is not evidence about
    // another's requirements.
    await expect(
      page.locator(".prog-item.picked"),
      "a program picked under one bulletin survived the switch",
    ).toHaveCount(0);
    if (hadTrack) {
      await expect(
        page.locator(".onboard input[type=checkbox]:checked"),
        "a course ticked under one bulletin stayed ticked under another",
      ).toHaveCount(0);
    }
    expect(latest).not.toBe(editions[0]); // the switch was real
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
