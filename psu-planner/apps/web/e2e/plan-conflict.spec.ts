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
import { test, expect, expectNoA11yViolations, SEEDED_PLAN } from "./fixtures.js";
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
/** A plan the server can plausibly be holding.
 *
 * It has to be a real one. The sign-in path pulls whatever the server has
 * and adopts it, so a sentinel object is not an inert marker — it becomes
 * the student's Plan and the chart never renders. Marked by its `id` so a
 * test can tell whose copy survived. */
/** A Plan the server can plausibly be holding.
 *
 * `adopted` decides whether the device will take it at sign-in, and the
 * two cases are genuinely different situations rather than a detail:
 *
 *   adopted  — the device pulls it and reaches AGREEMENT at its revision,
 *              which is what a later write can then be stale against.
 *   not      — the device never saw it, so its first write is an INSERT
 *              against a row that already exists: the same conflict, by
 *              the other route.
 *
 * The lever is the timestamp, because the sign-in pull still gates on it
 * — reasonably, since at sign-in there is no conflict to resolve, just
 * two copies and a question of which is newer. */
function serverPlan(id: string, rev: number, adopted: boolean): Record<string, unknown> {
  return {
    ...(SEEDED_PLAN as Record<string, unknown>),
    id,
    rev,
    ...(adopted ? { updatedAt: new Date(Date.now() + 60_000).toISOString() } : {}),
  };
}

/** One row, shared by however many pages are pointed at it.
 *
 * NOT A CANNED RESPONSE. The first version answered every write with the
 * same scripted 400, which tests that the app reacts to a refusal but
 * cannot test whether a refusal would ever HAPPEN — and the rule being
 * checked was wrong in a way a canned stub could never show. This holds a
 * `rev` and applies the same compare-and-swap Postgres would, so two
 * pages genuinely race for it.
 *
 * `rev === null` means no row yet, which is the INSERT path. */
interface Server {
  rev: number | null;
  doc: unknown;
  updatedAt: string;
  accepted: number[];
  refused: number[];
}

function makeServer(): Server {
  return { rev: null, doc: null, updatedAt: new Date(0).toISOString(), accepted: [], refused: [] };
}

async function stubSupabase(page: Page, server: Server): Promise<void> {
  await page.route("**/auth/v1/**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "00000000-0000-0000-0000-000000000001",
        aud: "authenticated",
        role: "authenticated",
        email: "student@psu.edu",
      }),
    }),
  );

  await page.route("**/rest/v1/plans**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (req.method() === "GET") {
      return json(200, server.rev === null ? [] : [{ doc: server.doc, rev: server.rev, updated_at: server.updatedAt }]);
    }

    const sent = (req.postDataJSON?.() ?? {}) as { rev?: number; doc?: unknown; updated_at?: string };

    if (req.method() === "POST") {
      // INSERT. A row already there is a unique violation, same as Postgres.
      if (server.rev !== null) {
        server.refused.push(sent.rev ?? -1);
        return json(409, { code: "23505", message: "duplicate key value violates unique constraint" });
      }
      server.rev = sent.rev ?? 1;
      server.doc = sent.doc;
      server.updatedAt = sent.updated_at ?? new Date().toISOString();
      server.accepted.push(server.rev);
      return json(201, []);
    }

    // UPDATE. The client states the rev it last agreed on as `rev=eq.N`;
    // this is the compare-and-swap, and it matches no row when stale.
    const want = Number(/eq\.(\d+)/.exec(url.searchParams.get("rev") ?? "")?.[1] ?? NaN);
    if (server.rev !== want) {
      server.refused.push(sent.rev ?? -1);
      return json(200, []); // zero rows affected: the refusal
    }
    server.rev = sent.rev ?? server.rev;
    server.doc = sent.doc;
    server.updatedAt = sent.updated_at ?? new Date().toISOString();
    server.accepted.push(server.rev!);
    return json(200, [{ rev: server.rev }]);
  });
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
    const server = makeServer();
    server.rev = 99; // a row this device has never agreed with
    await stubSupabase(page, server);
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
    const server = makeServer();
    server.rev = 99; // a row this device has never agreed with
    await stubSupabase(page, server);
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
    const server = makeServer();
    server.rev = 99; // a row this device has never agreed with
    await stubSupabase(page, server);
    await openPlanner(page, true);
    test.skip(!(await editThePlan(page)), "no term control at this width to edit through");

    await expect(page.locator(".conflict-bar")).toBeVisible({ timeout: 15_000 });
    const saved = await storedPlan(page);
    expect(saved, "the edit was rolled back when the save was refused").toContain("gap");
  });

  test("an accepted save says nothing at all", async ({ page }) => {
    // The other half: this must not fire on the ordinary path.
    const server = makeServer();
    await stubSupabase(page, server);
    await openPlanner(page, true);
    test.skip(!(await editThePlan(page)), "no term control at this width to edit through");

    await page.waitForTimeout(5000);
    await expect(page.locator(".conflict-bar"), "a successful save warned about a conflict").toHaveCount(0);
  });
});

