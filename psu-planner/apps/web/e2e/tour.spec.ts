/** The first-run tour of the planner (#71).
 *
 * Every other spec starts with the tour already seen (fixtures.ts). This
 * one removes that flag in an init script of its own, which runs after the
 * fixture's, so the tour behaves as it does for a new student.
 */
import { SEEDED_PLAN, test, expect, expectNoA11yViolations } from "./fixtures";
import type { Page } from "@playwright/test";

const PLAN_KEY = "psu-planner-plan-v1";

/** A browser that has never seen the tour, with a plan in it. */
async function newStudent(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, plan]) => {
      window.localStorage.setItem(key as string, plan as string);
      if (!window.sessionStorage.getItem("tour-test-started")) {
        window.sessionStorage.setItem("tour-test-started", "1");
        window.localStorage.removeItem("lionsdegree-tour-done");
      }
    },
    [PLAN_KEY, JSON.stringify(SEEDED_PLAN)] as const,
  );
  await page.goto("/plan/");
  await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
}

const card = (page: Page) => page.getByRole("dialog", { name: /This is your plan|What your degree|Try something|Add a minor|Keep your plan|Ask your own AI|You're set/ });

test("appears the first time a student sees their plan, pointing at the chart", async ({ page }) => {
  await newStudent(page);
  const tour = card(page);
  await expect(tour).toBeVisible({ timeout: 10_000 });
  await expect(tour).toContainText("This is your plan");
  await expect(tour).toContainText(/Step 1 of \d/);
  // Focus is in the card, so a keyboard user is in the tour, not behind it.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".tour-card"))).toBe(true);
});

test("walks through every step, forward and back, and names what the owner asked for", async ({ page }) => {
  await newStudent(page);
  const tour = card(page);
  await expect(tour).toBeVisible({ timeout: 10_000 });
  const titles: string[] = [];
  for (;;) {
    titles.push((await tour.getByRole("heading").innerText()).trim());
    // Each step points at a visible control, or sits in the middle of the
    // screen; either way the card is fully on screen.
    const box = (await tour.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
    const next = tour.getByRole("button", { name: "Next" });
    if (!(await next.count())) break;
    await next.click();
  }
  expect(titles[0]).toBe("This is your plan");
  expect(titles).toContain("Try something without risk");
  expect(titles).toContain("Add a minor, a master's, or AP credit");
  expect(titles[titles.length - 1]).toBe("You're set");
  // Back works.
  await tour.getByRole("button", { name: "Back" }).click();
  await expect(tour.getByRole("heading")).toHaveText(titles[titles.length - 2]!);
  // Done ends it.
  await tour.getByRole("button", { name: "Next" }).click();
  await tour.getByRole("button", { name: "Done" }).click();
  await expect(card(page)).toHaveCount(0);
});

test("skips at once, with the button or Escape, and does not come back", async ({ page }) => {
  await newStudent(page);
  await expect(card(page)).toBeVisible({ timeout: 10_000 });
  await card(page).getByRole("button", { name: "Skip tour" }).click();
  await expect(card(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await expect(card(page), "the tour came back after it was skipped").toHaveCount(0);
});

test("Escape ends it", async ({ page }) => {
  await newStudent(page);
  await expect(card(page)).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
});

test("can be taken again from the Menu", async ({ planner }) => {
  // The fixture's student has seen it.
  await planner.waitForTimeout(1200);
  await expect(card(planner)).toHaveCount(0);
  await planner.getByRole("button", { name: /^Menu/ }).click();
  await planner.getByRole("menuitem", { name: "Take the tour" }).click();
  await expect(card(planner)).toBeVisible();
  await expect(card(planner)).toContainText("This is your plan");
});

test("fits the screen and passes axe while it is open", async ({ page }) => {
  await newStudent(page);
  await expect(card(page)).toBeVisible({ timeout: 10_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "the tour pushed the page wider than the screen").toBeLessThanOrEqual(1);
  await expectNoA11yViolations(page, "the planner with the tour open");
});

test("is not shown over setup, before there is a plan", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.removeItem("lionsdegree-tour-done"));
  await page.goto("/plan/");
  await expect(page.getByRole("button", { name: /build my flowchart/i }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await expect(card(page)).toHaveCount(0);
});
