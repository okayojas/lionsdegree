/** What-if tabs, in a real browser.
 *
 * The point of #56 is that a student can LOOK at a what-if in the chart
 * they already know how to read. That is a claim about pixels and
 * controls, so it is asserted here rather than at the store: that the rail
 * is there with their own plan first, that clicking a tab changes the
 * chart, that a what-if which cannot be worked out draws nothing at all,
 * that deleting one is not a risk to the plan, and that none of it is
 * mouse-only.
 *
 * The rail is new furniture on the left of the planner, so the width
 * guards from #23 are repeated here with it present. `mobile.spec.ts` and
 * `no-horizontal-overflow.spec.ts` both run against a plan with no
 * what-ifs on it, where the rail is not in the DOM at all — so neither of
 * them would have noticed a rail that pushed the chart off the screen.
 */
import { SEEDED_PLAN, test, expect, expectNoA11yViolations } from "./fixtures";
import type { Page } from "@playwright/test";

const PLAN_KEY = "psu-planner-plan-v1";

/** A change that still applies to the fixture, and one that never will. */
const SKIP_A_TERM = [{ tool: "skip_term", arguments: { term_index: 3 } }];
const ADD_A_COURSE_THAT_IS_NOT_THERE = [
  { tool: "add_course", arguments: { code: "NOPE 999", term_index: 0 } },
];

const candidate = (id: string, name: string, changes: unknown[]) => ({
  id, name, changes, basedOnRev: SEEDED_PLAN.rev, createdAt: "2026-11-01T12:00:00.000Z",
});

/** Put what-ifs on the seeded plan.
 *
 * `addInitScript` then `reload`, never `evaluate` then reload: the
 * fixture's own init script re-runs on every navigation and would write
 * the plain plan back over anything set from the page. */
async function withCandidates(page: Page, candidates: unknown[]): Promise<void> {
  await page.addInitScript(
    ([key, plan]) => window.localStorage.setItem(key as string, plan as string),
    [PLAN_KEY, JSON.stringify({ ...SEEDED_PLAN, candidates })] as const,
  );
  await page.reload();
  await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
}

const rail = (page: Page) => page.getByRole("navigation", { name: /what-ifs/i });

/** Open the rail if it is collapsed.
 *
 * ON A PHONE THE RAIL IS NOT A RAIL: 200px of tabs beside a 412px chart
 * is not available, so it starts as one control that opens the list. On a
 * wide screen there is no toggle and this does nothing — which is why
 * every test calls it rather than branching on the project name. Picking
 * a tab closes it again, so it is called before each reach. */
async function openRail(page: Page): Promise<void> {
  const toggle = rail(page).getByRole("button", { expanded: false });
  if (await toggle.count()) await toggle.click();
}

