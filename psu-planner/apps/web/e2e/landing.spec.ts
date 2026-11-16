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
 * the page anyone the scene does not reach is given.
 *
 * What is NOT repeated here: that the page sits on cream, wears the shared
 * header, asks no other host for anything, fits a phone and passes axe. `/`
 * is in the list site-pages.spec.ts holds to all of that. That the old
 * `#about`, `#contact` and `#discovery` addresses still arrive somewhere is
 * in about.spec.ts and connect.spec.ts.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, expectNoA11yViolations } from "./fixtures";

/** The sample Plan, written out as a reader meets it. A literal on purpose:
 * a test that read the Plan from the file the page is built from would agree
 * with whatever that file said. */
const TERMS = [
  ["Fall 1", ["MATH 140", "PSYCH 100", "CMPSC 131", "CMPSC 150N", "ENGL 15", "ENGR 100"]],
  ["Spring 1", ["MATH 141", "PHYS 211", "CMPSC 132", "SOC 1", "MUSIC 4", "GEOG 30N"]],
  ["Fall 2", ["MATH 230", "PHYS 212", "CMPSC 221", "MATH 220", "CAS 100A", "THEA 100"]],
  ["Spring 2", ["ASTRO 5", "CMPEN 270", "CMPSC 222", "CMPSC 360", "PHIL 10", "KINES 77"]],
  ["Fall 3", ["STAT 318", "CMPSC 315", "CMPSC 465", "CMPSC 320", "HIST 21", "ASIA 100"]],
  ["Spring 3", ["STAT 319", "CMPSC 316", "CMPSC 461", "CMPSC 442", "ENGL 202C", "COMM 150N"]],
  ["Fall 4", ["CMPSC 448", "CMPSC 464", "CMPSC 483W", "CMPSC 471", "CMPSC 431W", "NUTR 100"]],
  ["Spring 4", ["CMPSC 455", "CMPSC 467", "CMPSC 410", "ARTH 100", "CMLIT 153", "EARTH 100"]],
] as const;

/** The Plan's list, found the way assistive technology finds it. */
const plan = (page: Page): Locator => page.getByRole("list", { name: /a sample plan for Computer Science, B\.S\./i });

/** What an element says, as a reader takes it in: one line, single spaces.
 * The markup wraps its sentences, and a pattern anchored at either end does
 * not survive the line breaks. */
const said = async (el: Locator): Promise<string> => (await el.innerText()).replace(/\s+/g, " ").trim();

/** Contrast of an element's text against the first opaque thing behind it. */
async function contrast(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const lum = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const rgba = (css: string) => {
      // Everything on this page computes to rgb()/rgba() or color(srgb …).
      const n = css.match(/[\d.]+/g)!.map(Number);
      const unit = css.startsWith("color(") ? 255 : 1;
      return { r: n[0] * unit, g: n[1] * unit, b: n[2] * unit, a: n[3] ?? 1 };
    };
    const L = (c: { r: number; g: number; b: number }) => 0.2126 * lum(c.r) + 0.7152 * lum(c.g) + 0.0722 * lum(c.b);
    let ground = { r: 255, g: 255, b: 255 };
    for (let up: Element | null = node; up; up = up.parentElement) {
      const bg = rgba(getComputedStyle(up).backgroundColor);
      if (bg.a === 1) { ground = bg; break; }
    }
    const ink = rgba(getComputedStyle(node).color);
    // The ink may itself be translucent: lay it over the ground first.
    const laid = { r: ink.r * ink.a + ground.r * (1 - ink.a), g: ink.g * ink.a + ground.g * (1 - ink.a), b: ink.b * ink.a + ground.b * (1 - ink.a) };
    const [a, b] = [L(laid), L(ground)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test.describe("with JavaScript turned off", () => {
  // A previewer, a crawler and a student on a locked-down machine all land
  // here. So does anyone the scene cannot reach.
  test.use({ javaScriptEnabled: false });

  test("the page says what LionsDegree is", async ({ page }) => {
    await page.goto("/");
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
    // And nothing stands in front of it.
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the sample Plan is there as a list: eight Terms of six Courses, in order", async ({ page }) => {
    await page.goto("/");
    const terms = plan(page).locator(":scope > li");
    await expect(terms).toHaveCount(8);
    for (const [i, [name, courses]] of TERMS.entries()) {
      const term = terms.nth(i);
      await expect(term.getByRole("heading")).toHaveText(name);
      // One code, with its space: how it is read out, copied and found.
      const listed = (await term.getByRole("listitem").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
      expect(listed, name).toEqual([...courses]);
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
    // is recomputed from the catalog in the unit suite.
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
  test("has no mechanically detectable accessibility violations", async ({ page }) => {
    await page.goto("/");
    await expectNoA11yViolations(page, "the landing page");
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
    const links = await page.locator("main a, footer a").count();
    expect(links, "found no links to reach").toBeGreaterThan(10);
    const reached = new Set<string>();
    const unringed: string[] = [];
    // The skip link and the header's five come first; then every link on
    // the page, in order.
    for (let i = 0; i < links + 8; i++) {
      await page.keyboard.press("Tab");
      const at = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          name: `${(el.textContent ?? "").replace(/\s+/g, " ").trim()} -> ${el.getAttribute("href")}`,
          inPage: Boolean(el.closest("main, footer")),
          ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
        };
      });
      if (!at?.inPage) continue;
      reached.add(at.name);
      if (!at.ring) unringed.push(at.name);
    }
    expect(reached.size, "some links cannot be reached with Tab").toBe(links);
    expect(unringed, "focused, with nothing to show it").toEqual([]);
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
  test("nothing on the page moves on its own", async ({ page }) => {
    // The prototype's hero rose into place, its sections faded up and its
    // footer carried a ticker that never stopped. A page that is complete as
    // a document does none of that; what moves, moves because the scene is
    // running (#65).
    await page.goto("/");
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });

  test("under reduced motion, nothing moves when it is touched either", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
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
