/** Connect your AI.
 *
 * The first two blocks were in landing.spec.ts while this page was an
 * offshoot of the landing page. They moved here when the discovery prompt
 * moved to the page (#63), as they were but for the first button's name: it
 * is "Copy link" now that the page has a second thing to copy.
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
    const steps = page.locator("ol.steps > li");
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
 * standing when they have just connected an assistant.
 *
 * Written out, as a visitor reads it. That makes this a second copy of the
 * words, and it is meant to be: a test that read the prompt off the page and
 * compared it to the page would agree with anything. */
const PROMPT =
  "I’m a Penn State student. Use LionsDegree to find programs that fit what I’m into: machine learning and clean energy. " +
  "Give me a major plus any minors and certificates that share credits with it, and send me the link to open the plan.";

test.describe("the discovery prompt", () => {
  test("is plain text a student can read and edit", async ({ page }) => {
    await page.goto("/connect/");
    const prompt = page.getByText("Use LionsDegree to find programs");
    await expect(prompt).toBeVisible();
    // The words it had on the landing page.
    expect((await prompt.innerText()).replace(/\s+/g, " ").trim()).toBe(PROMPT);
    // It names two interests that are not the student's, so the page says to
    // change them...
    await expect(page.getByText(/change the interests to your own/i)).toBeVisible();
    // ...and lets them: part of it can be selected and typed over, which
    // `user-select: all` (how the address beside the first button is set)
    // would not allow.
    const selected = await prompt.evaluate((el) => {
      const text = el.firstChild!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.indexOf("machine learning"));
      range.setEnd(text, text.textContent!.indexOf("clean energy") + "clean energy".length);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    expect(selected, "the interests cannot be selected on their own").toBe("machine learning and clean energy");
  });

  test("comes after the steps, and is not one of them", async ({ page }) => {
    // Finding a degree is something to do once connected. Numbered, it would
    // be a fifth thing a student has to do to connect; above the steps, it
    // would be offered before there is anything to paste it into.
    await page.goto("/connect/");
    const steps = page.getByRole("list").filter({ hasText: "Sign in to LionsDegree" }).getByRole("listitem");
    const lastStep = (await steps.filter({ hasText: "Sign in when it asks" }).boundingBox())!;
    const prompt = (await page.getByText("Use LionsDegree to find programs").boundingBox())!;
    expect(prompt.y, "the prompt is not below the last step").toBeGreaterThan(lastStep.y + lastStep.height);
    await expect(steps.filter({ hasText: "Use LionsDegree to find programs" }), "the prompt is a numbered step").toHaveCount(0);
  });

  test("the copy button copies the prompt, and only the prompt", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/connect/");
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);
  });

  test("each of the two copy buttons says what it copies", async ({ page }) => {
    // Two buttons called "Copy" on one page are one button, twice, in a
    // screen reader's list of controls.
    await page.goto("/connect/");
    await expect(page.getByRole("button", { name: "Copy link", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Copy prompt", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
  });

  test("an old link to the landing page's #discovery arrives at it", async ({ page }) => {
    // The prompt's box was `#discovery` on the landing page. Old addresses
    // keep working when a thing moves; About's did (about.spec.ts).
    await page.goto("/#discovery");
    await page.waitForURL(/\/connect\/#discovery$/);
    await expect(page.getByText("Use LionsDegree to find programs")).toBeInViewport();
  });
});

test.describe("the discovery prompt, with JavaScript turned off", () => {
  // With no script the landing page's scenes simply stack, so its link to the
  // prompt is on the page to be read and pressed like any other.
  test.use({ javaScriptEnabled: false });

  test("still reads, and offers no button that cannot work", async ({ page }) => {
    // The prompt is markup, not something a script writes in: a student on a
    // locked-down machine selects it by hand. A Copy button there would be a
    // control that does nothing when pressed, so there is none, here or
    // beside the connection link.
    await page.goto("/connect/");
    await expect(page.getByText("Use LionsDegree to find programs")).toBeVisible();
    await expect(page.getByText("https://mcp.lionsdegree.com/mcp")).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(0);
  });

  test("the landing page links to it, and no longer repeats it", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Use LionsDegree to find programs")).toHaveCount(0);
    const link = page.getByRole("link", { name: /a prompt for finding a major/i });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/connect\/#discovery$/);
    await expect(page.getByText("Use LionsDegree to find programs")).toBeInViewport();
  });

  test("an old link to #discovery lands on the link to where it went", async ({ page }) => {
    // Nothing can redirect here, so the id is on the link (as with #about).
    await page.goto("/#discovery");
    const link = page.getByRole("link", { name: /a prompt for finding a major/i });
    await expect(link).toBeInViewport();
    await expect(link).toHaveAttribute("href", "/connect/#discovery");
  });
});
