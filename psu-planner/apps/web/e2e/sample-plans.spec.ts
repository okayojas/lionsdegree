/** Sample plans: every Program that publishes a suggested plan, and a way
 * into the planner for each (#60, #67).
 *
 * The page is a list in a document. Everything a student needs from it is
 * there with JavaScript off: the Programs, their campuses, a link each. The
 * one script narrows the list as they type, and that is the second half of
 * this file.
 *
 * What is NOT repeated here: the cream surface, the header, the keyboard
 * route through the header, the phone widths and the accessibility scan of
 * the page as it loads. site-pages.spec.ts holds every page in the header's
 * list to those, and this page is in that list.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, expectNoA11yViolations } from "./fixtures";

/** What the catalog itself says, asked of the catalog and not of the page:
 * which Edition is the latest, and which of its Programs the pipeline
 * flagged as having a suggested plan. The page's list was written from a
 * different file (the Template index), so the two agreeing means something. */
async function theEdition(request: APIRequestContext) {
  const { latest } = (await (await request.get("/catalog/editions.json")).json()) as { latest: string };
  const programs = (await (await request.get(`/catalog/${latest}/programs_index.json`)).json()) as {
    slug: string;
    name: string;
    hasPlans?: boolean;
  }[];
  const [from, to] = latest.split("-");
  return {
    /** As a student reads it: "2026–27". */
    label: `${from}–${to.slice(2)}`,
    withPlans: programs.filter((p) => p.hasPlans),
    known: new Set(programs.map((p) => p.slug)),
  };
}

const list = (page: Page) => page.getByRole("main").getByRole("list");
/** The Programs a student can see right now. */
const showing = (page: Page) => list(page).getByRole("listitem");
const names = (page: Page) => showing(page).locator("p:first-of-type").allInnerTexts();

test.describe("with JavaScript off", () => {
  test.use({ javaScriptEnabled: false });

  test("lists every Program that has a suggested plan, and no other", async ({ page, request }) => {
    const edition = await theEdition(request);
    await page.goto("/sample-plans/");
    await expect(page.getByRole("heading", { level: 1, name: "Sample plans" })).toBeVisible();

    const listed = await showing(page).evaluateAll((items) =>
      items.map((li) => ({
        name: li.querySelector("p")?.textContent?.trim() ?? "",
        href: li.querySelector("a")?.getAttribute("href") ?? "",
      })),
    );
    expect(listed.length, "the list is empty").toBeGreaterThan(300);
    expect(listed.map((p) => p.name).sort()).toEqual(edition.withPlans.map((p) => p.name).sort());
    // Each one's way in is the planner's own Program link.
    expect(listed.map((p) => p.href).sort()).toEqual(edition.withPlans.map((p) => `/plan/?programs=${p.slug}`).sort());
    // And none of them opens a Program this Edition does not have: the
    // planner would answer that link with an error.
    for (const { href, name } of listed) {
      expect(edition.known.has(new URL(href, "http://x").searchParams.get("programs") ?? ""), `${name} is not in the Edition`).toBe(true);
    }
    // The page says how many there are, and it is how many there are.
    await expect(page.getByRole("status")).toHaveText(`${listed.length} programs`);
    await expect(page.getByRole("main")).toContainText(`${listed.length} Penn State programs publish a suggested plan`);
  });

  test("says where each Program's plans are for", async ({ page }) => {
    await page.goto("/sample-plans/");
    const campuses = await showing(page).evaluateAll((items) =>
      items.map((li) => ({
        name: li.querySelector("p")?.textContent?.trim() ?? "",
        campus: li.querySelectorAll("p")[1]?.textContent?.trim() ?? "",
      })),
    );
    for (const { name, campus } of campuses) expect(campus, `${name} says nothing about where`).not.toBe("");
    // Most name a campus. A list where every one fell through to "the
    // Bulletin names none" would pass the line above and be useless.
    const named = campuses.filter((c) => /Campus/.test(c.campus));
    expect(named.length / campuses.length).toBeGreaterThan(0.9);
    const erie = campuses.find((c) => c.name === "Computer Science, B.S. (Behrend)");
    expect(erie?.campus).toBe("Erie Campus");
  });

  test("names the Edition, and says a plan here is a suggestion before it shows one", async ({ page, request }) => {
    const edition = await theEdition(request);
    await page.goto("/sample-plans/");
    const main = page.getByRole("main");
    await expect(main.getByText(`The ${edition.label} Bulletin`)).toBeVisible();
    const caveat = main.getByText("A suggestion, not your requirements.");
    await expect(caveat).toBeVisible();
    await expect(main).toContainText(/What you have to take\s+depends on\s+when you entered your major/);
    // Said BEFORE the list. Under 383 rows it would never be read.
    const caveatBottom = await caveat.evaluate((el) => el.getBoundingClientRect().bottom);
    const listTop = await list(page).evaluate((el) => el.getBoundingClientRect().top);
    expect(caveatBottom).toBeLessThan(listTop);
  });

  test("offers no box to type in, because nothing would answer it", async ({ page }) => {
    await page.goto("/sample-plans/");
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    await expect(page.getByLabel("Find your program")).toBeHidden();
  });

  test("names the Program in every link, so a list of links can be told apart", async ({ page }) => {
    await page.goto("/sample-plans/");
    const linkNames = await list(page).getByRole("link").evaluateAll((links) => links.map((a) => (a.textContent ?? "").trim()));
    expect(new Set(linkNames).size, "two links read the same").toBe(linkNames.length);
    // As it is SPOKEN, which is the accessible name and not the text: the
    // Program's name is out of sight but in the link. (A browser may put a
    // space before the colon, where the hidden part begins.)
    await expect(
      list(page).getByRole("link", { name: /^Open in the planner ?: Computer Science, B\.S\. \(Behrend\)$/ }),
    ).toBeVisible();
  });
});

