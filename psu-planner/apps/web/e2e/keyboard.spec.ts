/** The launch gate for keyboard operation (#16).
 *
 * The canvas is pointer-only by construction -- it positions absolutely
 * placed cards and draws prerequisite edges between them, and no amount of
 * ARIA makes that operable by keyboard. The project's answer has always been
 * that the list view is its equivalent. These tests are what make that claim
 * true rather than nominal: every one of them drives the app with `keyboard`
 * only, never `click`, so a regression that breaks keyboard operation fails
 * here instead of being discovered by a student who cannot use a mouse.
 */
import { test, expect, expectNoA11yViolations, SEEDED_PLAN } from "./fixtures.js";
import type { Page } from "@playwright/test";
// The REAL selector the trap uses. Re-typing it here meant the test agreed
// with a copy of the implementation rather than with the implementation, so a
// selector-level regression would pass.
import { FOCUSABLE } from "../src/hooks/useDialog.js";

/** Tab until `predicate` matches the focused element, or give up.
 *
 * Returns the number of stops taken, which doubles as the focus-order
 * assertion: a control reachable only after 200 tabs is not reachable in any
 * sense a student would recognise. */
async function tabTo(page: Page, predicate: (el: { role: string; name: string }) => boolean, max = 60): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return { role: "", name: "" };
      return {
        role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
        name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim(),
      };
    });
    if (predicate(info)) return i;
  }
  throw new Error("never reached the element by tabbing");
}

const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim();
  });

/** Reach the list view using only the keyboard. */
async function openListView(page: Page): Promise<void> {
  await page.evaluate(() => (document.querySelector("body") as HTMLElement).focus());
  await tabTo(page, (el) => /List view/i.test(el.name));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: /list view/i })).toBeVisible();
}

