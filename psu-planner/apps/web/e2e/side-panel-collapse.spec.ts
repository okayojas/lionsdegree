/** Putting the side panel away.
 *
 * The Requirements panel takes a third of a laptop screen and, on a phone,
 * up to a third of its height under the plan. It is the right thing to
 * have open while checking a degree and dead weight while arranging one,
 * and until now the only way to get the room back was to drag the divider
 * to its 280px floor — which is not away, and is not possible on a phone
 * at all, where the divider is hidden.
 *
 * What is asserted here is what only a browser can say: that the plan
 * actually receives the room, that the control is the same element before
 * and after (so focus does not fall to the top of the page), that the
 * choice is still there after a reload, and that a collapsed panel is not
 * a new way to push a phone sideways (#23).
 */
import { test, expect, expectNoA11yViolations } from "./fixtures.js";
import type { Page } from "@playwright/test";

const toggle = (page: Page) => page.getByRole("button", { name: /side panel/i });
const audit = (page: Page) => page.getByRole("group", { name: "Requirements" });
/** The plan, whichever of its two views is showing. */
const plan = (page: Page) => page.locator("#main .viewport, #main .listview").first();

const area = async (page: Page) => {
  const box = await plan(page).boundingBox();
  if (!box) throw new Error("the plan is not on screen");
  return box.width * box.height;
};