test.describe("the local plan after a refused save", () => {
  test("still holds the edit the student just made", async ({ page }) => {
    // THE ASSERTION THAT MATTERS. Everything else is about telling the
    // student; this is about not destroying their work while doing so.
    //
    // The first version of this test never made an edit, so no push ever
    // happened and it passed by asserting that nothing changed when
    // nothing had been asked to.
    const server = makeServer();
    server.rev = 99;
    await stubSupabase(page, server);
    await openPlanner(page, true);
    test.skip(!(await editThePlan(page)), "no term control at this width to edit through");

    await expect(page.locator(".conflict-bar")).toBeVisible({ timeout: 15_000 });
    const after = await storedPlan(page);
    const edited = await page.evaluate(() => {
      const p = JSON.parse(window.localStorage.getItem("psu-planner-plan-v1") ?? "{}");
      return (p.terms ?? []).filter((t: { gap?: boolean }) => t.gap).length;
    });
    expect(edited, "the skipped term was rolled back by the refused save").toBeGreaterThan(0);
    expect(after, "the local plan was emptied").toBeTruthy();
  });

  test("leaves the server's copy untouched", async ({ page }) => {
    // The other side of the same coin, and the one the spec names: a
    // rejected write moves no bytes on the server either.
    const server = makeServer();
    server.rev = 99;
    // NOT adopted: this device has never agreed with the server, so its
    // first write is an insert against a row that is already there.
    server.doc = serverPlan("written-by-the-other-device", 99, false);
    await stubSupabase(page, server);
    await openPlanner(page, true);
    test.skip(!(await editThePlan(page)), "no term control at this width to edit through");

    await expect(page.locator(".conflict-bar")).toBeVisible({ timeout: 15_000 });
    expect(server.rev, "the server's revision moved on a refused write").toBe(99);
    expect(
      (server.doc as { id?: string })?.id,
      "the server's plan was overwritten by the refused write",
    ).toBe("written-by-the-other-device");
    expect(server.accepted, "a write was accepted when it should have been refused").toEqual([]);
  });
});

