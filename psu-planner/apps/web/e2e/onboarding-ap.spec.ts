/** Setup: AP exams come first, and tick the classes they count for.
 *
 * The owner asked for three things (2026-11-16): the AP question before the
 * classes already taken; a list to choose the exam from, which fills in
 * those classes; and instructions that say plainly to select classes taken
 * or being taken now. Each is a claim about a screen, so it is held here.
 *
 * The award asserted is read from the Edition's own AP table over HTTP,
 * not typed: the table changes between bulletins.
 */
import { test, expect, expectNoA11yViolations } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";

const MAJOR = "engineering-engineering-science-bs";
const EXAM = "Chemistry";

interface Award { minScore: number; courses: string[] }

/** AP Chemistry's awards in the latest Edition: the lowest score that earns
 * Courses, what it earns, and a score that earns none. */
async function chemistry(request: APIRequestContext): Promise<{ earns: Award; nothing: number }> {
  const { latest } = (await (await request.get("/catalog/editions.json")).json()) as { latest: string };
  const table = (await (await request.get(`/catalog/${latest}/ap_credits.json`)).json()) as { exams: { exam: string; awards: Award[] }[] };
  const awards = table.exams.find((x) => x.exam === EXAM)!.awards;
  const earns = awards.find((a) => a.courses.length > 0)!;
  const nothing = awards.find((a) => a.courses.length === 0)!.minScore;
  return { earns, nothing };
}

async function setup(page: Page): Promise<void> {
  await page.goto(`/plan/?programs=${MAJOR}`);
  await expect(page.getByRole("heading", { name: /AP exams/ })).toBeVisible({ timeout: 30_000 });
  // The major's classes have arrived, so there is a list for an exam to tick.
  await expect(tick(page, "CHEM 110")).toBeVisible({ timeout: 30_000 });
}

/** The tick box for a class in the list of classes. */
const tick = (page: Page, code: string) => page.getByRole("checkbox", { name: code, exact: true });
const addExam = (page: Page) => page.getByRole("combobox", { name: /AP exam/ }).first();
const score = (page: Page) => page.getByRole("combobox", { name: `Your score on AP ${EXAM}` });

test("asks about AP exams before the classes, and says plainly which classes to select", async ({ page }) => {
  await setup(page);
  const ap = page.getByRole("heading", { name: "5 · AP exams" });
  const classes = page.getByRole("heading", { name: "6 · Select the classes you have taken or are taking now" });
  await expect(ap).toBeVisible();
  await expect(classes).toBeVisible();
  // ABOVE IT ON THE SCREEN, not merely numbered lower.
  expect((await ap.boundingBox())!.y).toBeLessThan((await classes.boundingBox())!.y);
  // The instruction names both: what is passed, and what is being taken now.
  const how = page.getByText(/Tick every class you have already passed and every class you are taking this term/);
  await expect(how).toBeVisible();
  await expect(page.getByText(/Classes your AP exams count for are ticked already/)).toBeVisible();
});

test("choosing an exam and a score ticks the classes it counts for, with no button to press", async ({ page, request }) => {
  const { earns, nothing } = await chemistry(request);
  await setup(page);
  for (const code of earns.courses) await expect(tick(page, code), `${code} is ticked before any exam is chosen`).not.toBeChecked();

  // CHOSEN FROM A LIST.
  await addExam(page).selectOption(EXAM);
  await expect(page.getByText("Choose your score.")).toBeVisible();
  // An exam with no score is worth nothing yet.
  for (const code of earns.courses) await expect(tick(page, code)).not.toBeChecked();

  // THE SCORE IS ALL IT TAKES.
  await score(page).selectOption(String(earns.minScore));
  await expect(page.getByText(`Counts as ${earns.courses.join(earns.courses.length === 2 ? " and " : ", ")}.`)).toBeVisible();
  for (const code of earns.courses) {
    await expect(tick(page, code), `${code} was not ticked by the exam that counts for it`).toBeChecked();
    // Ticked FOR them: it is unticked where it was given, not here.
    await expect(tick(page, code)).toBeDisabled();
  }
  await expect(page.getByText(`AP ${EXAM}`, { exact: true }).first()).toBeVisible();

  // A LOWER SCORE TAKES BACK what only the higher one earned.
  await score(page).selectOption(String(nothing));
  await expect(page.getByText(/earns no course credit at Penn State/)).toBeVisible();
  for (const code of earns.courses) {
    await expect(tick(page, code), `${code} stayed ticked after the score that earned it was changed`).not.toBeChecked();
    await expect(tick(page, code)).toBeEnabled();
  }

  // And removing the exam removes it.
  await score(page).selectOption(String(earns.minScore));
  await page.getByRole("button", { name: `Remove AP ${EXAM}` }).click();
  await expect(score(page)).toHaveCount(0);
  for (const code of earns.courses) await expect(tick(page, code)).not.toBeChecked();
});

test("the classes an exam counted for are done in the plan that is built", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { earns } = await chemistry(request);
  await setup(page);
  await addExam(page).selectOption(EXAM);
  await score(page).selectOption(String(earns.minScore));
  for (const code of earns.courses) await expect(tick(page, code)).toBeChecked();

  const generate = page.getByRole("button", { name: /build my flowchart/i }).first();
  await generate.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await generate.click();
  await expect.poll(
    async () => page.evaluate(() => JSON.parse(window.localStorage.getItem("psu-planner-plan-v1") ?? "null")?.completed ?? null),
    { timeout: 90_000, message: "no plan was built" },
  ).not.toBeNull();
  const built = await page.evaluate(() => JSON.parse(window.localStorage.getItem("psu-planner-plan-v1")!));
  for (const code of earns.courses) {
    expect(built.completed[code], `${code} was ticked by the exam and is not done in the plan`).toBe(true);
    const placed = built.terms.flatMap((t: { items: { code?: string }[] }) => t.items.map((i) => i.code));
    expect(placed, `${code} is done and is still on the schedule`).not.toContain(code);
  }
});

test("works from the keyboard, fits a phone, and passes axe with an exam chosen", async ({ page, request }) => {
  const { earns } = await chemistry(request);
  await setup(page);
  await addExam(page).focus();
  await addExam(page).selectOption(EXAM);
  await score(page).focus();
  await score(page).selectOption(String(earns.minScore));
  for (const code of earns.courses) await expect(tick(page, code)).toBeChecked();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "the AP rows pushed the page wider than the screen").toBeLessThanOrEqual(1);
  await expectNoA11yViolations(page, "setup, with an AP exam chosen");
});
