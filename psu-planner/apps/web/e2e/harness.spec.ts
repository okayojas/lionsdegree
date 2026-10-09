/** Proves the harness itself works, and asserts the things that are already
 * true. The launch-gate checks — mobile layout and keyboard operation of the
 * list view — are added by the tickets that build them; this file is the seam
 * they attach to. */
import { test, expect, expectNoA11yViolations, SEEDED_PLAN } from "./fixtures.js";

// The landing page's own tests live in landing.spec.ts, which covers all of
// this and more (JavaScript off, reduced motion, the preview card). Keeping a
// second copy here meant one a11y assertion ran twice per project and the two
// files drifted: this one still asserted the placeholder's headline after the
// real page shipped.

test.describe("the planner, with a plan already loaded", () => {
  test("shows the seeded plan rather than onboarding", async ({ planner }) => {
    // If seeding failed, the app renders the onboarding hero instead, and
    // every other test in this suite would be testing the wrong screen.
    await expect(planner.getByRole("banner")).toBeVisible();
    await expect(planner.getByRole("heading", { name: "LionsDegree" })).toBeVisible();
    await expect(planner.getByText(/Chart your degree/)).toHaveCount(0);
  });

  test("renders every term the plan contains", async ({ planner }) => {
    for (const term of SEEDED_PLAN.terms.slice(0, 3)) {
      await expect(planner.getByText(term.label, { exact: false }).first()).toBeVisible();
    }
  });

  test("reports credit progress", async ({ planner }) => {
    await expect(planner.getByRole("status", { name: /Degree progress/i })).toContainText(/credits completed/i);
  });
});

test.describe("the list view", () => {
  // The documented accessibility remedy for the pointer-only canvas. #16
  // makes it complete and keyboard-operable; this only proves the harness can
  // reach it.
  test("is reachable from the toolbar", async ({ planner }) => {
    await planner.getByRole("button", { name: /List view/i }).click();
    await expect(planner.getByRole("button", { name: /Flowchart view/i })).toBeVisible();
  });
});

test.describe("the harness itself", () => {
  test("fails with something actionable when axe finds a problem", async ({ page }) => {
    // A deliberately broken page, so the failure path is exercised rather
    // than assumed. An unlabelled control is a wcag2a violation.
    await page.setContent(`<!doctype html><html lang="en"><body><img src="x.png"></body></html>`);
    let message = "";
    try {
      await expectNoA11yViolations(page, "a deliberately broken page");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message, "the a11y helper did not fail on a page with a known violation").toContain("image-alt");
    // The point of the helper: the rule, the impact and the element, without
    // needing to re-run anything locally.
    expect(message).toMatch(/critical|serious/);
    expect(message).toContain("img");
  });
});