test.describe("the rail of what-ifs", () => {
  test("offers the + with no assistant connected, and nothing else", async ({ planner }) => {
    // THE WHOLE POINT OF #59. This fixture has no connector and no
    // what-ifs — which is every student on a first visit — and the rail
    // used to render nothing at all, so the feature was invisible to
    // them. A rail holding one tab is still not a comparison, so what is
    // here is the `+` and no tabs.
    await expect(
      rail(planner).getByRole("button", { name: /Make a new what-if/i }),
      "a student with no assistant has no way to make a what-if",
    ).toBeVisible();
    await expect(rail(planner).getByRole("button", { name: /^Show / })).toHaveCount(0);
    await expectNoA11yViolations(planner, "the planner with the what-if + and no what-ifs");
  });

  test("puts the student's own plan first and says which one is theirs", async ({ planner }) => {
    await withCandidates(planner, [
      candidate("c1", "finish in 7 terms", SKIP_A_TERM),
      candidate("c2", "abroad junior spring", SKIP_A_TERM),
    ]);
    await openRail(planner);

    const picks = rail(planner).getByRole("button", { name: /^Show / });
    await expect(picks).toHaveCount(3);
    // FIRST, and marked as theirs. The failure to avoid is a student
    // editing what they believe is their plan while a what-if is open.
    await expect(picks.first()).toHaveAccessibleName(/your own plan/i);
    await expect(picks.first()).toHaveAttribute("aria-pressed", "true");
    await expect(picks.nth(1)).toHaveAccessibleName(/finish in 7 terms/);
    await expect(picks.nth(2)).toHaveAccessibleName(/abroad junior spring/);
    // FIRST ON THE SCREEN, not merely first in the markup. A flex `order`
    // or a column-reverse would satisfy the document order above and
    // still put the student's own plan at the bottom of the rail, which
    // is the only place it matters.
    const tops = await picks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    expect(tops[0], `the student's own plan is not the top tab: ${tops.join(", ")}`)
      .toBeLessThan(Math.min(...tops.slice(1)));
    await expectNoA11yViolations(planner, "the planner with what-if tabs");
  });

  test("draws a different plan when a tab is clicked, and the real one when it is not", async ({ planner }) => {
    await withCandidates(planner, [candidate("c1", "a term off", SKIP_A_TERM)]);
    // The list view, because it says in WORDS what the chart says in
    // shapes — a gap term is a style on the canvas and a sentence here.
    await planner.getByRole("button", { name: /List view/i }).click();
    const list = planner.getByRole("region", { name: /list view/i });
    await expect(list).toBeVisible();
    await expect(list.getByText(/gap term/i)).toHaveCount(0);

    await openRail(planner);
    await rail(planner).getByRole("button", { name: /Show the what-if "a term off"/ }).click();
    // The whole plan is re-run through the optimiser, which takes a
    // moment the first time the catalog is read.
    await expect(
      planner.getByRole("region", { name: /What-if "a term off"/ }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      planner.getByText(/gap term/i).first(),
      "the tab drew a plan with the change missing from it",
    ).toBeVisible();

    // EDITABLE (#59), and the view says which plan the edits are for.
    // The move controls are routed to the what-if's change list; Details
    // is not, because the card it opens carries edits no change
    // expresses, so it stays out.
    await expect(planner.getByRole("button", { name: /one term later/i }).first()).toBeVisible();
    await expect(planner.getByRole("button", { name: /^Details for/ })).toHaveCount(0);

    await openRail(planner);
    await rail(planner).getByRole("button", { name: /Show your own plan/ }).click();
    await expect(planner.getByRole("region", { name: /Degree plan, list view/ })).toBeVisible();
    await expect(planner.getByText(/gap term/i)).toHaveCount(0);
  });

  test("says so and draws nothing when a what-if cannot be worked out", async ({ planner }) => {
    // NO PARTIAL PLAN, EVER. A chart missing the change the student asked
    // about looks exactly like a plan they could have.
    await withCandidates(planner, [
      candidate("c1", "a course that is gone", ADD_A_COURSE_THAT_IS_NOT_THERE),
    ]);
    await openRail(planner);
    await rail(planner).getByRole("button", { name: /Show the what-if "a course that is gone"/ }).click();

    const said = planner.getByRole("region", { name: /cannot be shown/i });
    await expect(said).toBeVisible({ timeout: 30_000 });
    await expect(said).toContainText(/NOPE 999/);
    await expect(planner.locator(".viewport"), "a chart was drawn for a what-if nobody can have")
      .toHaveCount(0);
    await expect(planner.locator(".listview")).toHaveCount(0);
  });

  test("loses a tab when it is deleted, and the plan is untouched", async ({ planner }) => {
    await withCandidates(planner, [
      candidate("c1", "a term off", SKIP_A_TERM),
      candidate("c2", "abroad junior spring", SKIP_A_TERM),
    ]);
    const before = await planner.evaluate((k) => window.localStorage.getItem(k), PLAN_KEY);
    await openRail(planner);

    await rail(planner).getByRole("button", { name: /Delete the what-if "a term off"/ }).click();

    await openRail(planner);
    await expect(rail(planner).getByRole("button", { name: /Show the what-if "a term off"/ })).toHaveCount(0);
    await expect(
      rail(planner).getByRole("button", { name: /Show the what-if "abroad junior spring"/ }),
    ).toHaveCount(1);

    const after = await planner.evaluate((k) => window.localStorage.getItem(k), PLAN_KEY);
    const was = JSON.parse(before!);
    const now = JSON.parse(after!);
    expect(now.candidates.map((c: { id: string }) => c.id), "the wrong what-if went").toEqual(["c2"]);
    expect(now.terms, "deleting a what-if rescheduled the plan").toEqual(was.terms);
    expect(now.completed, "deleting a what-if lost a completed course").toEqual(was.completed);
  });

  test("says what keeping takes out of the degree, and lets them keep it", async ({ planner }) => {
    /* THE OWNER'S DECISION ON #59, in the browser. This tab used to
       refuse: dropping a required course wants the student's own words,
       and a button is not a quote. The gate is against a MODEL claiming
       they asked — the student pressing Keep is the same person making
       the same one-click removal the course card already takes. So the
       rail stops refusing and starts telling, and the telling is what is
       asserted here: the cost is on screen BEFORE they choose. */
    await withCandidates(planner, [
      candidate("c1", "drop ECON 102", [{ tool: "remove_course", arguments: { code: "ECON 102" } }]),
    ]);
    await openRail(planner);
    await rail(planner).getByRole("button", { name: /Show the what-if "drop ECON 102"/ }).click();

    await openRail(planner);
    const keep = rail(planner).getByRole("button", { name: /Keep "drop ECON 102" as your plan/ });
    await expect(keep, "keeping a what-if that removes a course is still refused").toBeEnabled({ timeout: 30_000 });
    await expect(
      rail(planner).getByText(/takes ECON 102 out of your degree/i),
      "the student is not told what keeping takes out",
    ).toBeVisible();

    await keep.click();
    await expect(rail(planner).getByRole("button", { name: /^Show the what-if/ }))
      .toHaveCount(0, { timeout: 30_000 });
    const now = JSON.parse((await planner.evaluate((k) => window.localStorage.getItem(k), PLAN_KEY))!);
    const codes = now.terms.flatMap((t: { items: { code?: string }[] }) =>
      t.items.flatMap((i) => (i.code ? [i.code] : [])));
    expect(codes, "the course the what-if removes is still in the plan").not.toContain("ECON 102");
  });

  test("becomes the real plan when it is kept", async ({ planner }) => {
    await withCandidates(planner, [candidate("c1", "a term off", SKIP_A_TERM)]);
    await openRail(planner);
    await rail(planner).getByRole("button", { name: /Show the what-if "a term off"/ }).click();
    await openRail(planner);

    const keep = rail(planner).getByRole("button", { name: /Keep "a term off" as your plan/ });
    await expect(keep).toBeEnabled({ timeout: 30_000 });
    await keep.click();

    // The tab goes, because it is the plan now. The `+` stays.
    await expect(rail(planner).getByRole("button", { name: /^Show the what-if/ })).toHaveCount(0);
    const now = JSON.parse((await planner.evaluate((k) => window.localStorage.getItem(k), PLAN_KEY))!);
    expect(now.terms.some((t: { gap?: boolean }) => t.gap), "keeping did not make the change").toBe(true);
    expect(now.rev, "the revision did not advance").toBeGreaterThan(SEEDED_PLAN.rev);
    expect(now.candidates, "the kept what-if is still a tab").toEqual([]);
  });
});

test.describe("a what-if the student makes with the +", () => {
  /** The plan document as it is stored, which is the copy their other
   * devices read. */
  const stored = async (page: Page) =>
    JSON.parse((await page.evaluate((k) => window.localStorage.getItem(k), PLAN_KEY))!);

  test("can be made, edited, and kept, without typing a tool name", async ({ planner }) => {
    // THE WHOLE JOURNEY A STUDENT WITH NO ASSISTANT HAS. No
    // `save_candidate`, no connector: a button, a chart they can edit,
    // and one action to keep what they made.
    const before = await stored(planner);

    await openRail(planner);
    await rail(planner).getByRole("button", { name: /Make a new what-if/i }).click();
    await expect(
      planner.getByRole("region", { name: /What-if "What-if 1"/ }).first(),
      "the + made nothing to look at",
    ).toBeVisible({ timeout: 30_000 });

    // Edit it in the list view, where the controls are words rather than
    // a drag — the same edit the chart's term header makes.
    await planner.getByRole("button", { name: /List view/i }).click();
    const list = planner.getByRole("region", { name: /What-if "What-if 1", list view/ });
    await expect(list).toBeVisible();
    await expect(list.getByText(/gap term/i)).toHaveCount(0);
    await list.getByRole("button", { name: /Skip Fall 2027/i }).click();
    await expect(
      list.getByText(/gap term/i).first(),
      "the edit did not reach the what-if",
    ).toBeVisible({ timeout: 30_000 });

    // THE REAL PLAN IS UNTOUCHED, read off the stored document rather
    // than off the screen: the screen is showing the what-if.
    const mid = await stored(planner);
    expect(mid.terms, "editing a what-if rescheduled the student's own plan").toEqual(before.terms);
    expect(mid.completed).toEqual(before.completed);
    expect(mid.candidates[0].changes, "the edit was not recorded on the what-if").toEqual([
      { tool: "skip_term", arguments: { term_index: 2 } },
    ]);

    await openRail(planner);
    const keep = rail(planner).getByRole("button", { name: /Keep "What-if 1" as your plan/ });
    await expect(keep).toBeEnabled({ timeout: 30_000 });
    await keep.click();
    // The tab going is what says the replay finished; reading storage
    // before that is reading it mid-keep.
    await expect(rail(planner).getByRole("button", { name: /^Show the what-if/ }))
      .toHaveCount(0, { timeout: 30_000 });

    const after = await stored(planner);
    expect(after.terms.some((t: { gap?: boolean }) => t.gap), "keeping did not make the change").toBe(true);
    expect(after.candidates, "the kept what-if is still a tab").toEqual([]);
  });

  test("is thrown away in one click, with nothing to read first", async ({ planner }) => {
    const before = await stored(planner);
    await openRail(planner);
    await rail(planner).getByRole("button", { name: /Make a new what-if/i }).click();
    // THE CHART IS THE SIGNAL, not the rail: the what-if is drawn when
    // its changes have been run, and on a phone the rail has closed
    // itself by then to keep the chart on the screen. Reaching for a tab
    // before this raced the render that creates it.
    await expect(planner.getByRole("region", { name: /What-if "What-if 1"/ }).first())
      .toBeVisible({ timeout: 30_000 });
    await openRail(planner);
    await expect(rail(planner).getByRole("button", { name: /Show the what-if "What-if 1"/ }))
      .toBeVisible({ timeout: 30_000 });

    await openRail(planner);
    // No confirmation dialogue: throwing away a sketch has to be cheap.
    await rail(planner).getByRole("button", { name: /Delete the what-if "What-if 1"/ }).click();

    await expect(rail(planner).getByRole("button", { name: /^Show the what-if/ })).toHaveCount(0);
    const after = await stored(planner);
    expect(after.candidates, "the what-if was not deleted").toEqual([]);
    expect(after.terms, "deleting a what-if rescheduled the plan").toEqual(before.terms);
  });

  test("can be renamed so three of them are tellable apart", async ({ planner }) => {
    await openRail(planner);
    await rail(planner).getByRole("button", { name: /Make a new what-if/i }).click();
    // THE CHART IS THE SIGNAL, not the rail: the what-if is drawn when
    // its changes have been run, and on a phone the rail has closed
    // itself by then to keep the chart on the screen. Reaching for a tab
    // before this raced the render that creates it.
    await expect(planner.getByRole("region", { name: /What-if "What-if 1"/ }).first())
      .toBeVisible({ timeout: 30_000 });
    await openRail(planner);
    await expect(rail(planner).getByRole("button", { name: /Show the what-if "What-if 1"/ }))
      .toBeVisible({ timeout: 30_000 });

    await openRail(planner);
    await rail(planner).getByRole("button", { name: /Rename the what-if "What-if 1"/ }).click();
    const box = rail(planner).getByLabel("Name this what-if");
    await box.fill("abroad junior spring");
    await box.press("Enter");

    await openRail(planner);
    await expect(rail(planner).getByRole("button", { name: /Show the what-if "abroad junior spring"/ }))
      .toBeVisible();
    const after = await stored(planner);
    expect(after.candidates[0].name, "the new name was not saved").toBe("abroad junior spring");
  });
});

/** Tab from the top of the page until a control matching `re` has focus,
 * then return how many presses it took. Never a click: the whole of this
 * describe is the claim that the rail is not mouse-only. */
async function tabTo(page: Page, re: RegExp, max = 60): Promise<number> {
  await page.evaluate(() => (document.querySelector("body") as HTMLElement).focus());
  for (let stops = 1; stops <= max; stops++) {
    await page.keyboard.press("Tab");
    const at = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        tag: el?.tagName ?? "",
        name: (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim(),
      };
    });
    // BUTTONS ONLY. Chrome makes a SCROLLABLE container focusable so it
    // can be scrolled from the keyboard, so the rail's own <nav> lands in
    // the tab order carrying the accessible name "Your plan and your
    // what-ifs" — which matched, and Enter on a <nav> does nothing. The
    // test then reported the control broken when the control was never
    // reached.
    if (at.tag === "BUTTON" && re.test(at.name)) return stops;
  }
  throw new Error(`never reached ${re} by tabbing`);
}

