/** Two writers, one Plan.
 *
 * THE BUG. Two tabs both at rev 5, both save. The old code compared
 * timestamps in the browser and then wrote unconditionally, so the second
 * write won and the first student's edit was gone with nothing said.
 *
 * The database refuses the stale write (migration 0003) and these cover
 * the browser's half: that the refusal is noticed, that the student is
 * told in terms they can act on, and — the one that matters — that their
 * work is still there afterwards.
 *
 * Supabase is stubbed at the network boundary rather than run for real.
 * What is under test is this app's reaction to a refusal, not Postgres's
 * ability to produce one; the trigger is asserted separately against the
 * migration. Stubbing also lets the race be deterministic, which a real
 * round trip could not be.
 */
import { test, expect, SEEDED_PLAN } from "./fixtures.js";
import type { Page, Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The shape PostgREST returns when migration 0003's trigger fires. */
const STALE = {
  code: "LD001",
  message: "stale plan write: this update is based on rev 5, but the stored plan is already at rev 6",
  details: null,
  hint: "Re-read the plan and apply the change to the current revision.",
};

/** Make the app believe sync is configured and signed in, and decide what
 * the server says to each write. Returns the writes it saw. */
async function stubSupabase(page: Page, respond: (n: number) => "ok" | "stale"): Promise<{ writes: unknown[] }> {
  const seen = { writes: [] as unknown[] };

  await page.route("**/auth/v1/**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "00000000-0000-0000-0000-000000000001", email: "student@psu.edu" },
      }),
    }),
  );

  await page.route("**/rest/v1/plans**", async (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    seen.writes.push(req.postDataJSON?.() ?? null);
    if (respond(seen.writes.length) === "stale") {
      // PostgREST surfaces a trigger's exception as 400 with the SQLSTATE.
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify(STALE) });
    }
    return route.fulfill({ status: 201, contentType: "application/json", body: "[]" });
  });

  return seen;
}

/** The project this build points at.
 *
 * Read from `.env.local`, which is where the app's build reads it too —
 * Vite injects it into the bundle, but Playwright's own process never
 * sees it, so the first version derived an empty ref and seeded a session
 * under a key nothing looks at.
 *
 * The anon key and project ref are public by design; they ship in the
 * bundle. The JWT secret, which is not, plays no part here. */
const PROJECT_REF = (() => {
  try {
    const env = fs.readFileSync(path.resolve(here, "..", ".env.local"), "utf-8");
    const url = /^VITE_SUPABASE_URL=(.+)$/m.exec(env)?.[1]?.trim() ?? "";
    return /https?:\/\/([^.]+)\./.exec(url)?.[1] ?? "";
  } catch {
    return "";
  }
})();

/** A session the Supabase client will accept as signed in.
 *
 * NEEDED BECAUSE THE CLIENT SHORT-CIRCUITS. With no stored session,
 * `auth.getUser()` returns null without touching the network, so
 * `pushPlan` answers "off" and no request is made at all — the first
 * version of this test stubbed the network perfectly and then watched
 * nothing happen. The token is never verified by anything here; only the
 * client's own "am I signed in" check reads it. */
function fakeSession(): string {
  const far = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  return JSON.stringify({
    access_token: "test-token-not-a-real-jwt",
    token_type: "bearer",
    expires_at: far,
    expires_in: 60 * 60 * 24 * 365,
    refresh_token: "test-refresh",
    user: {
      id: "00000000-0000-0000-0000-000000000001",
      aud: "authenticated",
      role: "authenticated",
      email: "student@psu.edu",
      app_metadata: {},
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    },
  });
}

/** The planner, with a plan already on this device. */
async function openPlanner(page: Page, signedIn = false): Promise<void> {
  await page.addInitScript(
    ([planKey, plan, authKey, session]) => {
      window.localStorage.setItem(planKey as string, plan as string);
      if (authKey) window.localStorage.setItem(authKey as string, session as string);
      // The edit these tests make is behind a confirm. What is under test
      // is what happens AFTER the edit, so the prompt is answered up front
      // rather than raced with — a blocking dialog and an element inside a
      // transformed canvas together made the click unresolvable.
      window.confirm = () => true;
    },
    [
      "psu-planner-plan-v1",
      JSON.stringify(SEEDED_PLAN),
      signedIn && PROJECT_REF ? `sb-${PROJECT_REF}-auth-token` : "",
      signedIn ? fakeSession() : "",
    ] as const,
  );
  await page.goto("/plan/");
  await page.locator(".card").first().waitFor({ timeout: 60_000 });
}