test.describe("the list view is reachable without a pointer", () => {
  test("the toolbar toggle can be tabbed to and activated", async ({ planner }) => {
    await openListView(planner);
    await expect(planner.getByRole("button", { name: /Flowchart view/i })).toBeVisible();
  });

  test("the toggle says which view it is in, not just what it does", async ({ planner }) => {
    // aria-pressed is what tells a screen-reader user which view they are
    // currently looking at; the label alone describes the destination.
    const toggle = planner.getByRole("button", { name: /List view/i });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await openListView(planner);
    await expect(planner.getByRole("button", { name: /Flowchart view/i })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("a course can be moved between terms with the keyboard alone", () => {
  test("moving later changes which term the course is listed under", async ({ planner }) => {
    await openListView(planner);

    // The first course in the first term, by the term heading it sits under.
    const firstTerm = planner.getByRole("region", { name: /list view/i }).locator("section").first();
    const firstCourse = firstTerm.getByRole("listitem").first();
    const code = (await firstCourse.locator(".lv-code").first().textContent())?.trim() ?? "";
    expect(code, "the list view shows no course code to move").not.toBe("");

    await tabTo(planner, (el) => new RegExp(`Move ${code} one term later`, "i").test(el.name));
    await planner.keyboard.press("Enter");

    // It left the first term.
    await expect(firstTerm.getByText(code, { exact: false })).toHaveCount(0);
    // And it is still in the plan -- moving is not removing.
    await expect(planner.getByRole("region", { name: /list view/i }).getByText(code, { exact: false }).first()).toBeVisible();
  });

  test("focus stays on the control that was activated", async ({ planner }) => {
    // Re-rendering the list after a move used to drop focus to <body>, which
    // means a keyboard user has to tab from the top of the page again for
    // every single term they want to shift a course. That makes the
    // feature technically present and practically unusable.
    await openListView(planner);
    const firstTerm = planner.getByRole("region", { name: /list view/i }).locator("section").first();
    const code = (await firstTerm.getByRole("listitem").first().locator(".lv-code").first().textContent())?.trim() ?? "";

    await tabTo(planner, (el) => new RegExp(`Move ${code} one term later`, "i").test(el.name));
    await planner.keyboard.press("Enter");

    expect(await focusedName(planner)).toMatch(new RegExp(`Move ${code} one term`, "i"));
  });

  test("the control is disabled rather than silently doing nothing at the edges", async ({ planner }) => {
    await openListView(planner);
    const firstTerm = planner.getByRole("region", { name: /list view/i }).locator("section").first();
    const earlier = firstTerm.getByRole("button", { name: /one term earlier/i }).first();
    await expect(earlier).toBeDisabled();
  });
});

test.describe("everything in the plan is reachable in the list view", () => {
  test("every term in the plan has a heading", async ({ planner }) => {
    await openListView(planner);
    const region = planner.getByRole("region", { name: /list view/i });
    for (const term of SEEDED_PLAN.terms.slice(0, 4)) {
      await expect(region.getByRole("heading", { name: new RegExp(term.label, "i") })).toBeVisible();
    }
  });

  test("a gap term says it is intentionally empty", async ({ planner }) => {
    // The canvas renders a Gap Term with its own styling. In the list it must
    // be words, and words that say INTENTIONAL -- a Gap Term is an intentional
    // emptiness, distinct from a term that merely has nothing in it yet.
    // addInitScript, not evaluate-then-reload: the fixture seeds the plan in
    // its OWN init script, which re-runs on every navigation and would
    // overwrite anything written to localStorage from the page. Init scripts
    // run in registration order, so this one patches the seeded plan.
    await planner.addInitScript(() => {
      const key = "psu-planner-plan-v1";
      const plan = JSON.parse(window.localStorage.getItem(key)!);
      plan.terms[2].gap = true;
      window.localStorage.setItem(key, JSON.stringify(plan));
    });
    await planner.reload();
    await expect(planner.getByRole("banner")).toBeVisible({ timeout: 30_000 });
    await openListView(planner);
    const region = planner.getByRole("region", { name: /list view/i });
    await expect(region.getByText(/gap term/i).first()).toBeVisible();
    // "intentionally" is the load-bearing word: without it a Gap Term reads
    // identically to a term nothing has been put in yet.
    await expect(region.getByText(/intentionally/i).first()).toBeVisible();
  });

  test("a summer in the plan is described as a term, because it is one", async ({ planner }) => {
    // The reason CONTEXT.md rejects "semester": a summer is a Term and is not
    // a semester, and this planner lets a student opt into one. Copy like
    // "Skip semester" is not merely informal once Summer 2027 is on screen --
    // it is wrong. The seeded plan has only falls and springs, so nothing else
    // in this suite would notice.
    await planner.addInitScript(() => {
      const key = "psu-planner-plan-v1";
      const plan = JSON.parse(window.localStorage.getItem(key)!);
      plan.terms.splice(2, 0, { label: "Summer 2027", items: [] });
      window.localStorage.setItem(key, JSON.stringify(plan));
    });
    await planner.reload();
    await expect(planner.getByRole("banner")).toBeVisible({ timeout: 30_000 });
    await openListView(planner);
    const region = planner.getByRole("region", { name: /list view/i });
    await expect(region.getByText("Summer 2027").first()).toBeVisible();
    // Not a substring check against the whole page: "semester" must be absent
    // from the controls that act on this summer specifically.
    const skip = region.getByRole("button", { name: /Skip Summer 2027/i });
    await expect(skip).toBeVisible();
    await expect(region.getByRole("button", { name: /semester/i })).toHaveCount(0);
    await expect(region.getByText(/semester/i)).toHaveCount(0);
  });

  test("a completed course is marked completed in text", async ({ planner }) => {
    const code = SEEDED_PLAN.terms[0].items.find((i: { code?: string }) => i.code)?.code as string;
    await planner.addInitScript((c) => {
      const key = "psu-planner-plan-v1";
      const plan = JSON.parse(window.localStorage.getItem(key)!);
      plan.completed[c as string] = true;
      window.localStorage.setItem(key, JSON.stringify(plan));
    }, code);
    await planner.reload();
    await expect(planner.getByRole("banner")).toBeVisible({ timeout: 30_000 });
    await openListView(planner);
    // Scoped to the list: the toolbar reads "N of M credits completed", so an
    // unscoped match passes whether or not the list says anything at all.
    const region = planner.getByRole("region", { name: /list view/i });
    await expect(region.locator(".lv-status.done").first()).toBeVisible();
    await expect(region.locator(".lv-status.done").first()).toHaveText(/completed/i);
  });

  test("a course whose stored position is past the last term still appears", async ({ planner }) => {
    // buildItems does NOT clamp -- it returns whatever is in plan.moves. An
    // optimize that shortens the plan, or a chat/MCP tool, can leave a move
    // pointing past the end. Bucketing on equality alone then matched no
    // term and the course vanished from this view entirely, while the canvas
    // (which clamps when drawing) still showed it. Losing a course silently
    // is the one outcome worth ruling out.
    const code = SEEDED_PLAN.terms[0].items.find((i: { code?: string }) => i.code)?.code as string;
    await planner.addInitScript((c) => {
      const key = "psu-planner-plan-v1";
      const plan = JSON.parse(window.localStorage.getItem(key)!);
      plan.moves[c as string] = 999;
      window.localStorage.setItem(key, JSON.stringify(plan));
    }, code);
    await planner.reload();
    await expect(planner.getByRole("banner")).toBeVisible({ timeout: 30_000 });
    await openListView(planner);
    const region = planner.getByRole("region", { name: /list view/i });
    await expect(region.getByText(code, { exact: false }).first(), `${code} fell out of the list entirely`).toBeVisible();
  });

  test("a term can be skipped and un-skipped from the list", async ({ planner }) => {
    // The canvas offers this on every column header. Without it here,
    // "everything in the Plan is reachable" is true only of what the Plan
    // SAYS, not of what can be done to it.
    await openListView(planner);
    const region = planner.getByRole("region", { name: /list view/i });
    const skip = region.getByRole("button", { name: /^Skip /i }).first();
    await expect(skip).toBeVisible();
    await skip.focus();
    await planner.keyboard.press("Enter");
    await expect(region.getByRole("button", { name: /instead of leaving it empty/i }).first()).toBeVisible();
  });

  test("a term can be added from the list", async ({ planner }) => {
    await openListView(planner);
    const region = planner.getByRole("region", { name: /list view/i });
    const before = await region.locator("section").count();
    const add = region.getByRole("button", { name: /Add another term/i });
    await add.focus();
    await planner.keyboard.press("Enter");
    await expect(region.locator("section")).toHaveCount(before + 1);
  });

  test("status is conveyed as text, never by colour alone", async ({ planner }) => {
    await openListView(planner);
    // Every status chip carries words. A chip that is only a coloured dot
    // conveys nothing to a screen reader or to anyone with low colour vision.
    const statuses = planner.locator(".lv-status");
    const n = await statuses.count();
    for (let i = 0; i < Math.min(n, 10); i++) {
      expect((await statuses.nth(i).textContent())?.trim().length ?? 0).toBeGreaterThan(3);
    }
  });
});

test.describe("modals are operable and escapable", () => {
  /** Open the details modal for the first list item, by keyboard. */
  async function openFirstDetails(page: Page) {
    await openListView(page);
    await tabTo(page, (el) => /^Details for/i.test(el.name));
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
  }

  test("Escape closes the details modal", async ({ planner }) => {
    await openFirstDetails(planner);
    await planner.keyboard.press("Escape");
    await expect(planner.getByRole("dialog")).toHaveCount(0);
  });

  test("focus returns to the control that opened it", async ({ planner }) => {
    // Without this, closing a modal drops focus to <body> and the student is
    // back at the top of the document with no idea where they were.
    await openListView(planner);
    await tabTo(planner, (el) => /^Details for/i.test(el.name));
    const opener = await focusedName(planner);
    await planner.keyboard.press("Enter");
    await expect(planner.getByRole("dialog")).toBeVisible();
    await planner.keyboard.press("Escape");
    await expect(planner.getByRole("dialog")).toHaveCount(0);
    expect(await focusedName(planner)).toBe(opener);
  });

  test("Tab wraps from the last control back to the first", async ({ planner }) => {
    await openFirstDetails(planner);
    // The wrap is the only thing a trap actually DOES. Asserting merely that
    // focus is "still inside" does not test it: this dialog is the last thing
    // in the DOM, so focus has nowhere obvious to go and the assertion holds
    // even with the trap removed (verified by planting that mutation).
    const stops = await planner.evaluate((sel) => {
      const dlg = document.querySelector('[role="dialog"]')!;
      const els = [...dlg.querySelectorAll<HTMLElement>(sel)].filter((e) => e.offsetParent !== null);
      els[0]?.focus();
      return els.length;
    }, FOCUSABLE);
    expect(stops, "the dialog has no focusable controls to trap").toBeGreaterThan(1);

    // One full cycle: from the first control, `stops` presses must come back
    // to the first control. Without the trap, the last press leaves the page.
    for (let i = 0; i < stops; i++) await planner.keyboard.press("Tab");

    const wrapped = await planner.evaluate((sel) => {
      const dlg = document.querySelector('[role="dialog"]')!;
      const els = [...dlg.querySelectorAll<HTMLElement>(sel)].filter((e) => e.offsetParent !== null);
      return document.activeElement === els[0];
    }, FOCUSABLE);
    expect(wrapped, "Tab did not wrap from the last control back to the first").toBe(true);
  });

  test("Shift+Tab wraps backwards from the first control to the last", async ({ planner }) => {
    await openFirstDetails(planner);
    const ok = await planner.evaluate((sel) => {
      const dlg = document.querySelector('[role="dialog"]')!;
      const els = [...dlg.querySelectorAll<HTMLElement>(sel)].filter((e) => e.offsetParent !== null);
      els[0]?.focus();
      return els.length > 1;
    }, FOCUSABLE);
    expect(ok).toBe(true);
    await planner.keyboard.press("Shift+Tab");
    const atLast = await planner.evaluate((sel) => {
      const dlg = document.querySelector('[role="dialog"]')!;
      const els = [...dlg.querySelectorAll<HTMLElement>(sel)].filter((e) => e.offsetParent !== null);
      return document.activeElement === els[els.length - 1];
    }, FOCUSABLE);
    expect(atLast, "Shift+Tab did not wrap backwards to the last control").toBe(true);
  });

  test("focus moves into the modal when it opens", async ({ planner }) => {
    await openFirstDetails(planner);
    const inside = await planner.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      return !!dlg && !!document.activeElement && dlg.contains(document.activeElement);
    });
    expect(inside, "focus was left behind the modal").toBe(true);
  });
});

test.describe("focus order is sensible", () => {
  // `tabTo` returns how many stops it took. Until now every call site threw
  // that away, so nothing actually asserted ORDER -- only that a control
  // could eventually be reached. A control reachable only after fifty tab
  // presses is not reachable in any sense a student would recognise.
  test("the view toggle is near the front of the toolbar", async ({ planner }) => {
    await planner.evaluate(() => (document.querySelector("body") as HTMLElement).focus());
    const stops = await tabTo(planner, (el) => /List view/i.test(el.name));
    expect(stops, `the view toggle took ${stops} tab stops to reach`).toBeLessThanOrEqual(12);
  });

  test("the first row's controls come straight after the view toggle", async ({ planner }) => {
    // Counted FROM the toggle, which openListView leaves focused. An earlier
    // version re-searched for it by name, but tabTo presses Tab before it
    // looks, so it had already moved off the toggle and only found it again
    // after wrapping the whole document.
    await openListView(planner);
    const toDetails = await tabTo(planner, (el) => /^Details for/i.test(el.name));
    // Everything in between is the rest of the toolbar. If the list's own
    // controls sat behind a long tail of chrome, reaching the plan itself
    // would mean tabbing through the whole header every time.
    expect(toDetails, `${toDetails} stops from the view toggle to the first row`).toBeLessThanOrEqual(12);
  });

  test("a row reads Details then its move controls, before the next row", async ({ planner }) => {
    await openListView(planner);
    await tabTo(planner, (el) => /^Details for/i.test(el.name));
    const first = await focusedName(planner);
    const seen: string[] = [];
    // Walk until the NEXT row begins. In the first term "earlier" is disabled
    // and so is not a tab stop at all, which is why this counts to the next
    // Details rather than assuming a fixed three controls.
    for (let i = 0; i < 6; i++) {
      await planner.keyboard.press("Tab");
      const n = await focusedName(planner);
      if (/^Details for/i.test(n)) break;
      seen.push(n);
    }
    expect(first).toMatch(/^Details for/i);
    expect(seen.length, "no move control follows Details in the row").toBeGreaterThan(0);
    for (const n of seen) {
      expect(n, `"${n}" sits between a row's Details and the next row`).toMatch(/one term earlier|one term later/i);
    }
  });
});

test.describe("focus is always visible", () => {
  test("a focused control has a visible indicator", async ({ planner }) => {
    await openListView(planner);
    await tabTo(planner, (el) => /^Details for/i.test(el.name));
    const hasIndicator = await planner.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
      // A ring drawn with box-shadow counts; `none` does not.
      const ring = s.boxShadow !== "none" && s.boxShadow.trim() !== "";
      return outline || ring;
    });
    expect(hasIndicator, "the focused control has neither an outline nor a focus ring").toBe(true);
  });
});

test.describe("no mechanically detectable accessibility violations", () => {
  test("the list view", async ({ planner }) => {
    await openListView(planner);
    await expectNoA11yViolations(planner, "the list view");
  });

  test("the details modal", async ({ planner }) => {
    await openListView(planner);
    await tabTo(planner, (el) => /^Details for/i.test(el.name));
    await planner.keyboard.press("Enter");
    await expect(planner.getByRole("dialog")).toBeVisible();
    await expectNoA11yViolations(planner, "the course details modal");
  });

  /** Open a Menu item by keyboard and return the dialog. */
  async function openFromMenu(page: Page, item: RegExp) {
    await page.evaluate(() => (document.querySelector("body") as HTMLElement).focus());
    await tabTo(page, (el) => /^Menu/i.test(el.name));
    await page.keyboard.press("Enter");
    // Tab to the item and press it. Using .click() here would have left these
    // dialogs unproven as keyboard-openable while the file claimed otherwise.
    await tabTo(page, (el) => item.test(el.name));
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
  }

  test("the legal modal", async ({ planner }) => {
    await openFromMenu(planner, /Privacy/i);
    await expectNoA11yViolations(planner, "the legal modal");
  });

  test("the import modal", async ({ planner }) => {
    await openFromMenu(planner, /Import courses/i);
    await expectNoA11yViolations(planner, "the import modal");
  });

  test("every dialog closes on Escape and names itself", async ({ planner }) => {
    // An unnamed dialog is announced as just "dialog". Both of these were
    // written inline in App.tsx with no role, no name and no Escape handling
    // until they moved onto the shared Dialog shell.
    for (const item of [/Privacy/i, /Import courses/i, /Plan history/i]) {
      await openFromMenu(planner, item);
      const name = await planner.evaluate(() =>
        document.querySelector('[role="dialog"]')?.getAttribute("aria-label") ?? "",
      );
      expect(name.length, `a dialog opened from ${item} has no accessible name`).toBeGreaterThan(3);
      await planner.keyboard.press("Escape");
      await expect(planner.getByRole("dialog")).toHaveCount(0);
    }
  });

  test("the open-slot modal, which is a different component from the course one", async ({ planner }) => {
    // CourseModal renders two entirely separate trees. Only the course branch
    // was covered, so the slot branch had never been checked at all.
    await openListView(planner);
    await tabTo(planner, (el) => /^Details for .*(Elective|GE|Gen Ed|slot)/i.test(el.name), 120);
    await planner.keyboard.press("Enter");
    await expect(planner.getByRole("dialog", { name: /open slot/i })).toBeVisible();
    await expectNoA11yViolations(planner, "the open-slot modal");
  });

  test("the plan history modal", async ({ planner }) => {
    await openFromMenu(planner, /Plan history/i);
    await expectNoA11yViolations(planner, "the plan history modal");
  });

  test("onboarding", async ({ page }) => {
    // No seeded plan: this is the first screen a new student sees.
    await page.goto("/plan/");
    await expect(page.getByText(/Chart your degree/i)).toBeVisible({ timeout: 30_000 });
    await expectNoA11yViolations(page, "onboarding");
  });
});

test.describe("the theme the suite is actually running in", () => {
  /** A dark-mode project that silently renders light proves nothing, and
   * looks exactly like one that works -- the same shape of mistake as a regex
   * that matches nothing. So assert the pixels, not the config. */
  test("matches what the project asked for", async ({ planner }, testInfo) => {
    const wantDark = testInfo.project.name.includes("dark");
    const bg = await planner.evaluate(() =>
      getComputedStyle(document.body).backgroundColor,
    );
    const [r, g, b] = bg.match(/\d+/g)!.map(Number);
    // Relative luminance, same formula the palette unit tests use.
    const lum = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const L = 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
    expect(L < 0.2, `body background is ${bg} (luminance ${L.toFixed(3)}) but the project is "${testInfo.project.name}"`)
      .toBe(wantDark);
  });

  test("the list view's own text meets AA against what is behind it", async ({ planner }) => {
    // .lv-status.done and .lv-code were added without any dark-mode check:
    // the fixture pinned light, so every new rule went unexercised there.
    await openListView(planner);
    const worst = await planner.evaluate(() => {
      const lum = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const L = (css: string) => {
        const [r, g, b] = css.match(/\d+/g)!.map(Number);
        return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
      };
      /** The nearest ancestor that actually paints a background. */
      const bgOf = (el: Element): string => {
        let n: Element | null = el;
        while (n) {
          const c = getComputedStyle(n).backgroundColor;
          if (c && !/rgba?\([^)]*,\s*0\)/.test(c) && c !== "transparent") return c;
          n = n.parentElement;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      let min = 21;
      let where = "";
      for (const el of document.querySelectorAll(".listview .lv-status, .listview .lv-code, .listview .lv-credits")) {
        if (!(el as HTMLElement).offsetParent) continue;
        const a = L(getComputedStyle(el).color);
        const b = L(bgOf(el));
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (ratio < min) { min = ratio; where = `${el.className}: "${el.textContent?.trim().slice(0, 40)}"`; }
      }
      return { min, where };
    });
    expect(worst.min, `lowest contrast in the list view is ${worst.min.toFixed(2)}:1 on ${worst.where}`)
      .toBeGreaterThanOrEqual(4.5);
  });
});