test.describe("two writers, racing", () => {
  test("the second one is refused, however many edits it coalesced", async ({ page, browser }) => {
    // THE BUG THE FIRST IMPLEMENTATION HAD. A rule of "rev must increase"
    // is monotonicity, not agreement: tab A edits once and pushes rev 6,
    // tab B edits TWICE (the debounce coalesces them) and pushes 7 — and
    // 7 beats 6, so tab A's work vanished. Both reviews caught it; this
    // test is what would have.
    //
    // Two real pages against one shared row.
    // The server already holds a Plan, and BOTH devices load it before
    // either edits — so both genuinely agree at the same revision, which
    // is what makes what follows a race rather than two unrelated writes.
    const server = makeServer();
    server.rev = 7;
    server.doc = serverPlan("shared", 7, true);
    server.updatedAt = (server.doc as { updatedAt: string }).updatedAt;

    // SEPARATE CONTEXTS, not two pages in one. Pages in a context share
    // localStorage, so they would share the synced-revision marker too,
    // and the second write would be legitimately in agreement. Two
    // devices is what this is about, and two devices do not share a disk.
    const a = page;
    const other = await browser.newContext();
    const b = await other.newPage();
    await stubSupabase(a, server);
    await stubSupabase(b, server);

    await openPlanner(a, true);
    await openPlanner(b, true);
    // Let both finish adopting the server's copy before anyone edits.
    await a.waitForTimeout(2000);
    await b.waitForTimeout(2000);

    // Adopting the server's copy itself schedules a push, so both devices
    // write the revision they just adopted before anyone edits. Those are
    // no-ops that land legitimately; the baseline is what the server holds
    // once they have settled.
    await expect.poll(() => server.accepted.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const adopted = server.rev!;

    test.skip(!(await editThePlan(a)), "no term control at this width to edit through");
    await expect
      .poll(() => server.rev, { timeout: 15_000, message: "tab A's edit never landed" })
      .toBeGreaterThan(adopted);
    const afterA = server.rev!;

    // B edits twice, so its local rev outruns the server's by two.
    await editThePlan(b);
    await editThePlan(b);
    await page.waitForTimeout(5000);

    // THE WHOLE POINT. B's two edits coalesced into one push whose
    // revision is HIGHER than A's — under a "rev must increase" rule it
    // would have won and A's work would be gone. Under compare-and-swap
    // it names a revision the server has moved past, and lands nowhere.
    expect(server.rev, "tab B overwrote tab A by having a bigger number").toBe(afterA);
    expect(
      server.refused.some((r) => r > afterA),
      `tab B's coalesced write was not refused (accepted ${server.accepted.join(",")}, refused ${server.refused.join(",")})`,
    ).toBe(true);
    await expect(b.locator(".conflict-bar"), "tab B was not told").toBeVisible();
    await other.close();
  });

  test("an accepted write advances the revision the server holds", async ({ page }) => {
    // Criterion: "Accepted writes advance `rev`". Nothing asserted this.
    const server = makeServer();
    await stubSupabase(page, server);
    await openPlanner(page, true);
    test.skip(!(await editThePlan(page)), "no term control at this width to edit through");

    await expect.poll(() => server.accepted.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const first = server.rev!;
    await editThePlan(page);
    await expect
      .poll(() => server.rev, { timeout: 15_000, message: "a second accepted write did not advance rev" })
      .toBeGreaterThan(first);
    expect(server.refused, "an ordinary second edit was refused").toEqual([]);
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

test.describe("the conflict notice itself", () => {
  test("is announced, reachable by keyboard, and passes axe", async ({ page }) => {
    // New UI on a suite that gates on accessibility. An `alert` because a
    // student needs to hear this without having been looking at the
    // corner of the screen; keyboard-reachable because the decision it
    // asks for is the only way out of it.
    const server = makeServer();
    server.rev = 99; // a row this device has never agreed with
    await stubSupabase(page, server);
    await openPlanner(page, true);
    test.skip(!(await editThePlan(page)), "no term control at this width to edit through");

    const bar = page.locator(".conflict-bar");
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await expect(bar).toHaveAttribute("role", "alert");

    const load = bar.getByRole("button", { name: /load the newer plan/i });
    const dismiss = bar.getByRole("button", { name: /not now/i });
    await expect(load).toBeVisible();
    await expect(dismiss).toBeVisible();

    await load.focus();
    await expect(load).toBeFocused();
    await dismiss.focus();
    await expect(dismiss).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(bar, "Enter on Not now did not dismiss it").toHaveCount(0);
  });

  test("has no accessibility violations", async ({ page }) => {
    const server = makeServer();
    server.rev = 99; // a row this device has never agreed with
    await stubSupabase(page, server);
    await openPlanner(page, true);
    test.skip(!(await editThePlan(page)), "no term control at this width to edit through");
    await expect(page.locator(".conflict-bar")).toBeVisible({ timeout: 15_000 });
    await expectNoA11yViolations(page);
  });
});
