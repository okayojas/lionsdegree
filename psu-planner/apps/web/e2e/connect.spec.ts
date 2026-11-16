/** Connect your AI.
 *
 * The page exists because "paste a link into your settings" has to be
 * followable by a student who has never opened a terminal. These tests were
 * in landing.spec.ts while the page was an offshoot of the landing page; they
 * moved here, unchanged, when the discovery prompt moved to the page (#63).
 */
import { test, expect, expectNoA11yViolations } from "./fixtures";

test.describe("connecting an assistant", () => {
  // The page exists because "paste a link into your settings" has to be
  // followable by a student who has never opened a terminal. Everything here
  // is a property of THAT, not of styling.
  test.use({ javaScriptEnabled: false });

  test("reads with JavaScript off", async ({ page }) => {
    const res = await page.goto("/connect/");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/connect your ai/i);
    // The link itself must be plain selectable text, not injected by script:
    // someone setting up a connector is often on a locked-down machine.
    await expect(page.locator("#connector-url")).toContainText(/^https:\/\//);
  });

  test("shows no code anywhere", async ({ page }) => {
    await page.goto("/connect/");
    await expect(page.locator("pre, code"), "the connect page is showing code").toHaveCount(0);
    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const jargon of ["npx", "npm install", "json", "terminal", "command line", "stdio"]) {
      expect(body, `"${jargon}" appears on a page written for non-programmers`).not.toContain(jargon);
    }
  });

  test("is an ordered procedure, because the steps depend on each other", async ({ page }) => {
    await page.goto("/connect/");
    // Sign in BEFORE copying the link: the link is only meaningful once the
    // account exists. An unordered list would lose that.
    const steps = page.locator(".steps > li");
    await expect(steps).toHaveCount(4);
    await expect(steps.first()).toContainText(/sign in/i);
    await expect(steps.nth(1)).toContainText(/copy/i);
  });

  test("no longer says the connector is not live", async ({ page }) => {
    // INVERTED AT GO-LIVE (#38). The warning was right while the address
    // was dead; left up afterwards it turns away the students the whole
    // thing was built for.
    await page.goto("/connect/");
    await expect(page.locator(".pending"), "the not-live callout is still here").toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/not live yet/i);
  });

  test("is reachable from the landing page and the footer", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /connect your ai/i }).first()).toBeVisible();
  });
});