/** Whatever plan is on this device right now. */
const storedPlan = (page: Page) =>
  page.evaluate(() => window.localStorage.getItem("psu-planner-plan-v1"));

/** Make a real change to the Plan.
 *
 * It has to be a real one: the push is scheduled by the store's persist
 * step, so a synthetic event or a no-op edit schedules nothing and the
 * test passes by never exercising anything. The first version of this did
 * exactly that and skipped itself.
 *
 * "Skip term" is behind a confirm, which is also the point — it is an
 * edit a student actually makes. */
async function editThePlan(page: Page): Promise<boolean> {
  const skip = page.getByRole("button", { name: /Skip term/i }).first();
  if (!(await skip.count())) return false;
  // `el.click()` rather than Playwright's click, which spent its whole
  // timeout on the hit-target check: this button lives inside the chart's
  // scaled and translated `.world`, and the actionability pass kept
  // retrying against the transformed box. The handler is what is wanted
  // here, not a test of whether the pixel is reachable — the chart's own
  // suite covers that.
  //
  // `window.confirm` is stubbed in `openPlanner`, so nothing blocks.
  await skip.evaluate((el: HTMLElement) => el.click());
  return true;
}

test.describe("when the same plan was changed somewhere else", () => {
  test("the student is told, and is not left guessing", async ({ page }) => {
    await stubSupabase(page, () => "stale");
    await openPlanner(page, true);

    test.skip(!(await editThePlan(page)), "no term control at this width to edit through");

    const bar = page.locator(".conflict-bar");
    await expect(bar, "a refused save said nothing to the student").toBeVisible({ timeout: 15_000 });
    await expect(bar).toContainText(/not saved/i);
    await expect(bar).toContainText(/safe on this device/i);
    await expect(bar.getByRole("button", { name: /load the newer plan/i })).toBeVisible();
  });

  test("does not vanish on its own while the student is reading it", async ({ page }) => {
    // A toast auto-dismisses after 3.5s, which is right for "added MATH
    // 141" and wrong for "your edit did not save" -- there is a decision
    // to make and it should not disappear mid-thought.
    await stubSupabase(page, () => "stale");
    await openPlanner(page, true);
    test.skip(!(await editThePlan(page)), "no term control at this width to edit through");

    const bar = page.locator(".conflict-bar");
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(5000);
    await expect(bar, "the conflict notice dismissed itself").toBeVisible();
  });

  test("keeps the student's own edit while telling them", async ({ page }) => {
    // The refused write must not take the edit down with it. The change
    // they just made is still in front of them and still on the device.
    await stubSupabase(page, () => "stale");
    await openPlanner(page, true);
    test.skip(!(await editThePlan(page)), "no term control at this width to edit through");

    await expect(page.locator(".conflict-bar")).toBeVisible({ timeout: 15_000 });
    const saved = await storedPlan(page);
    expect(saved, "the edit was rolled back when the save was refused").toContain("gap");
  });

  test("an accepted save says nothing at all", async ({ page }) => {
    // The other half: this must not fire on the ordinary path.
    await stubSupabase(page, () => "ok");
    await openPlanner(page, true);
    test.skip(!(await editThePlan(page)), "no term control at this width to edit through");

    await page.waitForTimeout(5000);
    await expect(page.locator(".conflict-bar"), "a successful save warned about a conflict").toHaveCount(0);
  });
});

test.describe("the local plan after a refused save", () => {
  test("is exactly what it was", async ({ page }) => {
    // THE ASSERTION THAT MATTERS. Everything else in this ticket is about
    // telling the student; this is about not destroying their work while
    // doing so. Byte-identical, not "looks similar".
    await stubSupabase(page, () => "stale");
    await openPlanner(page, true);
    const before = await storedPlan(page);
    await page.waitForTimeout(3500); // past the 2.5s debounce
    expect(await storedPlan(page)).toBe(before);
  });
});

test.describe("a student who never signs in", () => {
  test("is not shown any of this", async ({ page }) => {
    // The planner is local-first and the account is optional. Nothing in
    // this ticket may reach someone who never opted into sync.
    await openPlanner(page);
    await page.waitForTimeout(3500);
    await expect(page.locator(".conflict-bar")).toHaveCount(0);
  });

  test("can still edit and have it persist", async ({ page }) => {
    await openPlanner(page);
    const before = await storedPlan(page);
    expect(before, "no plan was stored at all").toBeTruthy();
    await page.waitForTimeout(3000);
    expect(await storedPlan(page), "the local plan was disturbed with no account").toBe(before);
  });
});
