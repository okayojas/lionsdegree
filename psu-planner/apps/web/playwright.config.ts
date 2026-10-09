import { defineConfig, devices } from "@playwright/test";

/** The browser suite.
 *
 * SEPARATE from the fast suites on purpose. `pnpm -r test` runs engine,
 * pipeline, mcp and the web unit tests in a couple of seconds; this one starts
 * a browser and is measured in minutes. Mixing them would make the quick
 * feedback loop slow enough that people stop using it.
 *
 *   pnpm --filter web test:e2e
 *
 * It runs against the BUILT app, not the dev server: the launch gate is about
 * what ships, and a dev-server bundle is not that. */
export default defineConfig({
  testDir: "./e2e",
  // Everything here asserts on a freshly seeded plan, so order never matters.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4318",
    // Kept on the first retry only: enough to diagnose a CI failure without
    // writing a video for every green run.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // A real phone profile, because "most first visits are mobile" is the
    // reason the launch gate exists.
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    // Dark is not a variant, it is half the product: this palette was retuned
    // for it (navy is unusable in dark at 1.42:1). The other two projects pin
    // the theme to light so contrast assertions measure a known target, which
    // left every dark rule unexercised by the browser suite.
    { name: "desktop-dark", use: { ...devices["Desktop Chrome"], colorScheme: "dark" } },
  ],
  webServer: {
    // --host 127.0.0.1 is load-bearing: vite preview otherwise binds [::1]
    // only, and Playwright's readiness probe against 127.0.0.1 never answers,
    // so the suite dies on a 120s webServer timeout with no hint why.
    // Build first. `preview` serves whatever is in dist/, so without this the
    // suite happily tests the previous build -- source changes appear to have
    // no effect, and a green run proves nothing about the code in the tree.
    command: "npm run build && npm run preview -- --port 4318 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4318/plan/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