test.describe("the side panel", () => {
  test("is open to begin with, and says so", async ({ planner }) => {
    // The audit is the panel's whole content in a build with no advisor.
    // A panel that started closed would hide the one thing in it from
    // every student who has never seen it.
    await expect(audit(planner)).toBeVisible({ timeout: 30_000 });
    await expect(toggle(planner)).toHaveAttribute("aria-expanded", "true");
  });

  test("can be put away, and the plan takes the room", async ({ planner }) => {
    await expect(audit(planner)).toBeVisible({ timeout: 30_000 });
    const before = await area(planner);

    await toggle(planner).click();

    await expect(audit(planner), "the panel is still showing its content").toBeHidden();
    await expect(toggle(planner)).toHaveAttribute("aria-expanded", "false");
    // THE POINT OF THE FEATURE. A panel that hides its content and keeps
    // its width has taken the audit away and given nothing back.
    await expect
      .poll(() => area(planner), { message: "the plan did not get the room the panel gave up" })
      .toBeGreaterThan(before * 1.08);
    // It still says what it is: a strip with no name is a strip nobody
    // knows how to bring back.
    await expect(toggle(planner)).toContainText(/requirements/i);
  });

  test("comes back, with the audit in it", async ({ planner }) => {
    await expect(audit(planner)).toBeVisible({ timeout: 30_000 });
    const before = await area(planner);
    await toggle(planner).click();
    await expect(audit(planner)).toBeHidden();

    await toggle(planner).click();

    await expect(audit(planner)).toBeVisible();
    await expect(toggle(planner)).toHaveAttribute("aria-expanded", "true");
    // And the plan gives the room back, rather than the panel being drawn
    // over it.
    await expect.poll(() => area(planner)).toBeLessThan(before * 1.02);
  });

  test("works from the keyboard and keeps focus where it was", async ({ planner }) => {
    await expect(audit(planner)).toBeVisible({ timeout: 30_000 });
    await toggle(planner).focus();
    await planner.keyboard.press("Enter");
    await expect(audit(planner)).toBeHidden();
    // THE SAME CONTROL, still focused. If collapsing swapped one button
    // for another, focus would drop to <body> and the next Tab would start
    // from the top of the page — on the one control whose whole job is to
    // be pressed twice.
    await expect(toggle(planner)).toBeFocused();
    await planner.keyboard.press("Enter");
    await expect(audit(planner)).toBeVisible();
    await expect(toggle(planner)).toBeFocused();
  });

  test("stays the way it was left", async ({ planner }) => {
    await expect(audit(planner)).toBeVisible({ timeout: 30_000 });
    await toggle(planner).click();
    await expect(audit(planner)).toBeHidden();

    await planner.reload();
    await expect(planner.getByRole("banner")).toBeVisible({ timeout: 30_000 });
    await expect(toggle(planner), "the panel reopened itself on reload").toHaveAttribute("aria-expanded", "false");
    await expect(audit(planner)).toBeHidden();

    // And the other way: opening it is remembered too, or a student who
    // closed it once could never get it to stay open again.
    await toggle(planner).click();
    await expect(audit(planner)).toBeVisible({ timeout: 30_000 });
    await planner.reload();
    await expect(planner.getByRole("banner")).toBeVisible({ timeout: 30_000 });
    await expect(toggle(planner)).toHaveAttribute("aria-expanded", "true");
  });

  test("keeps your place in the list", async ({ planner }) => {
    // Putting the panel away removes its scroll box from layout, and a box
    // that is not laid out has no scroll position: without care the audit
    // comes back at the top every time. A student checking the bottom of a
    // long degree, who put the panel away to look at the chart for a
    // second, would be made to find their place again on every glance.
    //
    // WHAT THIS DOES AND DOES NOT PROVE. It pins the property. It cannot
    // tell the app's own save-and-restore from Chromium's, because Chromium
    // puts the position back by itself when the box returns — measured: it
    // reads 0 while hidden and its old value afterwards — so this passes in
    // this suite with the restore deleted. The restore is there for engines
    // that do not do that, and no such engine runs here. Do not read a
    // green run as evidence about Safari.
    await expect(audit(planner)).toBeVisible({ timeout: 30_000 });
    const scrollable = await audit(planner).evaluate((el) => el.scrollHeight - el.clientHeight);
    test.skip(scrollable < 80, "the audit fits without scrolling at this size");
    const want = Math.min(scrollable, 160);
    await audit(planner).evaluate((el, y) => { el.scrollTop = y; }, want);

    await toggle(planner).click();
    await expect(audit(planner)).toBeHidden();
    await toggle(planner).click();
    await expect(audit(planner)).toBeVisible();

    await expect
      .poll(() => audit(planner).evaluate((el) => el.scrollTop), { message: "the audit came back at the top" })
      .toBeGreaterThan(want - 4);
  });

  test("on a phone it is as wide as the screen, open or put away", async ({ planner }) => {
    // FOUND WHILE BUILDING THIS, AND OLDER THAN IT. The phone rule that
    // stacks the panel under the plan set `width: auto`, and the panel's
    // base rule — later in the file, same specificity — set it back to
    // 360px capped at 42vw. So on a 412px phone the open panel was 173px
    // wide with the other 58% of the row empty. Nothing measured its width,
    // so nothing noticed; a collapsed bar that IS full width made the
    // mismatch a visible jump.
    const divider = planner.getByRole("separator");
    test.skip(await divider.isVisible(), "side by side at this width; the panel is meant to be narrow");
    await expect(audit(planner)).toBeVisible({ timeout: 30_000 });
    const width = () => planner.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".sidepanel")!;
      return panel.getBoundingClientRect().width / window.innerWidth;
    });
    expect(await width(), "the open panel does not span the phone").toBeGreaterThan(0.98);
    await toggle(planner).click();
    await expect(audit(planner)).toBeHidden();
    expect(await width(), "the collapsed bar does not span the phone").toBeGreaterThan(0.98);
  });

  test("takes its divider with it", async ({ planner }) => {
    // The divider resizes the panel. With the panel away it would be a
    // col-resize cursor over a line that resizes nothing.
    const divider = planner.getByRole("separator");
    test.skip(!(await divider.isVisible()), "there is no divider at phone width");
    await toggle(planner).click();
    await expect(divider).toBeHidden();
    await toggle(planner).click();
    await expect(divider).toBeVisible();
  });

  test("put away, it does not push the page sideways or fail axe", async ({ planner }) => {
    await expect(audit(planner)).toBeVisible({ timeout: 30_000 });
    await toggle(planner).click();
    await expect(audit(planner)).toBeHidden();

    const overflow = await planner.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, "the collapsed panel made the page wider than the screen").toBeLessThanOrEqual(0);
    // Big enough to press: the strip IS the control now.
    const box = await toggle(planner).boundingBox();
    expect(Math.min(box!.width, box!.height), "the collapsed panel is too small a target").toBeGreaterThanOrEqual(44);
    await expectNoA11yViolations(planner, "the planner with the side panel put away");
  });
});
