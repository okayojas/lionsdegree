/** The front door (#60, #64).
 *
 * This page's job is to survive being shared. A student sends the link to a
 * group chat, and what arrives is a preview card rendered by something that
 * does not run JavaScript, followed, if they tap it, by a page that has to
 * load fast on a phone on campus wifi.
 *
 * So the landing page is a document: four short sections and a footer,
 * complete with no script at all. A scene of labelled spheres is laid over
 * it where a browser can run one (#65), and replaces the sample Plan for the
 * eye and for nothing else. Everything here is about the document, which is
 * the page anyone the scene does not reach is given: these tests run with
 * scripts off, or in a browser with no WebGL. The scene has scene.spec.ts.
 *
 * What is NOT repeated here: that the page sits on cream, wears the shared
 * header, asks no other host for anything, fits a phone and passes axe. `/`
 * is in the list site-pages.spec.ts holds to all of that. That the old
 * `#about`, `#contact` and `#discovery` addresses still arrive somewhere is
 * in about.spec.ts and connect.spec.ts.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, contrast, withoutWebGL } from "./fixtures";
import { expectEveryLinkReachable, expectHeroWayInClear, expectWaysInReadable } from "./landing-checks";
import { PLAN } from "./the-sample-plan";

/** The Plan's list, found the way assistive technology finds it. */
const plan = (page: Page): Locator => page.getByRole("list", { name: /a sample plan for Computer Science, B\.S\./i });

/** What an element says, as a reader takes it in: one line, single spaces.
 * The markup wraps its sentences, and a pattern anchored at either end does
 * not survive the line breaks. */
const said = async (el: Locator): Promise<string> => (await el.innerText()).replace(/\s+/g, " ").trim();

