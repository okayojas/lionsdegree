/** The gravity scene on the landing page (#60, #65).
 *
 * A field of labelled spheres laid over the page: scrambled, then a pile,
 * then the sample Plan as a rectangle, then gone past the camera. It is an
 * enhancement, so two things are tested here. That the scene does what the
 * design says; and that where it cannot run, the page is the page.
 *
 * NOT FROM PIXELS. A screenshot compared by eye is not a test. The scene
 * reports itself as numbers (`window.__lionsdegreeScene.report()`: where each
 * Course is, whether it is showing, where its cell is), and can be stepped
 * (`advance`) so a test does not wait on how fast this machine draws. What is
 * asserted is what a visitor would see, read from those numbers.
 *
 * WHERE THESE RUN: ON A MACHINE WITH A GPU, AND NOWHERE ELSE. The page
 * refuses a scene it could only draw in software, and a headless browser
 * with no GPU is exactly that, so there the tests of the scene skip. (Making
 * the browser accept a software context was tried: the scene is then drawn
 * at three frames a second, and most of these time out.) On Windows the
 * suite points the browser at the real GPU (playwright.config.ts). On a
 * runner without one, what still runs is everything about the page WITHOUT
 * the scene, here and in landing.spec.ts, and the scene's arithmetic in the
 * unit suite. A scene that goes missing on a machine that could draw it is
 * a failure, not a skip.
 */
import type { Page } from "@playwright/test";
import type { SceneReport } from "../src/landing/scene";
import { scrollYAt, type PageAnchors } from "../src/landing/field-math";
import { test, expect, expectNoA11yViolations, withoutWebGL } from "./fixtures";
import { expectEveryLinkReachable, expectHeroWayInClear, expectWaysInReadable } from "./landing-checks";
import { PLAN } from "./the-sample-plan";

/** Close enough to a cell to be in it: a quarter of the gap between cells. */
const IN_CELL = 0.25;

/** The scene's chunk, by its address. */
const SCENE_CHUNK = /\/assets\/scene-/;

/** Whether this browser can draw the scene: WebGL, on a GPU. Asked of the
 * browser and not of the page, so that a page which has stopped starting
 * its scene is caught and not excused. (What it is drawing with, by name:
 * a browser with no GPU hands out a context all the same.) */
const canDrawScene = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl", { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  });

/** Skips the test in a browser that cannot draw the scene, which is not a
 * failure of the scene. Call after the page has loaded. */
async function skipUnlessSceneCanBeDrawn(page: Page): Promise<void> {
  test.skip(!(await canDrawScene(page)), "this browser has no GPU to draw WebGL on, so the page shows without the scene");
}

/** Opens the landing page and waits for its scene. Where the browser can
 * draw one and none appears, this fails. */
async function openScene(page: Page): Promise<void> {
  await page.goto("/");
  await skipUnlessSceneCanBeDrawn(page);
  await page.waitForFunction(() => Boolean(window.__lionsdegreeScene), undefined, { timeout: 30_000 });
}

/** Scrolls to a stage and lets the simulation run on. `progress` is the
 * scene's own measure: 0 scrambled, 1 fallen, 2 assembled, 3.6 gone. */
async function at(page: Page, progress: number, steps: number): Promise<SceneReport> {
  const anchors: PageAnchors = await page.evaluate(() => ({
    catalog: document.getElementById("catalog")!.offsetTop,
    plan: document.getElementById("plan")!.offsetTop,
    release: document.getElementById("go")!.offsetTop,
    viewport: innerHeight,
  }));
  return page.evaluate(
    ([y, steps]) => {
      scrollTo(0, y);
      window.__lionsdegreeScene!.advance(steps);
      return window.__lionsdegreeScene!.report();
    },
    [scrollYAt(progress, anchors), steps] as const,
  );
}

/** The addresses the page asks for that are the scene's chunk. */
function sceneRequests(page: Page): string[] {
  const asked: string[] = [];
  page.on("request", (r) => {
    if (SCENE_CHUNK.test(r.url())) asked.push(r.url());
  });
  return asked;
}

const planOf = (r: SceneReport) => r.courses.filter((c) => c.inPlan);
const othersOf = (r: SceneReport) => r.courses.filter((c) => !c.inPlan);
const home = (r: SceneReport) =>
  planOf(r).filter((c) => Math.hypot(c.x - c.home!.x, c.y - c.home!.y) < r.cell * IN_CELL && Math.abs(c.z) < r.cell * IN_CELL);

