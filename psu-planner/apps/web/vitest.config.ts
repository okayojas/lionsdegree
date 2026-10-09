import { defineConfig } from "vitest/config";

/** The FAST suite only.
 *
 * e2e/ holds Playwright specs, which vitest would otherwise collect by its
 * default `**\/*.spec.ts` glob and then fail on, because they import
 * @playwright/test. Keeping them apart is what lets `pnpm -r test` stay a
 * two-second feedback loop. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