test.describe("with JavaScript turned off", () => {
  // A previewer, a crawler and a student on a locked-down machine all land
  // here. So does anyone the scene cannot reach.
  test.use({ javaScriptEnabled: false });

  test("the page says what LionsDegree is", async ({ page }) => {
    await page.goto("/");
    // (Two lines, broken in the markup: no space where the break is.)
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("One degree plan.Optimized for you.");
    await expect(page.getByText("The days of shuffling tabs to schedule classes are over.")).toBeVisible();
    // The headline is a promise, not a description. What the thing IS has to
    // be said as well: a degree planner, for Penn State, that knows
    // prerequisites, and what you do with it.
    await expect(page.getByText(/Penn State degree planner/i)).toBeVisible();
    await expect(page.getByText(/each with its own prerequisites/i)).toBeVisible();
    await expect(page.getByText("Pick your majors, minors and certificates. LionsDegree lays out every term")).toBeVisible();
  });

  test("there is a way into the planner at the top, in the hero and at the bottom", async ({ page }) => {
    await page.goto("/");
    const ways = [
      page.getByRole("banner").getByRole("link", { name: "Start my plan" }),
      page.getByRole("main").getByRole("link", { name: "Start my plan" }),
      page.getByRole("contentinfo").getByRole("link", { name: "Open the planner" }),
    ];
    for (const way of ways) {
      await expect(way).toBeVisible();
      await expect(way).toHaveAttribute("href", "/plan/");
    }
    // The hero's is on the first screen of a phone, not somewhere below it.
    await page.setViewportSize({ width: 390, height: 760 });
    await expect(ways[1]).toBeInViewport();
  });

  test("a returning student can get back to a plan they already have", async ({ page }) => {
    // Somebody who built a plan on a laptop and opens the site on a phone
    // would otherwise be offered only a way to start another.
    await page.goto("/");
    await expect(page.getByRole("link", { name: /already have a plan\? sign in/i })).toHaveAttribute("href", "/plan/?signin=1");
  });

  test("nothing is hidden waiting for a script", async ({ page }) => {
    // The prototype kept the hero invisible until a script revealed it and
    // put the whole page behind a loader. With no script, that is a blank
    // page. Every heading, paragraph and link here is simply on the page.
    await page.goto("/");
    const unseen = await page.locator("main, footer").locator("h1, h2, h3, p, a, li, figcaption").evaluateAll((all) =>
      all
        .filter((el) => !el.closest("[aria-hidden='true']"))
        .filter((el) => {
          const box = el.getBoundingClientRect();
          let opacity = 1;
          for (let up: Element | null = el; up; up = up.parentElement) opacity *= Number(getComputedStyle(up).opacity);
          return box.width === 0 || box.height === 0 || opacity < 1 || getComputedStyle(el).visibility !== "visible";
        })
        .map((el) => (el.textContent ?? "").trim().slice(0, 40)),
    );
    expect(unseen, "on the page, but not there to be read").toEqual([]);
    // And nothing stands in front of it. Asked of the screen, not of the
    // markup: a loader is whatever is on top, whatever it is called.
    const onTop = await page.evaluate(() =>
      [...document.querySelectorAll("main h1, main h2, main .btn, footer h2")].map((el) => {
        el.scrollIntoView({ block: "center" });
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return el === hit || el.contains(hit) ? null : (el.textContent ?? "").trim().slice(0, 30);
      }).filter(Boolean),
    );
    expect(onTop, "something is drawn over these").toEqual([]);
  });

  test("the sample Plan is there as a list: eight Terms of six Courses, in order", async ({ page }) => {
    await page.goto("/");
    const terms = plan(page).locator(":scope > li");
    await expect(terms).toHaveCount(8);
    for (const [i, [name, courses]] of PLAN.entries()) {
      const term = terms.nth(i);
      await expect(term.getByRole("heading")).toHaveText(name);
      // One code, with its space: how it is read out, copied and found.
      const listed = (await term.getByRole("listitem").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
      expect(listed, name).toEqual([...courses]);
    }
    // Those 48 and no more. The file the Plan is built from also holds
    // the Courses the scene lets fall away, and they are not in it.
    await expect(plan(page).locator("li li")).toHaveCount(48);
    for (const other of ["MATH 110", "FIN 413", "SPAN 131", "GEOSC 10"]) {
      await expect(page.getByText(other, { exact: true }), `${other} is printed, and it is not in the Plan`).toHaveCount(0);
    }
  });

  test("the page says the Plan is a sample, beside it and in the disclaimer", async ({ page }) => {
    await page.goto("/");
    const caption = page.getByRole("figure").locator("figcaption");
    await expect(caption).toBeVisible();
    expect(await said(caption)).toMatch(/^Sample plan · Computer Science, B\.S\. .* Yours will differ\.$/);
    await expect(page.getByRole("contentinfo").getByText(/The plan drawn above is a sample/i)).toBeVisible();
  });

  test("the figures are numbers, with the coverage figure's qualifier", async ({ page }) => {
    // Written in by the build from the latest Edition. What a visitor can
    // check is that they arrived as numbers; that they are the RIGHT numbers
    // is recomputed from the catalog in the unit suite (build-output.test.ts,
    // "the coverage figure").
    await page.goto("/");
    await expect(page.getByText(/^\d{1,3}(,\d{3})+ courses$/)).toBeVisible();
    await expect(page.getByText(/^\d{3,} programs$/)).toBeVisible();
    await expect(page.getByText(/^The 20\d\d–\d\d Bulletin, read whole$/)).toBeVisible();
    const claim = page.getByText(/resolve to real, named courses/i);
    // A bare percentage reads as a guarantee. The clause is what makes it a
    // measurement, and the number does not travel without it.
    expect(await said(claim)).toMatch(
      /^\d{1,3}% of requirements across \d+ programs resolve to real, named courses\. The rest are flagged for you, never guessed at\.$/,
    );
    await expect(page.locator("body")).not.toContainText(/%[A-Z_]{3,}%/);
  });

  test("the disclaimer is there, in text meant to be read", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await page.goto("/");
    const claim = page.getByText(/not affiliated with/i);
    await expect(claim, "the landing page says it is unofficial once, in full").toHaveCount(1);
    await expect(claim).toBeVisible();
    expect(await said(claim)).toMatch(/Verify everything with your academic adviser and LionPATH before you register\.$/);
    // "Legible" is not a feeling. Body size, not a footnote's, and enough
    // contrast to read on the footer's dark ground.
    const size = await claim.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size, `the disclaimer renders at ${size}px`).toBeGreaterThanOrEqual(14);
    const ratio = await contrast(claim);
    expect(ratio, `the disclaimer measures ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  test("connecting an assistant is a link, not a code block", async ({ page }) => {
    // The page is for students, not developers.
    await page.goto("/");
    await expect(page.locator("pre, code"), "the landing page is showing code").toHaveCount(0);
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Connect your AI" })).toHaveAttribute("href", "/connect/");
  });
});

test.describe("the landing page is usable", () => {
  // The document, with scripts on: a browser that cannot draw the scene.
  test.beforeEach(async ({ page }) => withoutWebGL(page));

  test("every way into the planner can be read, at rest and under the pointer", async ({ page }) => {
    // Reduced motion, so a colour is the colour and not a frame of the fade
    // towards it.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expectWaysInReadable(page);
  });

  test("the hero's way in stands clear of the headline", async ({ page }) => {
    // At phone width, where the two are stacked with nothing else between.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expectHeroWayInClear(page);
  });

  test("every Course in the Plan can be read on its disc", async ({ page }) => {
    // axe measures contrast, but skips what it cannot be sure of. The codes
    // are the page's picture, so each is measured: both tones of disc.
    await page.goto("/");
    const courses = plan(page).locator("li li");
    await expect(courses).toHaveCount(48);
    const worst = Math.min(...(await Promise.all((await courses.all()).map((c) => contrast(c)))));
    expect(worst, `the least legible Course code measures ${worst.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  test("everything in it can be reached by keyboard, and seen when it is", async ({ page }) => {
    await page.goto("/");
    await expectEveryLinkReachable(page);
  });

  test("the palette drawer from the prototype is not on the page", async ({ page }) => {
    // Nor any other control: the page has links, and nothing to operate.
    await page.goto("/");
    await expect(page.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(/field controls|opening palette/i)).toHaveCount(0);
  });

  test("the Plan is one rectangle on a wide screen, and Terms down on a narrow one", async ({ page }) => {
    const boxes = async () =>
      Promise.all(
        (await plan(page).locator(":scope > li").all()).map(async (term) => ({
          term: (await term.boundingBox())!,
          courses: (await Promise.all((await term.getByRole("listitem").all()).map((c) => c.boundingBox()))).map((b) => b!),
        })),
      );
    const near = (a: number, b: number) => Math.abs(a - b) < 1.5;

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const wide = await boxes();
    // Eight columns, left to right in Term order, six rows shared across
    // them: reading one row across is reading one lane.
    for (let t = 1; t < wide.length; t++) expect(wide[t].term.x, "the Terms are not side by side, in order").toBeGreaterThan(wide[t - 1].term.x);
    for (let lane = 0; lane < 6; lane++) {
      for (const { courses } of wide) expect(near(courses[lane].y, wide[0].courses[lane].y), `lane ${lane + 1} is not one row`).toBe(true);
    }
    const size = wide[0].courses[0].width;
    for (const { courses } of wide) for (const c of courses) expect(near(c.width, size) && near(c.height, size), "the discs are not one size").toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    const narrow = await boxes();
    for (let t = 1; t < narrow.length; t++) {
      expect(near(narrow[t].term.x, narrow[0].term.x), "the Terms are not stacked").toBe(true);
      expect(narrow[t].term.y, "the Terms are not in order down the page").toBeGreaterThan(narrow[t - 1].term.y);
    }
  });
});

test.describe("motion", () => {
  test.beforeEach(async ({ page }) => withoutWebGL(page));

  /** Where the footer's band of phrases has got to, in pixels. */
  const bandAt = (page: Page): Promise<number> =>
    page.locator(".strip-track").evaluate((track) => track.getBoundingClientRect().left);

  test("one thing on the page moves on its own, and it is the footer's band", async ({ page }) => {
    // The prototype's hero rose into place and its sections faded up. A page
    // that is complete as a document does neither. Its footer carried a
    // ticker, and the owner asked for that back: it is the one animation,
    // and what else moves is the scene, where there is one (#65), and here
    // there is not.
    await page.goto("/");
    await page.waitForTimeout(600);
    const animated = await page.evaluate(() =>
      document.getAnimations().map((a) => (a.effect as KeyframeEffect).target?.getAttribute("class")),
    );
    expect(animated).toEqual(["strip-track"]);
    // And it is seen to move: leftwards, the phrases arriving at the right.
    const before = await bandAt(page);
    await page.waitForTimeout(400);
    expect(await bandAt(page)).toBeLessThan(before - 2);
  });

  test("the band can be stopped and started again, from the keyboard, without a script", async ({ page }) => {
    // WCAG 2.2.2. It is a checkbox and a stylesheet, so it works on the
    // page as it is here, where the scene's script never started.
    await page.goto("/");
    const pause = page.getByRole("checkbox", { name: "Pause the moving text" });
    await pause.focus();
    await page.keyboard.press("Space");
    await expect(pause).toBeChecked();
    // A frame for the hold to take, or the last step of the move is read
    // as the band still moving.
    await page.waitForTimeout(150);
    const held = await bandAt(page);
    await page.waitForTimeout(400);
    expect(await bandAt(page)).toBe(held);
    await page.keyboard.press("Space");
    await page.waitForTimeout(400);
    expect(await bandAt(page)).toBeLessThan(held - 2);
  });

  test("the band is decoration to a screen reader, and whole to anyone who asked for less motion", async ({ page }) => {
    await page.goto("/");
    // Written twice so that it loops. Read out not at all.
    await expect(page.locator(".strip-track")).toHaveAttribute("aria-hidden", "true");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    // One run of the four phrases, none cut off at the edge, and no control
    // for a motion that is not there.
    await expect(page.getByRole("checkbox", { name: "Pause the moving text" })).toHaveCount(0);
    const shown = page.locator(".strip-run span:visible");
    await expect(shown).toHaveText(["Less guesswork", "More degree", "Every prerequisite, in order", "Start at the first stop"]);
    const viewport = page.viewportSize()!.width;
    for (const phrase of await shown.all()) {
      const box = (await phrase.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport + 0.5);
    }
  });

  test("under reduced motion, nothing moves when it is touched either", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    // Every element, since any of them can be hovered or focused: none is
    // set to animate, and none to take time over a change.
    const moving = await page.evaluate(() =>
      [...document.querySelectorAll("body, body *")]
        .filter((el) => {
          const style = getComputedStyle(el);
          const takesTime = style.transitionDuration.split(",").some((d) => parseFloat(d) > 0);
          return takesTime || style.animationName !== "none";
        })
        .map((el) => `<${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}">`),
    );
    expect([...new Set(moving)], "set to move under reduced motion").toEqual([]);
    // And seen not to, on the two links that do move for everyone else.
    for (const link of [
      page.getByRole("banner").getByRole("link", { name: "Start my plan" }),
      page.getByRole("contentinfo").getByRole("link", { name: "Open the planner" }),
    ]) {
      await link.scrollIntoViewIfNeeded();
      await link.hover();
      expect(await page.evaluate(() => document.getAnimations().length), "a transition ran under reduced motion").toBe(0);
    }
  });
});