test.describe("connecting an assistant, with scripting on", () => {
  test("has no accessibility violations", async ({ page }) => {
    await page.goto("/connect/");
    await expectNoA11yViolations(page);
  });

  test("offers the address to copy, now that there is a service behind it", async ({ page }) => {
    // THE INVERSION THE OLD TEST ASKED FOR. The button was withheld
    // while the address was dead, because inviting the copy and
    // explaining underneath that it will not work is worse than not
    // offering it. The service exists, so the affordance comes back.
    await page.goto("/connect/");
    const copy = page.getByRole("button", { name: "Copy link", exact: true });
    await expect(copy, "there is nothing to press").toHaveCount(1);
    await expect(copy).toBeVisible();
    await expect(page.locator(".copyfield.is-pending"), "the address is still greyed out").toHaveCount(0);
  });

  test("puts the real address on the clipboard, not the label beside it", async ({ page, context }) => {
    // The button copies `#connector-url`. A student pastes whatever this
    // put there into a settings box they cannot easily check, so it has
    // to be the address and nothing else -- no stray whitespace, no
    // surrounding prose.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/connect/");
    await page.getByRole("button", { name: "Copy link", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied, "the clipboard did not get the connector address").toBe("https://mcp.lionsdegree.com/mcp");
  });

  test("advertises the transport path the connector will actually serve", async ({ page }) => {
    // THE BUG THIS REPLACES. The page published `/sse` for months. That is
    // the older MCP transport and not what will be served here, so a
    // student who saved the link was saving the wrong one -- and nothing
    // compared the published address to the intended one, which is exactly
    // why it went unnoticed. See the spec, issue 30.
    await page.goto("/connect/");
    const url = (await page.locator("#connector-url").innerText()).trim();
    expect(url, "the connect page still advertises the /sse transport").not.toContain("/sse");
    expect(url, `the advertised connector URL is ${url}`).toBe("https://mcp.lionsdegree.com/mcp");
  });
});

/** The prompt that finds a student their programs (#63).
 *
 * It is not an unbuilt feature and must not read as one. The engine ships in
 * the connector today; what it needs is a model to interpret "machine
 * learning and clean energy", and the model is the student's own. So the page
 * hands over the sentence that starts it, not a search box it has no business
 * rendering. It lived on the landing page until the landing page stopped
 * having room for it, and it belongs here anyway: this is where a student is
 * standing when they have just connected an assistant. */
const PROMPT =
  "I’m a Penn State student. Use LionsDegree to find programs that fit what I’m into: machine learning and clean energy. " +
  "Give me a major plus any minors and certificates that share credits with it, and send me the link to open the plan.";

test.describe("the discovery prompt", () => {
  test("is plain text a student can read and edit", async ({ page }) => {
    await page.goto("/connect/");
    const prompt = page.locator("#discovery-prompt");
    await expect(prompt).toBeVisible();
    // The words it had on the landing page, and English rather than an
    // incantation: this page is for people who have never opened a terminal.
    expect((await prompt.innerText()).replace(/\s+/g, " ").trim()).toBe(PROMPT);
    expect(PROMPT, "the prompt reads like code").not.toMatch(/[{}<>]|\bjson\b/i);
    // Text on the page, which a student can select part of and change. Not
    // a field that has to be filled in, and not an image of one.
    expect(await prompt.evaluate((el) => el.tagName)).not.toMatch(/^(INPUT|TEXTAREA|IMG)$/);
    // It names two interests that are not theirs, so the page says to
    // change them.
    await expect(page.locator("#discovery")).toContainText(/your own/i);
  });

  test("comes after the steps, and is not one of them", async ({ page }) => {
    // Finding a degree is something to do once connected. Numbering it
    // would make it a fifth thing a student has to do to connect.
    await page.goto("/connect/");
    await expect(page.locator(".steps > li")).toHaveCount(4);
    await expect(page.locator(".steps #discovery-prompt")).toHaveCount(0);
    const order = await page.evaluate(() => {
      const steps = document.querySelector(".steps")!;
      const prompt = document.getElementById("discovery-prompt")!;
      return Boolean(steps.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order, "the prompt is offered before the student has connected anything").toBe(true);
  });

  test("the copy button copies the prompt, and only the prompt", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/connect/");
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);
  });

  test("each of the two copy buttons says what it copies", async ({ page }) => {
    // Two buttons called "Copy" on one page are one button to a screen
    // reader's list of controls.
    await page.goto("/connect/");
    const names = await page.getByRole("button").evaluateAll((all) => all.map((b) => (b.textContent ?? "").trim()));
    expect(names).toEqual(["Copy link", "Copy prompt"]);
  });

  test("is linked from the landing page, which no longer repeats it", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#discovery-prompt")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Use LionsDegree to find programs");
    await expect(page.locator('a[href="/connect/#discovery"]')).toHaveCount(1);
    // And the link lands on it.
    await page.goto("/connect/#discovery");
    await expect(page.locator("#discovery-prompt")).toBeInViewport();
  });
});

test.describe("the discovery prompt, with JavaScript turned off", () => {
  test.use({ javaScriptEnabled: false });

  test("still reads, and offers no button that cannot work", async ({ page }) => {
    // The prompt is markup, not something a script writes in: a student on a
    // locked-down machine selects it by hand. A Copy button there would be a
    // control that does nothing when pressed, so there is none, here or
    // beside the connection link.
    await page.goto("/connect/");
    await expect(page.locator("#discovery-prompt")).toBeVisible();
    await expect(page.locator("#discovery-prompt")).toContainText("I’m a Penn State student.");
    await expect(page.locator("#connector-url")).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(0);
  });
});