/** The rectangle, asserted in full: every Plan Course in its own cell, one
 * size, nothing else showing, and the cells in Term order. */
function expectTheRectangle(r: SceneReport): void {
  expect(home(r).map((c) => c.code).sort(), "Plan Courses not in their cells").toEqual(PLAN.flatMap(([, courses]) => courses).sort());
  expect(othersOf(r).filter((c) => c.showing).map((c) => c.code), "a Course that is not in the Plan is showing").toEqual([]);
  expect(r.courses.filter((c) => c.showing)).toHaveLength(48);
  const sizes = planOf(r).map((c) => c.size);
  expect(Math.max(...sizes) - Math.min(...sizes), "the Plan's Courses are not one size").toBeLessThan(0.01);

  // Where each Course is, against where the page lists it.
  const where = new Map(planOf(r).map((c) => [c.code, c]));
  PLAN.forEach(([name, courses], term) => {
    courses.forEach((code, lane) => {
      const c = where.get(code)!;
      const first = where.get(PLAN[0][1][lane])!; // the same lane, in the first Term
      const top = where.get(courses[0])!; // the same Term, in the first lane
      if (r.wide) {
        // Terms across, in order; a lane is one row.
        expect(c.x - first.x, `${code} is not in ${name}'s column`).toBeCloseTo(term * r.cell, 1);
        expect(top.y - c.y, `${code} is not ${lane + 1} down`).toBeCloseTo(lane * r.cell, 1);
      } else {
        // Terms down, in order; a Term is one row.
        expect(first.y - c.y, `${code} is not in ${name}'s row`).toBeCloseTo(term * r.cell, 1);
        expect(c.x - top.x, `${code} is not ${lane + 1} across`).toBeCloseTo(lane * r.cell, 1);
      }
    });
  });
}

