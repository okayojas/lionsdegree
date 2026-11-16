/** Shared setup for the browser suite.
 *
 * The planner is local-first: a plan lives in localStorage, and onboarding is
 * how it gets there. Running onboarding before every test would make this
 * suite slow and would test the wrong thing -- these tests are about what a
 * student can DO with a plan, not about creating one. So a real plan is
 * seeded before the page loads. */
import { test as base, expect, type Locator, type Page } from "@playwright/test";
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
  planner: async ({ page, colorScheme }, use) => {
    await page.addInitScript(
      ([key, plan, theme]) => {
        window.localStorage.setItem(key as string, plan as string);
        // Pin the theme so a runner's system preference cannot change what
        // the contrast checks are measuring. The `desktop-dark` project sets
        // `theme` to "dark" instead, so the dark rules are exercised against
        // a known target rather than whatever the machine happens to prefer.
        window.localStorage.setItem("lionsdegree-theme", theme as string);
      },
      [PLAN_KEY, JSON.stringify(SEEDED_PLAN), colorScheme === "dark" ? "dark" : "light"] as const,
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

/** Contrast of an element's text against the first opaque thing behind it. */
export async function contrast(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const lum = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const rgba = (css: string) => {
      // Everything on this page computes to rgb()/rgba() or color(srgb …).
      const n = css.match(/[\d.]+/g)!.map(Number);
      const unit = css.startsWith("color(") ? 255 : 1;
      return { r: n[0] * unit, g: n[1] * unit, b: n[2] * unit, a: n[3] ?? 1 };
    };
    const L = (c: { r: number; g: number; b: number }) => 0.2126 * lum(c.r) + 0.7152 * lum(c.g) + 0.0722 * lum(c.b);
    let ground = { r: 255, g: 255, b: 255 };
    for (let up: Element | null = node; up; up = up.parentElement) {
      const bg = rgba(getComputedStyle(up).backgroundColor);
      if (bg.a === 1) { ground = bg; break; }
    }
    const ink = rgba(getComputedStyle(node).color);
    // The ink may itself be translucent: lay it over the ground first.
    const laid = { r: ink.r * ink.a + ground.r * (1 - ink.a), g: ink.g * ink.a + ground.g * (1 - ink.a), b: ink.b * ink.a + ground.b * (1 - ink.a) };
    const [a, b] = [L(laid), L(ground)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}
