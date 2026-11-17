/** Changing Program, and trying another Program without risking the Plan (#69).
 *
 * Three things a student could not do before, each asserted where it
 * happens, in a browser:
 *
 *   - follow a link to a Program (the Sample plans page's "Open in the
 *     planner") when they already have a Plan, and get a what-if with that
 *     Program in it rather than their old Plan and silence;
 *   - change one Program for another in one step, from a button beside the
 *     Program's name, having read what would leave and what would come;
 *   - try a different Program inside a what-if, with the requirements
 *     beside the chart being that what-if's.
 *
 * What is asserted about the Plan is read off the stored document, not the
 * screen: with a what-if open, the screen is showing the what-if.
 */
import { SEEDED_PLAN, test, expect, expectNoA11yViolations } from "./fixtures";
import type { Page } from "@playwright/test";

const PLAN_KEY = "psu-planner-plan-v1";

/** The Program the seeded Plan is for, and one to change it to. */
const MINE = { slug: "engineering-engineering-science-bs", name: "Engineering Science, B.S." };
const OTHER = {
  slug: "engineering-mechanical-engineering-bs",
  name: "Mechanical Engineering, B.S. (Engineering)",
  /** What a what-if made for it is called: the name, cut to fit a tab. */
  tab: "Mechanical Engineering, B.S.",
};