test.describe("finding a Program", () => {
  test("typing narrows the list to the Programs it names", async ({ page }) => {
    await page.goto("/sample-plans/");
    const box = page.getByRole("searchbox", { name: "Find your program" });
    await expect(box).toBeVisible();
    const all = await showing(page).count();

    await box.fill("computer science");
    const found = await names(page);
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(all);
    for (const name of found) expect(name).toMatch(/computer/i);
    for (const name of found) expect(name).toMatch(/science/i);
    await expect(page.getByRole("status")).toHaveText(`${found.length} of ${all} programs match`);

    // Taking it back out brings them all back.
    await box.fill("");
    await expect(showing(page)).toHaveCount(all);
    await expect(page.getByRole("status")).toHaveText(`${all} programs`);
  });

  test("finds by campus, in any order, as it is typed", async ({ page }) => {
    await page.goto("/sample-plans/");
    const box = page.getByRole("searchbox");
    await box.fill("erie comp sci bs");
    await expect(showing(page)).toHaveCount(1);
    expect(await names(page)).toEqual(["Computer Science, B.S. (Behrend)"]);
    // Letter by letter, as a person does it: the list follows each one.
    await box.fill("");
    await box.pressSequentially("comp");
    const afterFour = await showing(page).count();
    await box.pressSequentially("uter eng");
    const afterMore = await showing(page).count();
    expect(afterMore).toBeGreaterThan(0);
    expect(afterMore).toBeLessThan(afterFour);
  });

  test("says so when nothing matches, and how to get somewhere", async ({ page }) => {
    await page.goto("/sample-plans/");
    await page.getByRole("searchbox").fill("underwater basket weaving");
    await expect(showing(page)).toHaveCount(0);
    const status = page.getByRole("status");
    await expect(status).toContainText("No program matches “underwater basket weaving”");
    await expect(status).toContainText("Try fewer letters");
    await expectNoA11yViolations(page, "/sample-plans/ with nothing found");
  });

  test("the narrowed page is still accessible, and the count is announced", async ({ page }) => {
    await page.goto("/sample-plans/");
    const status = page.getByRole("status");
    // Polite, and there from the start: a live region added at the moment it
    // has something to say is not announced.
    await expect(status).toHaveAttribute("aria-live", "polite");
    await page.getByRole("searchbox").fill("nursing");
    await expect(status).toContainText(/^\d+ of \d+ programs match$/);
    await expectNoA11yViolations(page, "/sample-plans/ narrowed");
  });

  test("works from the keyboard: type, tab to the Program, open it", async ({ page }) => {
    await page.goto("/sample-plans/");
    const box = page.getByRole("searchbox");
    await box.focus();
    await page.keyboard.type("computer science behrend");
    await expect(showing(page)).toHaveCount(1);
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      return {
        name: (el.textContent ?? "").trim(),
        ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
      };
    });
    // The next stop is the one Program left, not one of the 382 hidden.
    expect(focused.name).toBe("Open in the planner: Computer Science, B.S. (Behrend)");
    expect(focused.ring, "the link has no visible focus").toBe(true);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/plan\//);
  });

  test("the box and the links are sized for a thumb", async ({ page, isMobile }) => {
    test.skip(!isMobile, "a property of touch, measured on the phone projects");
    await page.goto("/sample-plans/");
    const box = page.getByRole("searchbox");
    // Under 16px, iOS zooms the page in on focus and leaves it there.
    expect(await box.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for (const link of (await list(page).getByRole("link").all()).slice(0, 5)) {
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test("\"Open in the planner\" opens the planner with that Program chosen", async ({ page }) => {
  await page.goto("/sample-plans/");
  await page.getByRole("searchbox").fill("computer science behrend");
  await list(page).getByRole("link", { name: /^Open in the planner/ }).click();

  await expect(page).toHaveURL(/\/plan\//);
  await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
  // Chosen, where the student can see it, and nothing generated yet: the
  // planner asks before it builds anything.
  await expect(page.getByText("Selected: Computer Science, B.S. (Behrend)")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /build my flowchart/i }).first()).toBeVisible();
  // The planner's own complaint about a Program it does not know.
  await expect(page.getByText(/not in the .* bulletin/i)).toHaveCount(0);
});

test("the header's links never run into each other, at any width between phone and desktop", async ({ page }) => {
  // Sample plans made it four links. Between the width where they wrap under
  // the brand and the width where there is room to spare is where a fourth
  // link gets pushed into the wordmark or the button.
  for (const width of [390, 600, 768, 820, 880, 896, 912, 960, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/sample-plans/");
    const closest = await page.getByRole("banner").getByRole("link").evaluateAll((links) => {
      const boxes = links.map((a) => a.getBoundingClientRect());
      let gap = Infinity;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const sameRow = boxes[i].top < boxes[j].bottom && boxes[j].top < boxes[i].bottom;
          if (sameRow) gap = Math.min(gap, Math.max(boxes[j].left - boxes[i].right, boxes[i].left - boxes[j].right));
        }
      }
      return gap;
    });
    expect(closest, `at ${width}px two header links are ${closest}px apart`).toBeGreaterThanOrEqual(12);
  }
});
