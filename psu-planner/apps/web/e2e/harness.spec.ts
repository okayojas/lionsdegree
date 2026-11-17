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

  test("wears the site's header above its own tools", async ({ planner }) => {
    // The same top as every other page (the owner asked for it, 2026-11-16):
    // the brand, which is the way home and this page's heading, and the
    // site's links with this page marked. One banner holds it and the
    // toolbar, so the page still has one banner and one heading.
    const banner = planner.getByRole("banner");
    await expect(banner).toHaveCount(1);
    await expect(planner.getByRole("heading", { level: 1 })).toHaveText(["LionsDegree"]);
    await expect(banner.getByRole("link", { name: "LionsDegree", exact: true })).toHaveAttribute("href", "/");
    // No way in to the page you are already on.
    await expect(banner.getByRole("link", { name: "Start my plan" })).toHaveCount(0);
    const elsewhere = [
      ["Sample plans", "/sample-plans/"],
      ["Connect your AI", "/connect/"],
      ["About", "/about/"],
    ] as const;
    if (planner.viewportSize()!.width <= 760) {
      // A phone has no row to spare above the chart, so the links are in
      // the Menu, and the mark alone stands for the brand.
      await expect(banner.getByRole("navigation", { name: "Site" })).toHaveCount(0);
      await planner.getByRole("button", { name: /^Menu/ }).click();
      for (const [name, href] of elsewhere) {
        const item = planner.getByRole("menuitem", { name, exact: true });
        await expect(item).toBeVisible();
        await expect(item).toHaveAttribute("href", href);
      }
      await planner.keyboard.press("Escape");
    } else {
      const site = banner.getByRole("navigation", { name: "Site" });
      await expect(site.getByRole("link")).toHaveText(["Planner", ...elsewhere.map(([name]) => name)]);
      await expect(site.getByRole("link", { name: "Planner" })).toHaveAttribute("aria-current", "page");
      await expect(site.locator("[aria-current]")).toHaveCount(1);
      // In the header, so not in the Menu a second time.
      await planner.getByRole("button", { name: /^Menu/ }).click();
      await expect(planner.getByRole("menuitem", { name: "About", exact: true })).toHaveCount(0);
      await planner.keyboard.press("Escape");
      // The links are above the planner's tools, and nothing covers them.
      const links = (await site.boundingBox())!;
      const search = (await planner.getByPlaceholder("Search courses by code or description").boundingBox())!;
      expect(links.y + links.height).toBeLessThanOrEqual(search.y + 0.5);
    }
    await expectNoA11yViolations(planner);
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
    expect(text, "the side panel rendered empty with the advisor hidden").toMatch(/requirements/i);
  });

  test("shows no chat composer anywhere", async ({ planner }) => {
    // `.chat-input` is the real class; an earlier version also listed
    // `.chat-composer textarea`, which matches nothing in this codebase and
    // so asserted nothing.
    await expect(planner.locator(".chat-input")).toHaveCount(0);
    await expect(planner.locator(".sidepanel textarea")).toHaveCount(0);
  });
});
