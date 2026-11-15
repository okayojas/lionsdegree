/** Two plans, and the question put to the student.
 *
 * THE SITUATION. A plan is already on the account. The student lands on a
 * new device, builds a fresh plan because that is what the page offers,
 * and then signs in. It used to be settled by comparing timestamps, and
 * whichever plan lost became unreachable: still in Postgres, never read
 * again, because the sign-in read takes the newest row. Indistinguishable,
 * from the student's side, from having lost it.
 *
 * `test/plan-collision.test.ts` covers the rule. This covers the half a
 * seam test cannot: that the question reaches the screen, that both
 * answers are reachable, and that the plan not chosen is still somewhere
 * the student can get at it.
 *
 * Supabase is stubbed at the network boundary, the same way
 * `plan-conflict.spec.ts` does it and for the same reason: what is under
 * test is this app's behaviour, not Postgres's.
 */
import { test, expect, expectNoA11yViolations, SEEDED_PLAN } from "./fixtures.js";
import type { Page, Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The project this build points at. Vite bakes it into the bundle and
 * Playwright's own process never sees it, so a session has to be stored
 * under the key the client will actually look for. */
const PROJECT_REF = (() => {
  try {
    const env = fs.readFileSync(path.resolve(here, "..", ".env.local"), "utf-8");
    const url = /^VITE_SUPABASE_URL=(.+)$/m.exec(env)?.[1]?.trim() ?? "";
    return /https?:\/\/([^.]+)\./.exec(url)?.[1] ?? "";
  } catch {
    return "";
  }
})();

/** One row, and every write aimed at it. The assertions that matter are
 * about what is still there afterwards, so the stub has to hold state
 * rather than answer from a script. */
interface Account { doc: { id: string } | null; rev: number | null; writes: { method: string; id: string }[] }

async function stubAccount(page: Page, account: Account): Promise<void> {
  await page.route("**/auth/v1/**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "00000000-0000-0000-0000-000000000001",
        aud: "authenticated", role: "authenticated", email: "student@psu.edu",
      }),
    }),
  );
  await page.route("**/rest/v1/plans**", async (route: Route) => {
    const req = route.request();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (req.method() === "GET") {
      return json(200, account.doc ? [{ doc: account.doc, rev: account.rev, updated_at: (account.doc as { updatedAt?: string }).updatedAt }] : []);
    }
    const sent = (req.postDataJSON?.() ?? {}) as { id?: string; doc?: { id: string }; rev?: number };
    account.writes.push({ method: req.method(), id: sent.id ?? "?" });
    // A write aimed at the account's own row is the thing that must never
    // happen here, so it is recorded and then applied faithfully — a stub
    // that refused it would hide the bug instead of exposing it.
    if (sent.id === account.doc?.id) {
      account.doc = sent.doc ?? account.doc;
      account.rev = sent.rev ?? account.rev;
    }
    return json(req.method() === "POST" ? 201 : 200, [{ rev: sent.rev ?? 1 }]);
  });
}

/** The plan this device built, and the different one the account holds.
 * Both are real generated plans — the account's copy is adopted into the
 * store when it is chosen, and a sentinel object would simply fail to
 * render, which is not the thing under test. */
const onThisDevice = { ...(SEEDED_PLAN as Record<string, unknown>), id: "built-on-this-device" };
const inTheAccount = {
  ...(SEEDED_PLAN as Record<string, unknown>),
  id: "already-in-the-account",
  updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
};

async function openSignedIn(page: Page, dark: boolean): Promise<void> {
  const far = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  await page.addInitScript(
    ([planKey, plan, theme, authKey, session]) => {
      window.localStorage.setItem(planKey as string, plan as string);
      window.localStorage.setItem("lionsdegree-theme", theme as string);
      window.localStorage.setItem(authKey as string, session as string);
    },
    [
      "psu-planner-plan-v1",
      JSON.stringify(onThisDevice),
      dark ? "dark" : "light",
      `sb-${PROJECT_REF}-auth-token`,
      JSON.stringify({
        access_token: "test-token-not-a-real-jwt",
        token_type: "bearer",
        expires_at: far,
        expires_in: 60 * 60 * 24 * 365,
        refresh_token: "test-refresh",
        user: {
          id: "00000000-0000-0000-0000-000000000001",
          aud: "authenticated", role: "authenticated", email: "student@psu.edu",
          app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString(),
        },
      }),
    ] as const,
  );
  await page.goto("/plan/");
  await expect(page.getByRole("banner")).toBeVisible({ timeout: 30_000 });
}

const storedPlanId = (page: Page) =>
  page.evaluate(() => JSON.parse(window.localStorage.getItem("psu-planner-plan-v1") ?? "{}").id as string);

const historyIds = (page: Page) =>
  page.evaluate(() =>
    (JSON.parse(window.localStorage.getItem("psu-planner-plan-history-v1") ?? "[]") as { plan: { id: string } }[])
      .map((h) => h.plan.id),
  );

test.beforeEach(() => {
  test.skip(!PROJECT_REF, "no .env.local, so no session can be stored under the key this build reads");
});

