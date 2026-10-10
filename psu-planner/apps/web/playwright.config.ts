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
    // Every other project runs against the DEFAULT build, which has no
    // advisor; advisor.spec.ts is excluded from them for that reason.
    { name: "desktop", testIgnore: /advisor\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    // A real phone profile, because "most first visits are mobile" is the
    // reason the launch gate exists.
    { name: "mobile", testIgnore: /advisor\.spec\.ts/, use: { ...devices["Pixel 7"] } },
    // Dark is not a variant, it is half the product: this palette was retuned
    // for it (navy is unusable in dark at 1.42:1). The other two projects pin
    // the theme to light so contrast assertions measure a known target, which
    // left every dark rule unexercised by the browser suite.
    { name: "desktop-dark", testIgnore: /advisor\.spec\.ts/, use: { ...devices["Desktop Chrome"], colorScheme: "dark" } },
    // Dark AND touch. Without it the `pointer: coarse` rules were only ever
    // rendered in light and the phone layer only ever in dark on a project
    // with a mouse -- so the combination a student actually has, a dark phone,
    // was the one combination nothing exercised.
    { name: "mobile-dark", testIgnore: /advisor\.spec\.ts/, use: { ...devices["Pixel 7"], colorScheme: "dark" } },
    // The advisor is BUILD-TIME configuration, so the only way to exercise
    // the configured half is a second build served on its own port. Without
    // this, inverting the chatConfigured gate left the whole suite green:
    // every test ran against a build with no advisor in it.
    {
      name: "advisor",
      testMatch: /advisor\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4319" },
    },
  ],
  webServer: [
    {
    // --host 127.0.0.1 is load-bearing: vite preview otherwise binds [::1]
    // only, and Playwright's readiness probe against 127.0.0.1 never answers,
    // so the suite dies on a 120s webServer timeout with no hint why.
    // Build first. `preview` serves whatever is in dist/, so without this the
    // suite happily tests the previous build -- source changes appear to have
    // no effect, and a green run proves nothing about the code in the tree.
    command: "npm run build && npm run preview -- --port 4318 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4318/plan/",
    // NEVER reuse. The command above builds first precisely so a run tests
    // the code in the tree -- and reusing a server started by an earlier run
    // skips that build, serving stale dist. That cost real debugging time
    // twice: a CSS fix that was present in the source and in a fresh build
    // was measured as "not applying", and a suite was diagnosed as flaky when
    // it was testing old bytes. A few seconds per run is the right trade.
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The same app built WITH an advisor configured. Same-origin endpoint,
      // so it matches what deploy:self-host produces.
      // Its OWN output directory. Both servers start together, and a second
      // build writing to dist/ would overwrite the first server's bytes --
      // the default build would then be serving the advisor one.
      command:
        "npm run build -- --outDir dist-advisor && npm run preview -- --outDir dist-advisor --port 4319 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:4319/plan/",
      env: { VITE_CHAT_ENDPOINT: "/v1/chat" },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