const stored = async (page: Page) => JSON.parse((await page.evaluate((k) => window.localStorage.getItem(k), PLAN_KEY))!);
const rail = (page: Page) => page.getByRole("navigation", { name: /what-ifs/i });
const requirements = (page: Page) => page.getByRole("group", { name: "Requirements" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Your programs" });

/** Open the rail where it is one control (a phone). */
async function openRail(page: Page): Promise<void> {
  const toggle = rail(page).getByRole("button", { expanded: false });
  if (await toggle.count()) await toggle.click();
}

/** Press Tab until the focus is on a button or a text box whose name
 * matches. The keyboard and nothing else: a test that calls `.focus()` has
 * shown the control exists, not that a keyboard reaches it. */
async function tabTo(page: Page, name: RegExp, max = 250): Promise<void> {
  for (let stops = 0; stops < max; stops++) {
    await page.keyboard.press("Tab");
    const at = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return { tag: el?.tagName ?? "", name: (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim() };
    });
    if ((at.tag === "BUTTON" || at.tag === "INPUT") && name.test(at.name)) return;
  }
  throw new Error(`never reached ${name} by tabbing`);
}

/** Wait until the stored document holds `n` what-ifs.
 *
 * Before the rail is reached for: on a phone the rail turns into one
 * control the moment there is a what-if, so opening it earlier opens
 * nothing and the tab is then never on screen. */
async function whatIfsStored(page: Page, n: number): Promise<void> {
  await expect
    .poll(async () => ((await stored(page))?.candidates ?? []).length, { timeout: 25_000, message: "no what-if was made" })
    .toBe(n);
}

test.describe("a link to a program, with a plan already saved", () => {
  test("opens the program as a what-if, and leaves the plan exactly as it was", async ({ planner }) => {
    const before = await stored(planner);
    await planner.goto(`/plan/?programs=${OTHER.slug}`);
    await whatIfsStored(planner, 1);

    await openRail(planner);
    const tab = rail(planner).getByRole("button", { name: `Show the what-if "${OTHER.tab}"` });
    await expect(tab, "the link was ignored: no what-if was made").toBeVisible();
    await expect(tab).toHaveAttribute("aria-pressed", "true");
    await expect(rail(planner).getByText("Editing this what-if. Your plan is untouched.")).toBeVisible();
    // The tab says what it is a what-if OF.
    await expect(tab).toContainText(`${OTHER.name} instead of ${MINE.name}`);

    // THE PLAN IS UNTOUCHED, and the Program is in the what-if's own copy.
    const now = await stored(planner);
    expect(now.programs, "following a link changed the student's own programs").toEqual(before.programs);
    expect(now.terms, "following a link rescheduled the student's own plan").toEqual(before.terms);
    expect(now.candidates.map((c: { name: string }) => c.name)).toEqual([OTHER.tab]);
    expect(now.candidates[0].plan.programs).toEqual([OTHER.slug]);

    // Followed once: the link is out of the address, so a reload does not
    // make a second one.
    expect(new URL(planner.url()).searchParams.has("programs")).toBe(false);
  });

  test("the requirements beside the chart are the tab's: the what-if's, then the plan's", async ({ planner }) => {
    await planner.goto(`/plan/?programs=${OTHER.slug}`);
    await whatIfsStored(planner, 1);
    await expect(
      requirements(planner).getByRole("heading", { name: /Mechanical Engineering/ }),
      "the requirements are still the student's own plan's, under a what-if's chart",
    ).toBeVisible({ timeout: 20_000 });
    await expect(requirements(planner).getByRole("heading", { name: /Engineering Science/ })).toHaveCount(0);

    await openRail(planner);
    await rail(planner).getByRole("button", { name: "Show your own plan" }).click();
    await expect(requirements(planner).getByRole("heading", { name: /Engineering Science/ })).toBeVisible({ timeout: 20_000 });
    await expect(requirements(planner).getByRole("heading", { name: /Mechanical Engineering/ })).toHaveCount(0);
  });

  test("a link to a program nobody has makes nothing, and the plan is still there", async ({ planner }) => {
    await planner.goto("/plan/?programs=not-a-program-anyone-offers");
    await expect(planner.getByRole("banner")).toBeVisible({ timeout: 30_000 });
    await expect(planner.getByText(/names a program the catalog does not have/)).toBeVisible({ timeout: 30_000 });
    await expect(rail(planner).getByRole("button", { name: /^Show the what-if/ })).toHaveCount(0);
    expect((await stored(planner)).programs).toEqual(SEEDED_PLAN.programs);
  });
});

test.describe("changing one program for another", () => {
  /** From the button beside the Program's name to the question. */
  async function askToChange(page: Page): Promise<void> {
    const change = requirements(page).getByRole("button", { name: `Change ${MINE.name} for another program` });
    await expect(change, "there is no visible way to change a program").toBeVisible({ timeout: 20_000 });
    await change.click();
    await expect(dialog(page).getByText(`Change ${MINE.name} to…`)).toBeVisible();
    await dialog(page).getByRole("textbox", { name: /Search for the program to change/ }).fill(OTHER.name);
    await dialog(page).getByRole("button", { name: `Change to ${OTHER.name}` }).click();
    await expect(
      dialog(page).getByRole("heading", { name: `Change ${MINE.name} to ${OTHER.name}?` }),
    ).toBeVisible({ timeout: 20_000 });
  }

  test("says what would leave and what would come, before anything changes", async ({ planner }) => {
    await askToChange(planner);
    await expect(dialog(planner).getByText(/Leaves your plan:/)).toBeVisible();
    await expect(dialog(planner).getByText(/Comes in:/)).toBeVisible();
    await expect(dialog(planner).getByText(/Courses you have completed and courses you added yourself stay/)).toBeVisible();
    expect((await stored(planner)).programs, "the plan changed before the student agreed").toEqual(SEEDED_PLAN.programs);
    await expectNoA11yViolations(planner, "the programs dialog, asking about a change");
    // Nothing runs off the side of the screen, a phone included.
    const overflow = await planner.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "the dialog pushed the page wider than the screen").toBeLessThanOrEqual(1);

    // And they can say no.
    await dialog(planner).getByRole("button", { name: `Keep ${MINE.name}` }).click();
    await expect(dialog(planner).getByRole("heading", { name: /^Change .* to .*\?$/ })).toHaveCount(0);
    expect((await stored(planner)).programs).toEqual(SEEDED_PLAN.programs);
  });

  test("does it in one step, and the plan is never left with both or neither", async ({ planner }) => {
    await askToChange(planner);
    await dialog(planner).getByRole("button", { name: `Yes, change to ${OTHER.name}` }).click();
    await expect(dialog(planner)).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(async () => (await stored(planner)).programs).toEqual([OTHER.slug]);
    await expect(requirements(planner).getByRole("heading", { name: /Mechanical Engineering/ })).toBeVisible({ timeout: 20_000 });
    // What the student had done is still theirs.
    const now = await stored(planner);
    expect(now.completed).toEqual({ ...SEEDED_PLAN.completed, ...now.completed });
    for (const code of Object.keys(SEEDED_PLAN.completed)) expect(now.completed[code]).toBe(true);
  });

  test("inside a what-if, changes the what-if and not the plan", async ({ planner }) => {
    await openRail(planner);
    await rail(planner).getByRole("button", { name: /Make a new what-if/i }).click();
    await expect(planner.locator(".viewport.candidate")).toBeVisible({ timeout: 30_000 });
    const before = await stored(planner);

    await askToChange(planner);
    await dialog(planner).getByRole("button", { name: `Yes, change to ${OTHER.name}` }).click();
    await expect(dialog(planner)).toHaveCount(0, { timeout: 20_000 });

    await expect.poll(async () => (await stored(planner)).candidates[0].plan.programs).toEqual([OTHER.slug]);
    const now = await stored(planner);
    expect(now.programs, "a change made in a what-if changed the student's programs").toEqual(before.programs);
    expect(now.terms, "a change made in a what-if rescheduled the student's plan").toEqual(before.terms);
  });

  test("can be reached and done from the keyboard", async ({ planner }) => {
    // Tab, Enter and typing, from the top of the page to the change made.
    test.setTimeout(90_000);
    const change = requirements(planner).getByRole("button", { name: `Change ${MINE.name} for another program` });
    await expect(change).toBeVisible({ timeout: 20_000 });
    await tabTo(planner, /^Change Engineering Science, B\.S\. for another program$/);
    await planner.keyboard.press("Enter");
    await expect(dialog(planner).getByText(`Change ${MINE.name} to…`)).toBeVisible();
    await tabTo(planner, /^Search for the program to change/);
    await planner.keyboard.type(OTHER.name);
    await expect(dialog(planner).getByRole("button", { name: `Change to ${OTHER.name}` })).toBeVisible();
    await tabTo(planner, /^Change to Mechanical Engineering, B\.S\. \(Engineering\)$/);
    await planner.keyboard.press("Enter");
    await expect(dialog(planner).getByRole("button", { name: `Yes, change to ${OTHER.name}` })).toBeVisible({ timeout: 20_000 });
    await tabTo(planner, /^Yes, change to Mechanical Engineering/);
    await planner.keyboard.press("Enter");
    await expect.poll(async () => (await stored(planner)).programs, { timeout: 20_000 }).toEqual([OTHER.slug]);
  });
});