/** Open the collapsed rail using only the keyboard. Nothing on a wide
 * screen, where there is no toggle. */
async function openRailByKeyboard(page: Page): Promise<void> {
  if (!(await rail(page).getByRole("button", { expanded: false }).count())) return;
  await tabTo(page, /what-if/i);
  await page.keyboard.press("Enter");
}

test.describe("reaching the rail without a mouse", () => {
  test("every tab and its controls are reachable and operable by keyboard", async ({ planner }) => {
    await withCandidates(planner, [candidate("c1", "a term off", SKIP_A_TERM)]);

    await openRailByKeyboard(planner);
    // The stop count is the assertion as much as the match is: a rail
    // nobody can reach in a reasonable number of presses is a rail nobody
    // reaches.
    const stops = await tabTo(planner, /Show the what-if "a term off"/);
    expect(stops, "the what-if tab is a long way down the tab order").toBeLessThanOrEqual(30);

    // Visible focus, which is the whole of the feature for anyone who
    // cannot see where the pointer is. Read while the tab still HAS focus:
    // on a phone picking one closes the rail, and the control it was on
    // goes with it.
    const focus = await planner.evaluate(() => {
      const s = getComputedStyle(document.activeElement as Element);
      return { outline: s.outlineStyle, width: parseFloat(s.outlineWidth || "0"), shadow: s.boxShadow };
    });
    expect(
      (focus.outline !== "none" && focus.width > 0) || (focus.shadow && focus.shadow !== "none"),
      "the focused tab shows no focus ring",
    ).toBeTruthy();

    await planner.keyboard.press("Enter");
    // The flowchart carries the what-if's name once one is open, which is
    // what says a what-if is the thing being drawn.
    await expect(
      planner.locator(".viewport.candidate"),
      "pressing Enter on the tab did not draw the what-if",
    ).toBeVisible({ timeout: 30_000 });

    // Re-opened because picking one closes the rail on a phone, which is
    // what keeps the chart on the screen there.
    await openRailByKeyboard(planner);
    await expect(
      rail(planner).getByRole("button", { name: /Show the what-if "a term off"/ }),
      "the rail does not say which tab is showing",
    ).toHaveAttribute("aria-pressed", "true");

    // And delete it, still without touching the mouse.
    await tabTo(planner, /Delete the what-if "a term off"/);
    await planner.keyboard.press("Enter");
    await expect(rail(planner).getByRole("button", { name: /^Show the what-if/ })).toHaveCount(0);
    // The `+` stays, and is reachable by keyboard too — it is the only
    // door a student without an assistant has.
    await openRailByKeyboard(planner);
    const toPlus = await tabTo(planner, /Make a new what-if/);
    expect(toPlus, "the + is a long way down the tab order").toBeLessThanOrEqual(30);
  });
});

