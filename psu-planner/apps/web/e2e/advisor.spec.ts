/** The advisor, in a build that HAS one (#7).
 *
 * Runs only under the `advisor` project, which serves a separate build made
 * with VITE_CHAT_ENDPOINT set. That separation is the point: the advisor is
 * BUILD-TIME configuration, so every other project runs against a build with
 * no advisor compiled in. Without this file the gate could be inverted and
 * the whole suite would stay green -- "with configuration present the chat
 * behaves exactly as today" was asserted nowhere.
 */
import { test, expect } from "./fixtures.js";

test.describe("with an advisor configured", () => {
  test("offers the Advisor tab alongside the audit", async ({ planner }) => {
    const tabs = await planner.locator(".sidepanel-tabs button").allTextContents();
    expect(tabs.join(" ")).toMatch(/Advisor/i);
    expect(tabs.join(" ")).toMatch(/Requirements/i);
  });

  test("opens on the advisor, not on the audit", async ({ planner }) => {
    // The default tab follows configuration: audit when there is no advisor,
    // advisor when there is.
    await expect(planner.locator(".sidepanel-tabs button.active")).toHaveText(/Advisor/i);
  });

  test("compiles the endpoint into this build and no other", async ({ planner }) => {
    const found = await planner.evaluate(async () => {
      const srcs = [...document.querySelectorAll("script[src]")].map((s) => (s as HTMLScriptElement).src);
      for (const s of srcs) {
        if ((await (await fetch(s)).text()).includes("/v1/chat")) return true;
      }
      return false;
    });
    expect(found, "the configured build has no chat endpoint in it").toBe(true);
  });

  test("keeps the sign-in gate that was already there", async ({ planner }) => {
    // Supabase is configured in this environment and nobody is signed in, so
    // the advisor asks for sign-in rather than offering a composer. That is
    // pre-existing behaviour and must be unchanged by config-gating.
    const panel = planner.locator(".sidepanel");
    await expect(panel).toContainText(/sign in/i);
  });

  test("has no accessibility violations with the advisor present", async ({ planner }) => {
    const { expectNoA11yViolations } = await import("./fixtures.js");
    await expectNoA11yViolations(planner, "the planner with an advisor configured");
  });
});
