/** Privacy and Terms, as documents.
 *
 * These were in landing.spec.ts from when the legal pages were offshoots of
 * the landing page. They moved here, as they were, when that file was
 * rewritten for the new landing page (#64).
 */
import { test, expect, expectNoA11yViolations } from "./fixtures";

test.describe("the legal documents", () => {
  // These are the pages an OAuth reviewer at Google or Microsoft opens to
  // verify the app, and neither reviewer's crawler runs React. They are also
  // the only place a visitor who never opens the planner can read a policy at
  // all, which is why they are documents and not a modal.
  test.use({ javaScriptEnabled: false });

  for (const [path, heading] of [
    ["/privacy/", /privacy policy/i],
    ["/terms/", /terms of use/i],
  ] as const) {
    test(`${path} is a real document with JavaScript off`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status(), `${path} did not serve`).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      // Substance, not just a title: the body has to actually render.
      expect((await page.locator("main").innerText()).length).toBeGreaterThan(600);
      // Reachable in both directions — a reviewer landing on one needs the other.
      await expect(page.getByRole("link", { name: /^privacy$/i })).toBeVisible();
      await expect(page.getByRole("link", { name: /^terms$/i })).toBeVisible();
      await expect(page.getByRole("link", { name: /home/i })).toBeVisible();
    });

  }

  test("the landing page links to both", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /^privacy$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^terms$/i })).toBeVisible();
  });

  test("a data request has a private route, not a public tracker", async ({ page }) => {
    // Filing a deletion request as a GitHub issue means publishing it.
    await page.goto("/privacy/");
    await expect(page.getByRole("link", { name: /ovk5113@psu\.edu/i })).toBeVisible();
  });
});

test.describe("the legal documents, with scripting on", () => {
  // axe injects and runs IN the page, so these cannot live in the block above
  // that turns JavaScript off -- there, the injection simply times out and the
  // failure reads like a violation.
  for (const path of ["/privacy/", "/terms/"] as const) {
    test(`${path} has no accessibility violations`, async ({ page }) => {
      await page.goto(path);
      await expectNoA11yViolations(page, path);
    });
  }
});