test("asks which plan to keep instead of picking one", async ({ page, colorScheme }) => {
  const account: Account = { doc: inTheAccount as { id: string }, rev: 7, writes: [] };
  await stubAccount(page, account);
  await openSignedIn(page, colorScheme === "dark");

  const dialog = page.getByRole("dialog");
  await expect(dialog, "the two plans were resolved without asking").toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText(/on this device/i);
  await expect(dialog).toContainText(/in your account/i);
  // Both answers reachable, and each says which plan it keeps rather than
  // leaving a screen reader with two buttons called the same thing.
  await expect(dialog.getByRole("button", { name: /keep this device's plan/i })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /keep my account's plan/i })).toBeVisible();
  // And it says the other one is not being thrown away, which is the
  // sentence that makes a two-second decision survivable.
  await expect(dialog).toContainText(/kept either way/i);

  // Reachable by keyboard: a question nobody can answer without a mouse
  // is a question that answers itself.
  const device = dialog.getByRole("button", { name: /keep this device's plan/i });
  await device.focus();
  await expect(device).toBeFocused();
  await expectNoA11yViolations(page, "the choice between two plans");
});

test("keeping this device's plan does not write over the account's", async ({ page, colorScheme }) => {
  const account: Account = { doc: inTheAccount as { id: string }, rev: 7, writes: [] };
  await stubAccount(page, account);
  await openSignedIn(page, colorScheme === "dark");

  await page.getByRole("button", { name: /keep this device's plan/i }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  expect(await storedPlanId(page), "the student's own plan was swapped out anyway").toBe("built-on-this-device");

  // POLLED, AND POLLED FIRST, and both halves of that matter.
  //
  // The dialog closes before the push finishes — `keep` clears it, then
  // awaits `keepThisDevicesPlan` — so asserting the write synchronously
  // after the dialog disappears is a race. It passed locally and failed
  // twice under full-suite load, which is the only condition slow enough
  // to lose it.
  //
  // And it has to come BEFORE the "was not overwritten" check below, or
  // that check passes for the wrong reason: asserting the account's row
  // is untouched while the write is still in flight proves nothing about
  // where the write lands. Waiting for it to land first is what makes
  // the next line an assertion rather than a coin toss.
  await expect
    .poll(() => account.writes.map((w) => w.id), {
      timeout: 10_000,
      message: "the plan on this device never reached the account",
    })
    .toContain("built-on-this-device");

  // THE PROPERTY, stated the way the stub states it: no write may be
  // AIMED at the account's row. `account.doc.id` below is a weaker
  // claim — a push targeting that row while carrying this device's plan
  // would leave the id looking untouched — so both are asserted.
  //
  // HONEST NOTE ON WHAT THIS HAS BEEN PROVEN AGAINST. The obvious
  // sabotage (make `keepThisDevicesPlan` push under `c.remote.id`) does
  // NOT exercise it: that push is refused before it reaches the network,
  // because `rememberSyncedRev` has just recorded agreement at the
  // remote revision and the doctored plan no longer matches it. Instrumented,
  // the run produced exactly one write — the ordinary debounced autosave —
  // so nothing could have failed. This line is a cheap guard on the real
  // property, not a line with a demonstrated failing mutation behind it.
  expect(
    account.writes.map((w) => w.id),
    "a write was aimed at the account's own row — its plan is reachable only there",
  ).not.toContain("already-in-the-account");
  expect(account.doc?.id, "the account's plan was overwritten").toBe("already-in-the-account");
  // The one that was not chosen is reachable, not merely undestroyed: it
  // is in Plan history, which is a door the student can open.
  await expect
    .poll(() => historyIds(page), { timeout: 10_000, message: "the account's plan is nowhere a student could find it" })
    .toContain("already-in-the-account");
});

test("keeping the account's plan keeps this device's one too", async ({ page, colorScheme }) => {
  const account: Account = { doc: inTheAccount as { id: string }, rev: 7, writes: [] };
  await stubAccount(page, account);
  await openSignedIn(page, colorScheme === "dark");

  await page.getByRole("button", { name: /keep my account's plan/i }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect
    .poll(() => storedPlanId(page), { timeout: 10_000, message: "the account's plan was not adopted" })
    .toBe("already-in-the-account");
  await expect
    .poll(() => historyIds(page), { timeout: 10_000, message: "the plan this device built is nowhere a student could find it" })
    .toContain("built-on-this-device");
  // The chart is the adopted plan, not an empty screen: adopting has to
  // leave the student looking at a usable plan.
  await expect
    .poll(() => page.locator(".card .code, .lv-code").count(), { timeout: 30_000 })
    .toBeGreaterThan(5);
});

test("says nothing when the account is holding nothing", async ({ page, colorScheme }) => {
  // The common case, and it must stay silent — no dialog, and the plan on
  // this device in the account without anyone being asked anything.
  //
  // The write is NOT this test's evidence for the sign-in save: loading a
  // plan schedules an ordinary debounced push anyway, so this assertion
  // would hold either way. That the sign-in itself saves is pinned at the
  // seam, in `test/plan-collision.test.ts`, where the push can be observed
  // without a 2.5-second debounce confusing the two.
  const account: Account = { doc: null, rev: null, writes: [] };
  await stubAccount(page, account);
  await openSignedIn(page, colorScheme === "dark");

  await expect
    .poll(() => account.writes.map((w) => w.id), { timeout: 20_000, message: "signing in did not save the plan" })
    .toContain("built-on-this-device");
  await expect(page.getByRole("dialog"), "a student with one plan was asked to choose between two").toHaveCount(0);
  expect(await storedPlanId(page)).toBe("built-on-this-device");
});
