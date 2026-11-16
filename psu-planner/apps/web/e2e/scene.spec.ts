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
 */
import type { Page } from "@playwright/test";
import type { SceneReport } from "../src/landing/scene";
import { test, expect, expectNoA11yViolations, withoutWebGL } from "./fixtures";
import { PLAN } from "./the-sample-plan";

/** Close enough to a cell to be in it: a quarter of the gap between cells. */
const IN_CELL = 0.25;

/** Opens the landing page and waits for its scene. Skips the test in a
 * browser that cannot draw one, which is not a failure of the scene. */
async function openScene(page: Page): Promise<void> {
  await page.goto("/");
  const able = await page.evaluate(() => document.documentElement.classList.contains("has-scene"));
  test.skip(!able, "this browser cannot draw WebGL on a GPU, so the page shows without the scene");
  await page.waitForFunction(() => Boolean(window.__lionsdegreeScene), undefined, { timeout: 30_000 });
}

/** Scrolls to a stage and lets the simulation run on. `progress` is the
 * scene's own measure: 0 scrambled, 1 fallen, 2 assembled, 3.6 gone. */
async function at(page: Page, progress: number, steps: number): Promise<SceneReport> {
  return page.evaluate(
    ([progress, steps]) => {
      const top = (id: string) => document.getElementById(id)!.offsetTop;
      const stops = [[0, 0], [top("catalog"), 1], [top("plan"), 2], [top("go"), 3.6]];
      let y = stops[3][0] + (progress - 3.6) * innerHeight;
      for (let i = 1; i < stops.length; i++) {
        if (progress <= stops[i][1]) {
          const [y0, p0] = stops[i - 1], [y1, p1] = stops[i];
          y = y0 + ((y1 - y0) * (progress - p0)) / (p1 - p0);
          break;
        }
      }
      scrollTo(0, y);
      window.__lionsdegreeScene!.advance(steps);
      return window.__lionsdegreeScene!.report();
    },
    [progress, steps] as const,
  );
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
    // The floor opens. Watched in short runs, since the claim is about the
    // way there: every sphere goes off the bottom, and comes back in above.
    // One step at a time: a sphere in free fall crosses the strip below the
    // screen in a single step, and a coarser watch simply misses it.
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

  test("names the Terms above the rectangle on a wide screen, and draws no lines", async ({ page }) => {
    await openScene(page);
    const r = await at(page, 2.3, 700);
    expect(r.termNames, r.wide ? "the Term names are not showing" : "Term names on a tall screen").toBe(r.wide ? 1 : 0);
    // Nothing is in the scene but Courses and those names: there is no line
    // from one Course to another to draw.
    expect(r.courses.filter((c) => c.showing)).toHaveLength(48);
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
    const seen = await page.evaluate(() => ({
      painted: performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint")?.startTime ?? null,
      chunks: performance.getEntriesByType("resource").filter((r) => /\/assets\/scene-/.test(r.name)).map((r) => ({ url: r.name, asked: r.startTime })),
    }));
    expect(seen.chunks, "the scene's chunk was never fetched").toHaveLength(1);
    expect(seen.painted, "the page reports no first paint").not.toBeNull();
    expect(seen.chunks[0].asked, "the scene was asked for before the page had painted").toBeGreaterThan(seen.painted!);
    expect(new URL(seen.chunks[0].url).origin).toBe(new URL(baseURL!).origin);
  });

  test("the header steps aside when the footer slides under it, and comes back", async ({ page }) => {
    await openScene(page);
    // By its element, not its role: once it has stepped aside it is not in
    // the accessibility tree to be found by one, which is the point.
    const header = page.locator("header.site-head");
    await expect(header).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(1);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    // Gone, and not somewhere the keyboard can land.
    await expect(header).toBeHidden();
    await expect(header).toHaveAttribute("inert", "");
    await expect(page.getByRole("banner")).toHaveCount(0);
    await page.evaluate(() => scrollTo(0, 0));
    await expect(header).toBeVisible();
    await expect(header).not.toHaveAttribute("inert", "");
  });

  test("still gives a screen reader the Plan as a list, and passes axe at every stage", async ({ page }) => {
    await openScene(page);
    for (const [progress, stage] of [[0, "scrambled"], [1.1, "the pile"], [2.3, "the rectangle"]] as const) {
      await at(page, progress, 200);
      await expectNoA11yViolations(page, `the landing page with the scene at ${stage}`);
    }
    // The spheres replace the list for the eye, and for nothing else.
    const list = page.getByRole("list", { name: /a sample plan for Computer Science/i });
    await expect(list.locator(":scope > li")).toHaveCount(8);
    await expect(list.locator("li li")).toHaveCount(48);
    await expect(page.locator(".field")).toHaveAttribute("aria-hidden", "true");
  });

  test("glides when the wheel is turned", async ({ page, isMobile }) => {
    test.skip(isMobile, "a wheel is a mouse's; touch scrolls natively");
    await openScene(page);
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 900);
    // Not there yet a moment later, and there in the end.
    await page.waitForTimeout(80);
    const early = await page.evaluate(() => scrollY);
    expect(early, "the wheel jumped the page").toBeLessThan(900);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY)), { timeout: 5000 }).toBe(900);
  });
});

