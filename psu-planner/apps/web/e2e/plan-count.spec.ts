/** The anonymous count of Plans is sent from the site itself and from
 * nowhere else (#70).
 *
 * This suite runs the same built code the site serves, on another host. If
 * it sent the count, every test run would write rows into the real
 * database, and a preview or a self-hosted copy would be counted as
 * students. So what is held here is the negative: building a Plan and
 * opening one sends nothing to the count's table.
 *
 * That the event is sent from the site's own host, once, and what is in
 * it, is held in `test/plan-count.test.ts`, where the host can be handed
 * in.
 */
import { test, expect } from "./fixtures";

const MAJOR = "engineering-engineering-science-bs";

test("building a plan and opening it again sends no count from this host", async ({ page }) => {
  test.setTimeout(120_000);
  const counted: string[] = [];
  page.on("request", (request) => {
    if (/plan_events/.test(request.url())) counted.push(`${request.method()} ${request.url()}`);
  });

  await page.goto(`/plan/?programs=${MAJOR}`);
  const generate = page.getByRole("button", { name: /build my flowchart/i }).first();
  await expect(generate).toBeVisible({ timeout: 30_000 });
  await generate.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await generate.click();
  await expect
    .poll(() => page.locator(".card .code, .lv-code").count(), { timeout: 90_000 })
    .toBeGreaterThan(0);
  // Long enough for something sent after the plan is on screen to have gone.
  await page.waitForTimeout(1500);

  await page.reload();
  await expect
    .poll(() => page.locator(".card .code, .lv-code").count(), { timeout: 60_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(1500);

  expect(counted, "a count was sent from a host that is not the site").toEqual([]);
  // And it has not pretended to have counted: the site itself still will.
  expect(await page.evaluate(() => window.localStorage.getItem("lionsdegree-plans-counted"))).toBeNull();
});

test("an existing plan opened here sends no count either", async ({ planner }) => {
  const counted: string[] = [];
  planner.on("request", (request) => {
    if (/plan_events/.test(request.url())) counted.push(request.url());
  });
  await planner.reload();
  await expect(planner.getByRole("banner")).toBeVisible({ timeout: 30_000 });
  await planner.waitForTimeout(1500);
  expect(counted).toEqual([]);
});