test.describe("the rail on a narrow screen", () => {
  // The measurement in #23 is the standard: a layout viewport wider than
  // the screen means Chrome scaled the page down to fit something, and
  // the whole planner becomes unusable.
  for (const width of [320, 375, 412]) {
    test(`does not push anything off a ${width}px screen`, async ({ planner }) => {
      await planner.setViewportSize({ width, height: 760 });
      await withCandidates(planner, [
        candidate("c1", "finish in seven terms instead of eight", SKIP_A_TERM),
        candidate("c2", "study abroad junior spring in Valencia", SKIP_A_TERM),
      ]);

      const measured = await planner.evaluate((screenW) => {
        const d = document.documentElement;
        const widest = [...document.querySelectorAll("*")]
          .filter((el) => el.getBoundingClientRect().width > screenW + 1)
          .slice(0, 3)
          .map((el) => `<${el.tagName.toLowerCase()} class="${el.className}">`);
        return { innerWidth: window.innerWidth, scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, widest };
      }, width);

      expect(
        measured.innerWidth,
        `the page scaled itself down to fit its content at ${width}px. Widest: ${measured.widest.join(" | ")}`,
      ).toBeLessThanOrEqual(width);
      expect(
        measured.scrollWidth,
        `the page is ${measured.scrollWidth}px wide in a ${measured.clientWidth}px viewport. ` +
          `Widest: ${measured.widest.join(" | ")}`,
      ).toBeLessThanOrEqual(measured.clientWidth + 1);
    });
  }

  test("starts as one control that opens the list, so the chart keeps the screen", async ({ planner }) => {
    await planner.setViewportSize({ width: 412, height: 760 });
    await withCandidates(planner, [candidate("c1", "a term off", SKIP_A_TERM)]);

    const toggle = rail(planner).getByRole("button", { expanded: false });
    await expect(toggle, "the rail is open by default on a phone").toBeVisible();
    await expect(rail(planner).getByRole("button", { name: /Show the what-if/ })).toBeHidden();

    await toggle.click();
    await expect(rail(planner).getByRole("button", { name: /Show the what-if/ })).toBeVisible();
  });
});
