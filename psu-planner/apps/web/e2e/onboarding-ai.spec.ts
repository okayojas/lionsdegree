/** Setup: an optional last step that says the plan can be used with your
 * own AI, and hands over the connection link (the owner, 2026-11-17).
 *
 * The connector is one of the things LionsDegree does that nothing else
 * does for Penn State students, and setup is the one screen every student
 * reads top to bottom. What is held here: the step is there, optional, after
 * the other steps; the link it copies is the real one; it does not get in
 * the way of building the plan; and it fits a phone.
 */
import { test, expect, expectNoA11yViolations } from "./fixtures";
import type { Page } from "@playwright/test";

const MAJOR = "engineering-engineering-science-bs";

/** Is account sync configured in this build? Without it there is nothing
 * for an assistant to read, so the step is rightly not shown. */
async function accountsHere(page: Page): Promise<boolean> {
  return (await page.getByRole("button", { name: /^Sign in$/ }).count()) > 0;
}

async function setup(page: Page): Promise<void> {
  await page.goto(`/plan/?programs=${MAJOR}`);
  await expect(page.getByRole("heading", { name: /AP exams/ })).toBeVisible({ timeout: 30_000 });
}

const step = (page: Page) => page.getByRole("heading", { name: "8 · Use your plan with your AI (optional)" });

test("offers the AI as the last, optional step, after the others and before the build button", async ({ page }) => {
  await setup(page);
  test.skip(!(await accountsHere(page)), "this build has no account service, so there is nothing for an AI to read");
  await expect(step(page)).toBeVisible();
  const schedule = page.getByRole("heading", { name: /^7 · Already have a schedule/ });
  const build = page.getByRole("button", { name: /build my flowchart/i }).first();
  const at = async (l: ReturnType<Page["getByRole"]>) => (await l.boundingBox())!.y;
  expect(await at(schedule)).toBeLessThan(await at(step(page)));
  expect(await at(step(page))).toBeLessThan(await at(build));
  // It says what you get, and where the full walkthrough is.
  await expect(page.getByText(/Connect Claude or ChatGPT and ask about your plan in your own words/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Full instructions, including ChatGPT" })).toHaveAttribute("href", "/connect/");
});

test("copies the real connection link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page);
  test.skip(!(await accountsHere(page)), "this build has no account service");
  await page.getByRole("button", { name: "Copy the connection link" }).click();
  await expect(page.getByRole("button", { name: "Copy the connection link" })).toHaveText("Copied");
  await expect(page.getByText(/Copied\. Paste it into your assistant once your plan is built/)).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://mcp.lionsdegree.com/mcp");
});

test("is skippable: building the plan works without touching it", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  const generate = page.getByRole("button", { name: /build my flowchart/i }).first();
  await generate.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await generate.click();
  await expect
    .poll(() => page.locator(".card .code, .lv-code").count(), { timeout: 90_000 })
    .toBeGreaterThan(0);
});

test("fits a phone and passes axe", async ({ page }) => {
  await setup(page);
  test.skip(!(await accountsHere(page)), "this build has no account service");
  await step(page).scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "the AI step pushed the page wider than the screen").toBeLessThanOrEqual(1);
  await expectNoA11yViolations(page, "setup, with the AI step");
});
