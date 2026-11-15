import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/** The FAST suite only.
 *
 * e2e/ holds Playwright specs, which vitest would otherwise collect by its
 * default `**\/*.spec.ts` glob and then fail on, because they import
 * @playwright/test. Keeping them apart is what lets `pnpm -r test` stay a
 * two-second feedback loop. */
export default defineConfig({
  resolve: {
    // The same alias vite.config.ts and tsconfig.json carry, because the
    // store reaches the connector's sandbox to recompute a Candidate tab
    // and three resolvers have to agree about where that is. See the
    // comment on the vite alias for why it is an alias and not a
    // workspace dependency.
    alias: { "@connector": resolve(__dirname, "../../packages/mcp/src") },
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
