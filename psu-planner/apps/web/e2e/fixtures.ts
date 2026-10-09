/** Shared setup for the browser suite.
 *
 * The planner is local-first: a plan lives in localStorage, and onboarding is
 * how it gets there. Running onboarding before every test would make this
 * suite slow and would test the wrong thing -- these tests are about what a
 * student can DO with a plan, not about creating one. So a real plan is
 * seeded before the page loads. */
import { test as base, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Generated from the real catalog by the engine, not hand-written: a plan
 * invented by hand would drift from what generatePlan actually produces, and
 * the tests would pass against a shape no student ever has. */
export const SEEDED_PLAN = JSON.parse(fs.readFileSync(path.join(here, "seeded-plan.json"), "utf-8"));

/** The localStorage key the store reads on boot. */
const PLAN_KEY = "psu-planner-plan-v1";

export const test = base.extend<{ planner: Page }>({
  /** A page at /plan/ with a plan already loaded and the catalog settled. */
  planner: async ({ page }, use) => {
    await page.addInitScript(
      ([key, plan]) => {
        window.localStorage.setItem(key as string, plan as string);
        // Pin the theme so a runner's system preference cannot change what
        // the contrast checks are measuring.
        window.localStorage.setItem("lionsdegree-theme", "light");
      },
      [PLAN_KEY, JSON.stringify(SEEDED_PLAN)] as const,
    );
    await page.goto("/plan/");
    // The store loads the catalog before the plan renders.
    await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
    await use(page);
  },
});

export { expect };

/**
 * Run axe and fail with something actionable.
 *
 * Playwright's own output for a failed array comparison is a wall of nested
 * objects. A violation you cannot act on without re-running locally is barely
 * better than no check, so the message names the rule, the impact, and the
 * element.
 */
export async function expectNoA11yViolations(page: Page, where: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const summary = results.violations.map(
    (v) =>
      `  ${v.impact ?? "unknown"}: ${v.id} — ${v.help}\n` +
      v.nodes.slice(0, 3).map((n) => `      ${n.target.join(" ")}\n        ${n.failureSummary?.split("\n").join("\n        ")}`).join("\n") +
      `\n      ${v.helpUrl}`,
  );

  expect(
    results.violations.length,
    summary.length ? `${where} has ${summary.length} accessibility violation(s):\n${summary.join("\n")}` : "",
  ).toBe(0);
}