test.describe("the scene", () => {
  test("is 96 spheres on a wide screen and 54 on a phone, each a Course, 48 of them the Plan's", async ({ page, viewport }) => {
    await openScene(page);
    const r = await at(page, 0, 60);
    expect(r.courses).toHaveLength(viewport!.width < 768 ? 54 : 96);
    expect(planOf(r).map((c) => c.code).sort()).toEqual(PLAN.flatMap(([, courses]) => courses).sort());
    // Every sphere has a code on it, and no Course is on two.
    for (const c of r.courses) expect(c.code).toMatch(/^[A-Z]+ \d+[A-Z]?$/);
    expect(new Set(r.courses.map((c) => c.code)).size).toBe(r.courses.length);
  });

  test("moves by itself, with nobody stepping it", async ({ page }) => {
    // Every other test here steps the simulation by hand. This is the one
    // that would notice a scene that had simply stopped.
    await openScene(page);
    const before = await page.evaluate(() => window.__lionsdegreeScene!.report());
    await expect
      .poll(() => page.evaluate(() => window.__lionsdegreeScene!.report().steps), { timeout: 15_000 })
      .toBeGreaterThan(before.steps + 10);
    const after = await page.evaluate(() => window.__lionsdegreeScene!.report());
    const moved = after.courses.filter((c, i) => Math.hypot(c.x - before.courses[i].x, c.y - before.courses[i].y) > 0.001);
    expect(moved.length, "the steps were counted and nothing moved").toBeGreaterThan(after.courses.length / 2);
  });

  test("is in no order scrambled, and in none as a pile", async ({ page }) => {
    await openScene(page);
    const scrambled = await at(page, 0, 300);
    expect(scrambled.courses.every((c) => c.showing)).toBe(true);
    expect(home(scrambled).length, "scrambled, and already in order").toBeLessThan(5);
    // On screen, as one cluster: not still on its way in.
    expect(Math.max(...scrambled.courses.map((c) => Math.abs(c.y)))).toBeLessThan(scrambled.view.height);

    const pile = await at(page, 1.1, 500);
    expect(pile.courses.every((c) => c.showing)).toBe(true);
    expect(home(pile).length, "a pile, and already in order").toBeLessThan(5);
    // It has fallen: the lot of it is in the bottom half of the screen.
    const heights = pile.courses.map((c) => c.y).sort((a, b) => a - b);
    expect(heights[Math.floor(heights.length * 0.9)], "nine in ten are not below the middle").toBeLessThan(0);
  });

  test("lets everything fall out through the floor and back in from the top, and catches only the Plan", async ({ page }) => {
    await openScene(page);
    await at(page, 1.1, 400);
    // The floor opens. Watched one step at a time: a sphere in free fall
    // crosses the strip below the screen in a single step, and a coarser
    // watch simply misses it.
    await at(page, 1.6, 0);
    const seen = await page.evaluate(() => {
      const below = new Set<string>();
      const thenAbove = new Set<string>();
      for (let i = 0; i < 400; i++) {
        window.__lionsdegreeScene!.advance(1);
        const r = window.__lionsdegreeScene!.report();
        for (const c of r.courses) {
          if (c.y < -r.view.height / 2) below.add(c.code);
          else if (below.has(c.code) && c.y > r.view.height / 2 - c.size) thenAbove.add(c.code);
        }
      }
      return { below: [...below].sort(), thenAbove: [...thenAbove].sort() };
    });
    const all = (await at(page, 1.6, 0)).courses.map((c) => c.code).sort();
    expect(seen.below, "did not fall out through the floor").toEqual(all);
    expect(seen.thenAbove, "did not come back in from the top").toEqual(all);

    // And then the Plan is caught, and the rest are not.
    expectTheRectangle(await at(page, 2.3, 700));
  });

  test("lays the Terms across on a wide screen and down on a tall one, between the heading and the caption", async ({ page, viewport }) => {
    await openScene(page);
    const r = await at(page, 2.3, 700);
    // Which way round is the screen's doing, so it is asked of the screen.
    expect(r.wide, `${viewport!.width} by ${viewport!.height}`).toBe(viewport!.width / viewport!.height >= 1.2);
    expect(r.termNames, r.wide ? "the Term names are not showing" : "Term names on a tall screen").toBe(r.wide ? 1 : 0);
    // Nothing is in the scene but Courses and those names: there is no line
    // from one Course to another to draw.
    expect(r.courses.filter((c) => c.showing)).toHaveLength(48);

    // On the page, the rectangle sits in the space the text leaves it: under
    // the heading, over the caption, inside the screen.
    const text = await page.evaluate(() => ({
      header: document.querySelector("header")!.getBoundingClientRect().bottom,
      top: document.querySelector("#plan .plan-top")!.getBoundingClientRect().top,
      heading: document.querySelector("#plan h2")!.getBoundingClientRect().bottom,
      caption: document.querySelector("#plan figcaption")!.getBoundingClientRect().top,
      width: innerWidth,
      height: innerHeight,
    }));
    const px = (c: { x: number; y: number; size: number }) => ({
      left: ((c.x - c.size + r.view.width / 2) / r.view.width) * text.width,
      right: ((c.x + c.size + r.view.width / 2) / r.view.width) * text.width,
      top: ((r.view.height / 2 - c.y - c.size) / r.view.height) * text.height,
      bottom: ((r.view.height / 2 - c.y + c.size) / r.view.height) * text.height,
    });
    // The header rides over this section, and on a phone its links take a
    // second row: the words start below it, however tall it is.
    expect(text.top, "the section's heading starts under the header").toBeGreaterThanOrEqual(text.header);
    const discs = planOf(r).map(px);
    expect(Math.min(...discs.map((d) => d.top)), "the rectangle runs up into the heading").toBeGreaterThanOrEqual(text.heading);
    expect(Math.max(...discs.map((d) => d.bottom)), "the rectangle runs down into the caption").toBeLessThanOrEqual(text.caption);
    expect(Math.min(...discs.map((d) => d.left)), "the rectangle runs off the left").toBeGreaterThanOrEqual(0);
    expect(Math.max(...discs.map((d) => d.right)), "the rectangle runs off the right").toBeLessThanOrEqual(text.width);

    // Before the rectangle and after it, the names are not there.
    expect((await at(page, 1.1, 200)).termNames).toBe(0);
    expect((await at(page, 3.3, 200)).termNames).toBe(0);
  });

  test("goes back to the pile on the way up, and makes the same rectangle on the way down again", async ({ page }) => {
    await openScene(page);
    expectTheRectangle(await at(page, 2.3, 800));
    const pile = await at(page, 1.0, 500);
    expect(pile.courses.filter((c) => !c.showing).map((c) => c.code), "did not come back to the pile").toEqual([]);
    expect(home(pile).length).toBeLessThan(5);
    expectTheRectangle(await at(page, 2.3, 800));
  });

  test("flies past the camera and fades, and does the whole thing again afterwards", async ({ page }) => {
    await openScene(page);
    expectTheRectangle(await at(page, 2.3, 800));
    const flown = await at(page, 3.6, 500);
    expect(flown.courses.filter((c) => c.showing).map((c) => c.code), "still on screen after the flight").toEqual([]);
    // Past the lens, which is 11 units back from the origin.
    for (const c of planOf(flown)) expect(c.z, `${c.code} did not go past the camera`).toBeGreaterThan(11);

    // Left on the footer for a long time (five minutes of simulation), the
    // spheres are still somewhere a number can describe.
    const later = await at(page, 4.6, 18_000);
    for (const c of later.courses) {
      for (const v of [c.x, c.y, c.z]) expect(Number.isFinite(v) && Math.abs(v) < 5000, `${c.code} is at ${v}`).toBe(true);
    }

    await at(page, 1.0, 500);
    expectTheRectangle(await at(page, 2.3, 800));
  });

  test("stops working when there is nothing left to draw, and starts again when there is", async ({ page }) => {
    // After the flight the canvas is empty and under the footer. A loop
    // that went on stepping and drawing there would be heat and nothing else.
    await openScene(page);
    await at(page, 2.3, 600);
    await at(page, 4.6, 600);
    const steps = () => page.evaluate(() => window.__lionsdegreeScene!.report().steps);
    // It notices on the next frame it draws, which is one last run of
    // steps and may be a while coming on a busy machine. So: over two
    // seconds it takes at most that one run (three steps), where a loop
    // still going would take a hundred and twenty.
    await page.waitForTimeout(500);
    const resting = await steps();
    await page.waitForTimeout(2000);
    expect((await steps()) - resting, "still stepping with nothing on screen").toBeLessThanOrEqual(3);
    // Back up the page, and it is running again.
    await page.evaluate(() => scrollTo(0, 0));
    await expect
      .poll(() => page.evaluate(() => window.__lionsdegreeScene!.report().steps), { timeout: 15_000 })
      .toBeGreaterThan(resting + 13);
  });

  test("is not moved by the pointer", async ({ page }) => {
    // The prototype pushed the spheres away from the cursor, harder while
    // pressed. The owner took it out: scroll is the only input.
    await openScene(page);
    const before = await at(page, 2.3, 800);
    expectTheRectangle(before);
    const box = page.viewportSize()!;
    for (let i = 0; i <= 24; i++) {
      await page.mouse.move((box.width * i) / 24, box.height * (0.3 + 0.4 * Math.abs(Math.sin(i))));
    }
    await page.mouse.move(box.width / 2, box.height / 2);
    await page.mouse.down();
    const after = await at(page, 2.3, 120);
    await page.mouse.up();
    expectTheRectangle(after);
    const moved = planOf(after).map((c, i) => Math.hypot(c.x - planOf(before)[i].x, c.y - planOf(before)[i].y));
    expect(Math.max(...moved), "a Course moved under the pointer").toBeLessThan(0.02);
  });

  test("goes from petrol to sky to green", async ({ page }) => {
    await openScene(page);
    expect((await at(page, 0, 30)).tone, "scrambled, in the planner's petrol").toBe("#1d627f");
    expect((await at(page, 1.1, 30)).tone, "fallen, in sky").toBe("#5dbbf5");
    expect((await at(page, 2.3, 30)).tone, "assembled, in the green of a plan in order").toBe("#5a8c69");
  });

  test("arrives after the page has painted, from this origin", async ({ page, baseURL }) => {
    await openScene(page);
    const seen = await page.evaluate((chunk) => ({
      painted: performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint")?.startTime ?? null,
      chunks: performance.getEntriesByType("resource").filter((r) => new RegExp(chunk).test(r.name)).map((r) => ({ url: r.name, asked: r.startTime })),
    }), SCENE_CHUNK.source);
    expect(seen.chunks, "the scene's chunk was never fetched").toHaveLength(1);
    expect(seen.painted, "the page reports no first paint").not.toBeNull();
    expect(seen.chunks[0].asked, "the scene was asked for before the page had painted").toBeGreaterThan(seen.painted!);
    expect(new URL(seen.chunks[0].url).origin).toBe(new URL(baseURL!).origin);
  });

  test("keeps the Plan's list on the page until the spheres are there to draw it", async ({ page }) => {
    // The scene takes a moment to arrive. A reader who gets to the Plan first
    // must find the list, not a gap where the spheres will be.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(SCENE_CHUNK, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/");
    await skipUnlessSceneCanBeDrawn(page);
    const list = page.getByRole("list", { name: /a sample plan for Computer Science/i });
    await list.scrollIntoViewIfNeeded();
    await expect(list).toBeInViewport();
    expect((await list.boundingBox())!.width, "the list is clipped away and the scene has not come").toBeGreaterThan(200);
    // Now it comes, and the spheres take over: the list is clipped to a
    // point (it is still there for a screen reader; another test says so).
    release();
    await page.waitForFunction(() => Boolean(window.__lionsdegreeScene), undefined, { timeout: 30_000 });
    await expect.poll(async () => (await list.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
  });

  test("the header steps aside when the footer slides under it, and comes back", async ({ page }) => {
    await openScene(page);
    // By its element, not its role: once it has stepped aside it is not in
    // the accessibility tree to be found by one, which is the point.
    const header = page.locator("header").first();
    await expect(header).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(1);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    // Gone from sight, and with it from the keyboard's way.
    await expect(header).toBeHidden();
    await expect(page.getByRole("banner")).toHaveCount(0);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("header"))), "focus went to a header nobody can see").toBe(false);
    await page.evaluate(() => scrollTo(0, 0));
    await expect(header).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(1);
  });

  test("still gives a screen reader the Plan as a list, and passes axe at every stage", async ({ page }) => {
    await openScene(page);
    for (const [progress, stage] of [[0, "scrambled"], [1.1, "the pile"], [2.3, "the rectangle"], [3.3, "the flight"]] as const) {
      await at(page, progress, 200);
      await expectNoA11yViolations(page, `the landing page with the scene at ${stage}`);
    }
    // The spheres replace the list for the eye, and for nothing else.
    const list = page.getByRole("list", { name: /a sample plan for Computer Science/i });
    await expect(list.locator(":scope > li")).toHaveCount(8);
    await expect(list.locator("li li")).toHaveCount(48);
    // And the canvas is no part of what is read out.
    await expect(page.getByRole("img")).toHaveCount(0);
    expect(await page.locator("canvas").evaluate((c) => Boolean(c.closest("[aria-hidden='true']")))).toBe(true);
  });

  for (const width of [320, 390]) {
    test(`is no wider than a ${width}px phone at any stage`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 });
      await openScene(page);
      for (const progress of [0, 1.1, 2.3, 3.3, 4.6]) {
        await at(page, progress, 150);
        const m = await page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth }));
        expect(m.inner, `zoomed out to fit at stage ${progress}`).toBe(width);
        expect(m.scroll, `wider than the screen at stage ${progress}`).toBeLessThanOrEqual(width);
      }
    });
  }

  test("is still a page to use: the ways in can be read, and every link reached", async ({ page }) => {
    // What landing.spec.ts asks of the document, asked again with the scene
    // behind it and the layout that goes with one.
    await openScene(page);
    await expectHeroWayInClear(page);
    await expectWaysInReadable(page);
    await page.evaluate(() => scrollTo(0, 0));
    await expectEveryLinkReachable(page);
  });

  test("glides when the wheel is turned, and gets out of the way of everything else", async ({ page, isMobile }) => {
    test.skip(isMobile, "a wheel is a mouse's; touch scrolls natively");
    await openScene(page);
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 900);
    // Not there yet a moment later, and there in the end.
    await page.waitForTimeout(80);
    expect(await page.evaluate(() => scrollY), "the wheel jumped the page").toBeLessThan(900);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 8000 }).toBe(900);

    // Mid-glide, the keyboard wins: End goes to the end, and stays there.
    // (A beat first, so every event of this turn of the wheel has landed
    // and the glide is under way: it takes about a second to settle.)
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => scrollY), "the glide had already finished, so this would show nothing").toBeGreaterThan(40);
    await page.keyboard.press("End");
    const bottom = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 8000 }).toBe(Math.round(bottom));
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => Math.round(scrollY)), "the glide pulled the page back from where the keyboard put it").toBe(Math.round(bottom));

    // And a sideways wheel, or shift and the wheel, is not this page's to take.
    const taken = await page.evaluate(() =>
      [{ deltaX: 120, deltaY: 0 }, { deltaX: 0, deltaY: 120, shiftKey: true }].map((init) => {
        const e = new WheelEvent("wheel", { ...init, cancelable: true, bubbles: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      }),
    );
    expect(taken).toEqual([false, false]);
  });
});

