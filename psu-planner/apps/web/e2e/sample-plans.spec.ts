/** Sample plans: every Program that publishes a suggested plan, a way into
 * the planner for each, and its plan Term by Term (#60, #67, #68).
 *
 * The page is a list in a document. Everything a student needs from it is
 * there with JavaScript off: the Programs, their campuses, a link each. One
 * script narrows the list as they type, which is the second part of this
 * file; another shows a Program's Template under its row, which is the
 * third.
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

/** The list of Programs: the first list in the page's main part. (An open
 * Program has lists of its own inside it, for its Terms.) */
const list = (page: Page) => page.getByRole("main").getByRole("list").first();
/** The Programs a student can see right now. */
const showing = (page: Page) => list(page).locator(":scope > li:visible");
const names = (page: Page) => showing(page).locator(":scope > p:first-of-type").allInnerTexts();

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
    // A PLACE, OR THE ADMISSION THAT THERE IS NONE. Every row is campus names
    // and nothing else: the first version of this page cut the Bulletin's
    // labels at a word and showed "their Commonwealth Campus)" as somewhere
    // a plan was for. Written out here as a student would recognise them.
    const place = /^(?:[A-Z][A-Za-z-]*(?: [A-Z][A-Za-z-]*)? Campus(?:es)?|World Campus|All campuses)$/;
    const NONE = "The Bulletin names no campus for this program";
    for (const { name, campus } of campuses) {
      if (campus === NONE) continue;
      for (const one of campus.split(" · ")) expect(one, `${name} is said to be for "${one}"`).toMatch(place);
    }
    // Nearly all name one. A list where every row fell through to the
    // admission would pass the loop above and be useless.
    expect(campuses.filter((c) => c.campus === NONE).length).toBeLessThanOrEqual(5);

    const where = (program: string) => campuses.find((c) => c.name === program)?.campus;
    expect(where("Computer Science, B.S. (Behrend)")).toBe("Erie Campus");
    // One plan with a label and one without: both campuses, not just the
    // labelled one.
    expect(where("Software Engineering, B.S.")).toBe("Erie Campus · World Campus");
    // A label with a sentence in brackets after the campus.
    expect(where("Chemistry, B.S. (Science)")).toBe("University Park Campus · Commonwealth Campuses");
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

  test("offers no box to type in and no plan to open, because nothing would answer", async ({ page }) => {
    await page.goto("/sample-plans/");
    await expect(page.getByRole("button", { name: /See term by term/ })).toHaveCount(0);
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
    // A Program whose name does not say where it is, found by where it is.
    await box.fill("software erie");
    expect(await names(page)).toEqual(["Software Engineering, B.S."]);
    // Part of a word is enough: nobody types the "Bio".
    await box.fill("behavioral health");
    const behavioral = await names(page);
    expect(behavioral.filter((name) => name.startsWith("Biobehavioral Health, B.S."))).not.toHaveLength(0);
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

  test("the narrowed page is still accessible, and says how many are left in a live region", async ({ page }) => {
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
    // The next stop is the one Program left, not one of the 382 hidden:
    // first the look at its plan, then the way into the planner.
    expect(focused.name).toBe("See term by term: Computer Science, B.S. (Behrend)");
    expect(focused.ring, "the button has no visible focus").toBe(true);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => (document.activeElement?.textContent ?? "").trim())).toBe(
      "Open in the planner: Computer Science, B.S. (Behrend)",
    );
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
    for (const button of (await list(page).getByRole("button").all()).slice(0, 5)) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
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

test.describe("seeing a Program's plan, Term by Term", () => {
  /** A request for one Program's Template file. (Not the index: the page
   * never asks for that, and one test says so.) */
  const TEMPLATE_FILE = /\/catalog\/[^/]+\/templates\/[^/]+\.json$/;
  const CS = { slug: "behrend-computer-science-bs", name: "Computer Science, B.S. (Behrend)", typed: "computer science behrend" };

  /** A Program's row, by its name. */
  const row = (page: Page, name: string) => showing(page).filter({ has: page.getByText(name, { exact: true }) });
  const see = (page: Page, name: string) => row(page, name).getByRole("button", { name: /^See term by term/ });
  /** The Terms on show in a row, in order. */
  const termNames = (page: Page, name: string) => row(page, name).getByRole("heading", { level: 3 }).allInnerTexts();

  /** Narrow to a Program and open its plan. */
  async function open(page: Page, program: { name: string; typed: string }) {
    await page.goto("/sample-plans/");
    await page.getByRole("searchbox").fill(program.typed);
    await see(page, program.name).click();
  }

  /** The Program's suggested plans as the catalog itself records them: a
   * different file from the one the page fetches, read here and not there. */
  async function recorded(request: APIRequestContext, slug: string) {
    const { latest } = (await (await request.get("/catalog/editions.json")).json()) as { latest: string };
    const program = (await (await request.get(`/catalog/${latest}/programs/majors/${slug}.json`)).json()) as {
      suggestedPlans: {
        campusLabel: string;
        // `semesters` is the catalog's own field name for a plan's Terms.
        semesters: { label: string; entries: { type: string; code?: string; label?: string; alternatives?: string[]; credits: number | null }[] }[];
      }[];
    };
    return program.suggestedPlans.filter((plan) => plan.semesters.length > 0);
  }

  /** Every line of every Term on show in a row: the Term, and the line as a
   * screen reader would get it. */
  const linesOnShow = (page: Page, name: string) =>
    row(page, name)
      .getByRole("heading", { level: 3 })
      .evaluateAll((headings) =>
        headings.map((heading) => ({
          term: (heading.textContent ?? "").trim(),
          lines: [...heading.parentElement!.querySelectorAll("ul > li")].map((li) => {
            // What is hidden from a screen reader is the eye's short form
            // of something said in full beside it.
            const heard = li.cloneNode(true) as HTMLElement;
            for (const unsaid of heard.querySelectorAll('[aria-hidden="true"]')) unsaid.remove();
            return (heard.textContent ?? "").replace(/\s+/g, " ").trim();
          }),
        })),
      );

  test("choosing a Program shows its eight Terms in order, each with its Courses and its Slots", async ({ page, request }) => {
    const [plan] = await recorded(request, CS.slug);
    await open(page, CS);
    await expect(row(page, CS.name).getByRole("heading", { level: 3 })).toHaveCount(8);
    expect(await termNames(page, CS.name)).toEqual([
      "Year 1 Fall", "Year 1 Spring", "Year 2 Fall", "Year 2 Spring", "Year 3 Fall", "Year 3 Spring", "Year 4 Fall", "Year 4 Spring",
    ]);

    // Line for line what the Bulletin's plan says, in its order.
    const shown = await linesOnShow(page, CS.name);
    expect(shown.map((term) => term.term)).toEqual(plan.semesters.map((term) => term.label));
    plan.semesters.forEach((term, at) => {
      expect(shown[at].lines, term.label).toHaveLength(term.entries.length);
      term.entries.forEach((entry, line) => {
        const text = shown[at].lines[line];
        if (entry.type === "course") expect(text.startsWith(entry.code!), `${term.label}: "${text}" should be ${entry.code}`).toBe(true);
        else expect(text.startsWith(`Open: ${entry.label}`), `${term.label}: "${text}" should be the Slot "${entry.label}"`).toBe(true);
      });
    });
    // The first Term, written out: a reader should be able to check this
    // test against the Bulletin without running it.
    expect(shown[0].lines).toEqual([
      "CMPSC 121 3 credits",
      "ENGL 15 or ENGL 30H 3 credits",
      "MATH 140 4 credits",
      "PSU 7 1 credit",
      "Open: Science Sequence Course (GN) 4 credits",
    ]);
  });

  test("a Slot is a Slot: the Bulletin's label, and no Course anywhere the Bulletin did not put one", async ({ page, request }) => {
    const [plan] = await recorded(request, CS.slug);
    await open(page, CS);
    await expect(row(page, CS.name).getByRole("heading", { level: 3 })).toHaveCount(8);
    // Said in words, before the Terms.
    await expect(row(page, CS.name).getByText("nothing has been picked for you")).toBeVisible();

    const shown = await linesOnShow(page, CS.name);
    const codeShaped = /\b[A-Z]{2,6} \d{1,3}[A-Z]?\b/g;
    plan.semesters.forEach((term, at) => {
      const named = new Set(term.entries.flatMap((entry) => (entry.type === "course" ? [entry.code!, ...(entry.alternatives ?? [])] : [])));
      // Every Course code on show in this Term is one the Bulletin's plan
      // names in this Term, and every one it names is on show.
      const onShow = new Set(shown[at].lines.flatMap((line) => line.match(codeShaped) ?? []));
      expect([...onShow].sort(), term.label).toEqual([...named].sort());
      // And a line that is a Slot has no Course code in it at all.
      for (const line of shown[at].lines.filter((text) => text.startsWith("Open: "))) {
        expect(line.match(codeShaped), `a Course was put in the Slot "${line}"`).toBeNull();
      }
    });
  });

  test("fetches that Program's file and no other, and not until it is chosen", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (request) => {
      if (/\/templates\//.test(request.url())) asked.push(new URL(request.url()).pathname);
    });
    await page.goto("/sample-plans/");
    await page.getByRole("searchbox").fill(CS.typed);
    await expect(showing(page)).toHaveCount(1);
    // Looking at the list, and narrowing it, asks for nothing: not a
    // Template, and not the index the list was built from.
    expect(asked).toEqual([]);

    await see(page, CS.name).click();
    await expect(row(page, CS.name).getByRole("heading", { level: 3 })).toHaveCount(8);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^\/catalog\/\d{4}-\d{4}\/templates\/behrend-computer-science-bs\.json$/);

    // Closing it and opening it again asks for nothing more.
    await see(page, CS.name).click();
    await expect(row(page, CS.name).getByRole("heading", { level: 3 })).toHaveCount(0);
    await see(page, CS.name).click();
    await expect(row(page, CS.name).getByRole("heading", { level: 3 })).toHaveCount(8);
    expect(asked).toHaveLength(1);
  });

  test("asks once, even when the row is closed and opened again before the file has come", async ({ page }) => {
    let asked = 0;
    let arrive: () => void = () => {};
    const held = new Promise<void>((resolve) => (arrive = resolve));
    await page.route(TEMPLATE_FILE, async (route) => {
      asked++;
      await held;
      await route.continue();
    });
    await open(page, CS);
    const here = row(page, CS.name);
    await expect(here.getByText("Loading the plan")).toBeVisible();
    // Shut, open, shut, open: an impatient student, on a slow connection.
    for (let press = 0; press < 4; press++) await see(page, CS.name).click();
    await expect(see(page, CS.name)).toHaveAttribute("aria-expanded", "true");
    arrive();
    await expect(here.getByRole("heading", { level: 3 })).toHaveCount(8);
    expect(asked).toBe(1);
    // And what came back is a plan, once: not an error over the top of it.
    await expect(here.getByRole("alert")).toHaveCount(0);
    await expect(here.getByRole("heading", { level: 2 })).toHaveCount(1);
  });

  test("says so when the plan does not arrive, shows no plan, and can try again", async ({ page }) => {
    await page.route(TEMPLATE_FILE, (route) => route.abort());
    await open(page, CS);
    const here = row(page, CS.name);
    await expect(here.getByRole("alert")).toContainText(`The plan for ${CS.name} did not load`);
    // Never an empty plan: no Term, no heading for a plan, no count of Terms.
    await expect(here.getByRole("heading")).toHaveCount(0);
    await expect(here.getByText(/\d+ terms?/)).toHaveCount(0);
    // The way into the planner is still there.
    await expect(here.getByRole("link", { name: /^Open this program in the planner/ })).toBeVisible();
    await expectNoA11yViolations(page, "/sample-plans/ with a plan that did not load");

    await page.unroute(TEMPLATE_FILE);
    // From the keyboard, because that is where it could go wrong: the
    // button pressed is replaced by what comes back, and the focus must
    // not be left on nothing at the top of the page.
    await here.getByRole("button", { name: "Try again" }).focus();
    await page.keyboard.press("Enter");
    await expect(here.getByRole("heading", { level: 3 })).toHaveCount(8);
    await expect(here.getByRole("alert")).toHaveCount(0);
    await expect(see(page, CS.name)).toBeFocused();
  });

  const UNREADABLE = "could not be read, so none is shown";
  for (const [what, body, said] of [
    ["a file with no plan in it", JSON.stringify({ program: "behrend-computer-science-bs", templates: [] }), UNREADABLE],
    ["a plan with no Terms in it", JSON.stringify({ program: "behrend-computer-science-bs", templates: [{ label: "", terms: [] }] }), UNREADABLE],
    ["another Program's file", JSON.stringify({ program: "behrend-computer-engineering-bs", templates: [{ label: "", terms: [{ label: "Year 1 Fall", entries: [] }] }] }), UNREADABLE],
    ["a line that is a Course and a Slot at once", JSON.stringify({ program: "behrend-computer-science-bs", templates: [{ label: "", terms: [{ label: "Year 1 Fall", entries: [{ course: "MATH 140", slot: "Elective" }] }] }] }), UNREADABLE],
    ["a page where a file should be", "<!doctype html><title>Not found</title>", "did not load"],
  ] as const) {
    test(`is never an empty plan: ${what} is said, in the words that are true of it`, async ({ page }) => {
      await page.route(TEMPLATE_FILE, (route) => route.fulfill({ status: 200, contentType: "application/json", body }));
      await open(page, CS);
      const here = row(page, CS.name);
      await expect(here.getByRole("alert")).toContainText(said);
      await expect(here.getByRole("heading")).toHaveCount(0);
      await expect(here.getByText(/\d+ terms?/)).toHaveCount(0);
      await expect(here.getByRole("link", { name: /^Open this program in the planner/ })).toBeVisible();
    });
  }

  test("says so when the server has no such file", async ({ page }) => {
    await page.route(TEMPLATE_FILE, (route) => route.fulfill({ status: 404, contentType: "text/html", body: "Not found" }));
    await open(page, CS);
    await expect(row(page, CS.name).getByRole("alert")).toContainText("did not load");
    await expect(row(page, CS.name).getByRole("heading")).toHaveCount(0);
  });

  test("a Program with several plans offers each by the Bulletin's name, and shows the one chosen", async ({ page, request }) => {
    const ME = { slug: "engineering-mechanical-engineering-bs", name: "Mechanical Engineering, B.S. (Engineering)", typed: "mechanical engineering" };
    const plans = await recorded(request, ME.slug);
    expect(plans.length, "this Program no longer has several plans; pick another for this test").toBeGreaterThan(1);
    await open(page, ME);
    const here = row(page, ME.name);
    const which = here.getByLabel(/^Which plan/);
    await expect(which).toBeVisible();
    expect(await which.locator("option").allInnerTexts()).toEqual(plans.map((plan) => plan.campusLabel));

    // The first is on show to begin with; choosing the last shows the last.
    const firstLines = async () => (await linesOnShow(page, ME.name))[0].lines.map((line) => line.replace(/^Open: /, ""));
    const expected = (at: number) => plans[at].semesters[0].entries.map((entry) => (entry.type === "course" ? entry.code! : entry.label!));
    (await firstLines()).forEach((line, at) => expect(line.startsWith(expected(0)[at]), line).toBe(true));
    const last = plans.length - 1;
    expect(expected(last), "the two plans start the same way, so this would prove nothing").not.toEqual(expected(0));
    // Its name is in the chooser, and in full under it: a chooser on a phone
    // cuts a long name off at the very part that tells two plans apart.
    // (Only that line has the name with what it adds up to after it.)
    await expect(here.getByText(`${plans[0].campusLabel} · ${plans[0].semesters.length} terms`)).toBeVisible();
    await which.selectOption({ index: last });
    (await firstLines()).forEach((line, at) => expect(line.startsWith(expected(last)[at]), line).toBe(true));
    await expect(here.getByText(`${plans[last].campusLabel} · ${plans[last].semesters.length} terms`)).toBeVisible();
    await expectNoA11yViolations(page, "/sample-plans/ with a Program of several plans open");
  });

  test("says so where the Bulletin's plan names a code its own catalog does not have", async ({ page }) => {
    // LA 283 is in the Bulletin's plan for this Program and not in the
    // Edition's catalog. It is shown, as what it is.
    const AFAM = { name: "African American Studies, B.A.", typed: "african american studies" };
    await open(page, AFAM);
    await expect(row(page, AFAM.name).getByRole("heading", { level: 3 }).first()).toBeVisible();
    const lines = (await linesOnShow(page, AFAM.name)).flatMap((term) => term.lines);
    const flagged = lines.filter((line) => line.startsWith("LA 283"));
    expect(flagged.length, "the plan no longer names LA 283; pick another code for this test").toBeGreaterThan(0);
    // On that line, not somewhere in its Term.
    for (const line of flagged) expect(line).toMatch(/^LA 283 not in this edition's catalog/);
    // And a Course the catalog does have carries no such flag.
    for (const line of lines.filter((text) => text.startsWith("SOC 207"))) expect(line).not.toContain("not in this edition");
  });

  test("a remark of the Bulletin's is said to be there, is not copied, and can be read in the Bulletin", async ({ page }) => {
    // One of this Program's plans has, in a Term, an instruction about an
    // exam with a web address in it. It is not a Course and not a choice.
    const EDUC = { name: "Elementary and Early Childhood Education, B.S.", typed: "elementary early childhood" };
    await open(page, EDUC);
    const here = row(page, EDUC.name);
    const which = here.getByLabel(/^Which plan/);
    // Until the plans have arrived there is no chooser, and a loop over
    // no options looks like a Program with no notes.
    await expect(which).toBeVisible();
    let notes = 0;
    for (let at = 0; at < (await which.locator("option").count()); at++) {
      await which.selectOption({ index: at });
      const lines = (await linesOnShow(page, EDUC.name)).flatMap((term) => term.lines);
      notes += lines.filter((line) => line === "A note in the Bulletin, not copied here.").length;
      // Not as a choice, and not in the Bulletin's words.
      expect(lines.filter((line) => /PECT|nesinc|https?:/.test(line))).toEqual([]);
    }
    expect(notes, "none of this Program's plans has a note any more; pick another for this test").toBeGreaterThan(0);
    // Where to read it: the Program's own page in the Bulletin.
    await expect(here.getByRole("link", { name: /^See it in the Bulletin/ })).toHaveAttribute(
      "href",
      /^https:\/\/bulletins\.psu\.edu\/undergraduate\//,
    );
  });

  test("\"Open this program in the planner\" under the Terms opens the planner with that Program chosen", async ({ page }) => {
    await open(page, CS);
    await row(page, CS.name).getByRole("link", { name: /^Open this program in the planner/ }).click();
    await expect(page).toHaveURL(/\/plan\/\?programs=behrend-computer-science-bs/);
    await expect(page.getByText(`Selected: ${CS.name}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/not in the .* bulletin/i)).toHaveCount(0);
  });

  test("opens and closes from the keyboard, and says which it is", async ({ page }) => {
    await page.goto("/sample-plans/");
    await page.getByRole("searchbox").focus();
    await page.keyboard.type(CS.typed);
    await page.keyboard.press("Tab");
    const button = see(page, CS.name);
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(row(page, CS.name).getByRole("heading", { level: 3 })).toHaveCount(8);
    // The focus has not been moved away from where the student pressed.
    await expect(button).toBeFocused();
    // Onward by Tab: the row's link, then the link under the Terms.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => (document.activeElement?.textContent ?? "").trim())).toBe(`Open this program in the planner: ${CS.name}`);
    // And shut again, with the same key.
    await button.focus();
    await page.keyboard.press("Space");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(row(page, CS.name).getByRole("heading", { level: 3 })).toHaveCount(0);
  });

  test("an open plan is readable by a screen reader, and passes axe", async ({ page }) => {
    await page.goto("/sample-plans/");
    await expect(page.locator('[aria-live="polite"]:not([role])')).toHaveText("");
    await page.getByRole("searchbox").fill(CS.typed);
    await see(page, CS.name).click();
    const here = row(page, CS.name);
    // A heading for the plan that names its Program, with the Terms under it.
    await expect(here.getByRole("heading", { level: 2, name: `The Bulletin\u2019s suggested plan for ${CS.name}` })).toBeVisible();
    await expect(here.getByRole("heading", { level: 3, name: "Year 1 Fall" })).toBeVisible();
    // How long it is and what it adds up to, on the page...
    await expect(here.getByText(/8 terms · 122 credits$/)).toBeVisible();
    // ...and said: in a live region that was in the page, empty, before
    // anything was opened. One put in already full is announced by nothing.
    const said = page.locator('[aria-live="polite"]:not([role])');
    await expect(said).toHaveText(`${CS.name}: Computer Science, B.S. at Erie Campus · 8 terms · 122 credits`);
    // Credits are short for the eye and whole for a screen reader, and the
    // whole form takes no room on the page.
    const credits = await here.getByRole("listitem").filter({ hasText: "CMPSC 121" }).last().evaluate((line) => {
      const short = line.querySelector('[aria-hidden="true"]')!;
      const whole = [...line.querySelectorAll("span")].find((span) => span.textContent === "3 credits")!;
      return { short: short.textContent, shortWidth: short.getBoundingClientRect().width, wholeWidth: whole.getBoundingClientRect().width };
    });
    expect(credits.short).toBe("3 cr");
    expect(credits.shortWidth).toBeGreaterThan(10);
    expect(credits.wholeWidth).toBeLessThanOrEqual(1);
    // The Terms are a list in order, and each Term's lines are a list.
    await expect(here.getByRole("list").first().locator(":scope > li")).toHaveCount(8);
    await expectNoA11yViolations(page, "/sample-plans/ with a plan open");
  });

  // The Programs most likely to be too wide: forty-four plans whose names run
  // long, and a plan with a web address in one of its lines.
  for (const program of [
    CS,
    { name: "Information Technology, B.S. (University College)", typed: "information technology university college" },
    { name: "Elementary and Early Childhood Education, B.S.", typed: "elementary early childhood" },
  ]) {
    for (const width of [320, 412]) {
      test(`an open plan is no wider than a ${width}px phone: ${program.name}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await open(page, program);
        const here = row(page, program.name);
        await expect(here.getByRole("heading", { level: 3 }).first()).toBeVisible();
        // Every one of its plans, where it has several: the longest name and
        // the longest line are not always in the first.
        const which = here.getByLabel(/^Which plan/);
        const plans = (await which.count()) ? await which.locator("option").count() : 1;
        for (let at = 0; at < plans; at += Math.max(1, Math.floor(plans / 6))) {
          if (plans > 1) await which.selectOption({ index: at });
          const m = await page.evaluate((screen) => ({
            innerWidth: window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            widest: [...document.querySelectorAll("main *")]
              .filter((e) => e.getClientRects().length > 0)
              .map((e) => ({ e, right: e.getBoundingClientRect().right }))
              .filter((x) => x.right > screen + 1)
              .map((x) => `<${x.e.tagName.toLowerCase()} class="${x.e.getAttribute("class") ?? ""}"> to ${Math.round(x.right)}px`)
              .slice(0, 3),
          }), width);
          expect(m.innerWidth, `plan ${at + 1} zoomed the page out: ${m.widest.join("; ")}`).toBe(width);
          expect(m.scrollWidth, `plan ${at + 1} is wider than the screen: ${m.widest.join("; ")}`).toBeLessThanOrEqual(width);
          expect(m.widest, `plan ${at + 1} runs off the right edge`).toEqual([]);
        }
      });
    }
  }
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
    // The brand and the action share a row at every width, so there is
    // always a pair to measure: no pair at all means this measured nothing.
    expect(Number.isFinite(closest), `at ${width}px no two header links share a row`).toBe(true);
    expect(closest, `at ${width}px two header links are ${closest}px apart`).toBeGreaterThanOrEqual(12);
  }
});