test.describe("where the scene cannot run, the page is the page", () => {
  /** The static page: its layout, its list, and nothing of the scene's. */
  async function expectTheStaticPage(page: Page): Promise<void> {
    await expect(page.locator("html")).not.toHaveClass(/has-scene/);
    await expect(page.locator(".field")).toHaveCount(0);
    expect(await page.evaluate(() => "__lionsdegreeScene" in window)).toBe(false);
    // The header is part of the page again, not fixed over it.
    expect(await page.getByRole("banner").evaluate((h) => getComputedStyle(h).position)).not.toBe("fixed");
    // And the Plan is there to be seen, as the list.
    const first = page.getByRole("list", { name: /a sample plan for Computer Science/i }).getByText("MATH 140", { exact: false }).first();
    await first.scrollIntoViewIfNeeded();
    await expect(first).toBeInViewport();
    expect((await first.boundingBox())!.width, "the list is on the page but clipped away").toBeGreaterThan(20);
  }

  test("under reduced motion: no scene, the list, and a wheel that is not smoothed", async ({ page, isMobile }) => {
    const asked: string[] = [];
    page.on("request", (r) => { if (/\/assets\/scene-/.test(r.url())) asked.push(r.url()); });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForTimeout(600);
    await expectTheStaticPage(page);
    expect(asked, "the scene was downloaded for a reader who asked for no motion").toEqual([]);
    if (isMobile) return;
    await page.evaluate(() => scrollTo(0, 0));
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 700);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(700);
    // It got there in one go: there was never a frame part of the way.
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });

  test("with no WebGL: no scene, and nothing downloaded for one", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => { if (/\/assets\/scene-/.test(r.url())) asked.push(r.url()); });
    await withoutWebGL(page);
    await page.goto("/");
    await page.waitForTimeout(600);
    await expectTheStaticPage(page);
    expect(asked).toEqual([]);
  });

  test("with WebGL in software only: no scene either, and nothing downloaded for one", async ({ page }) => {
    // A browser with no GPU to draw on will still hand out a WebGL context,
    // and draw the scene at three frames a second with it (measured). The
    // page asks for a context that is refused in that case; this is a
    // browser that refuses.
    const asked: string[] = [];
    page.on("request", (r) => { if (/\/assets\/scene-/.test(r.url())) asked.push(r.url()); });
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, attributes?: { failIfMajorPerformanceCaveat?: boolean }) {
        if (/webgl/i.test(kind) && attributes?.failIfMajorPerformanceCaveat) return null;
        return (original as (...args: unknown[]) => unknown).call(this, kind, attributes);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    await page.goto("/");
    await page.waitForTimeout(600);
    await expectTheStaticPage(page);
    expect(asked).toEqual([]);
  });

  test("when the scene's chunk does not arrive: the page goes back to exactly what it was", async ({ page }) => {
    await page.route(/\/assets\/scene-/, (route) => route.abort());
    await page.goto("/");
    const able = await page.evaluate(() =>
      Boolean(document.createElement("canvas").getContext("webgl", { failIfMajorPerformanceCaveat: true })),
    );
    test.skip(!able, "this browser cannot draw WebGL on a GPU, so the scene was never going to be asked for");
    await expect(page.locator("html")).not.toHaveClass(/has-scene/, { timeout: 15_000 });
    await expectTheStaticPage(page);
  });
});