test.describe("where the scene cannot run, the page is the page", () => {
  /** The static page: its layout, its list, and nothing of the scene's. */
  async function expectTheStaticPage(page: Page): Promise<void> {
    await expect(page.locator("canvas")).toHaveCount(0);
    expect(await page.evaluate(() => "__lionsdegreeScene" in window)).toBe(false);
    // The header is part of the page again, not riding over it.
    await page.evaluate(() => scrollTo(0, 600));
    await expect(page.getByRole("banner")).not.toBeInViewport();
    // And the Plan is there to be seen, as the list.
    const list = page.getByRole("list", { name: /a sample plan for Computer Science/i });
    await list.scrollIntoViewIfNeeded();
    await expect(list).toBeInViewport();
    expect((await list.boundingBox())!.width, "the list is on the page but clipped away").toBeGreaterThan(200);
  }

  /** Whether the page takes the wheel for itself. A static page does not. */
  const takesTheWheel = (page: Page): Promise<boolean> =>
    page.evaluate(() => {
      const e = new WheelEvent("wheel", { deltaY: 120, cancelable: true, bubbles: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });

  test("under reduced motion: no scene, the list, and a wheel that is not smoothed", async ({ page }) => {
    const asked = sceneRequests(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForTimeout(600);
    await expectTheStaticPage(page);
    expect(asked, "the scene was downloaded for a reader who asked for no motion").toEqual([]);
    // The wheel is the browser's: nothing on the page takes it to ease it.
    expect(await takesTheWheel(page)).toBe(false);
  });

  test("with no WebGL: no scene, and nothing downloaded for one", async ({ page }) => {
    const asked = sceneRequests(page);
    await withoutWebGL(page);
    await page.goto("/");
    await page.waitForTimeout(600);
    await expectTheStaticPage(page);
    expect(asked).toEqual([]);
    expect(await takesTheWheel(page)).toBe(false);
  });

  test("with WebGL in software only: no scene either, and nothing downloaded for one", async ({ page }) => {
    // A browser with no GPU to draw on will still hand out a WebGL context,
    // and draw the scene at three frames a second with it (measured). It
    // says what it is drawing with when asked, and the page asks.
    const asked = sceneRequests(page);
    await withoutWebGL(page, "software only");
    await page.goto("/");
    await page.waitForTimeout(600);
    await expectTheStaticPage(page);
    expect(asked).toEqual([]);
  });

  test.describe("when the scene was on its way and did not make it", () => {
    test("the chunk fails to load", async ({ page }) => {
      await page.route(SCENE_CHUNK, (route) => route.abort());
      await page.goto("/");
      await skipUnlessSceneCanBeDrawn(page);
      await expect(page.locator("canvas")).toHaveCount(0, { timeout: 15_000 });
      await expectTheStaticPage(page);
    });

    test("the chunk never arrives", async ({ page }) => {
      test.slow();
      // Asked for, and no answer. The page does not wait for ever.
      await page.route(SCENE_CHUNK, () => {});
      await page.goto("/");
      await skipUnlessSceneCanBeDrawn(page);
      await expect(page.locator("canvas")).toHaveCount(0, { timeout: 20_000 });
      await expectTheStaticPage(page);
    });

    test("the scene arrives and will not start", async ({ page }) => {
      await page.route(SCENE_CHUNK, (route) =>
        route.fulfill({ contentType: "text/javascript", body: 'export function mount() { throw new Error("no renderer today"); }' }),
      );
      await page.goto("/");
      await skipUnlessSceneCanBeDrawn(page);
      await expect(page.locator("canvas")).toHaveCount(0, { timeout: 15_000 });
      await expectTheStaticPage(page);
    });

    test("the browser takes the scene's context away after it has started", async ({ page }) => {
      await page.goto("/");
      await skipUnlessSceneCanBeDrawn(page);
      await page.waitForFunction(() => Boolean(window.__lionsdegreeScene), undefined, { timeout: 30_000 });
      await page.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
        gl.getExtension("WEBGL_lose_context")!.loseContext();
      });
      await expect(page.locator("canvas")).toHaveCount(0, { timeout: 15_000 });
      await expectTheStaticPage(page);
    });
  });
});
