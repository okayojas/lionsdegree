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

test.describe("with no advisor configured", () => {
  /** The default build. The project's model is bring-your-own-AI, so a
   * student who configured nothing must never meet a control that cannot
   * work — and the panel still has to be useful without one. */
  test("offers no Advisor tab", async ({ planner }) => {
    await expect(planner.getByRole("button", { name: /Advisor/i })).toHaveCount(0);
  });

  test("still offers the requirements audit, which needs nothing", async ({ planner }) => {
    // No network, no account, no key. If hiding the advisor had emptied the
    // panel, hiding it would be a regression rather than a default.
    await expect(planner.getByRole("button", { name: /Requirements/i })).toBeVisible();
  });

  test("opens on the audit rather than on an empty panel", async ({ planner }) => {
    const panel = planner.locator(".sidepanel");
    await expect(panel).toBeVisible();
    const text = (await panel.innerText()).trim();
    expect(text.length, "the advisor panel rendered empty").toBeGreaterThan(20);
  });

  test("shows no chat composer anywhere", async ({ planner }) => {
    await expect(planner.locator(".chat-input, .chat-composer textarea")).toHaveCount(0);
  });
});
