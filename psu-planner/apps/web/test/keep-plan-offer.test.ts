/** When the student is told their plan is only in this browser.
 *
 * THE GAP. A Plan lives in localStorage until somebody signs in, and
 * nothing in the product ever said so. Clear the browser, switch laptops,
 * open the site on a phone — the plan is gone, and its absence is the
 * first the student hears of it.
 *
 * The offer's whole job is to appear on one screen under three conditions
 * and on no other, so the conditions are what is tested here rather than
 * which component rendered. The component cannot be rendered in this
 * suite at all (no DOM), which is the other half of why the rule lives in
 * a module of its own.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The suite runs in node. Dismissal is kept in sessionStorage — the
 * deliberate choice this file exists to pin down — so it is stubbed
 * rather than mocked away, and localStorage is stubbed beside it so a
 * dismissal written to the WRONG one is visible. */
const session = new Map<string, string>();
const local = new Map<string, string>();
const storage = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, String(v)),
  removeItem: (k: string) => void m.delete(k),
  clear: () => m.clear(),
  key: (i: number) => [...m.keys()][i] ?? null,
  get length() { return m.size; },
});
Object.defineProperty(globalThis, "sessionStorage", { value: storage(session), configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: storage(local), configurable: true });

const { dismissKeepPlanOffer, keepPlanOfferDismissed, shouldOfferToKeepPlan } = await import(
  "../src/data/keepPlanOffer"
);

/** Every condition true: a student who has just built a plan, on a build
 * with sync configured, signed out, who has not waved it away. */
const AFTER_A_BUILD = { configured: true, hasPlan: true, signedIn: false, dismissed: false };

beforeEach(() => {
  session.clear();
  local.clear();
});

describe("the offer to keep a plan", () => {
  it("is made once a plan exists and nobody is signed in", () => {
    expect(
      shouldOfferToKeepPlan(AFTER_A_BUILD),
      "the student who just built a plan is never told it is only on this device",
    ).toBe(true);
  });

  it("is not made before there is a plan to keep", () => {
    // Onboarding. There is nothing to lose yet, and "keep this" names
    // nothing the student has seen.
    expect(shouldOfferToKeepPlan({ ...AFTER_A_BUILD, hasPlan: false })).toBe(false);
  });

  it("is not made to someone already signed in", () => {
    // Their plan is already being kept. A bar saying otherwise is the
    // chart carrying a message about something already true.
    expect(shouldOfferToKeepPlan({ ...AFTER_A_BUILD, signedIn: true })).toBe(false);
  });

  it("is not made at all in a build with no account to offer", () => {
    // `syncConfigured` gates every other account surface and must gate
    // this one: a self-hosted build without Supabase shows nothing new.
    expect(
      shouldOfferToKeepPlan({ ...AFTER_A_BUILD, configured: false }),
      "a self-hosted build with no Supabase offers an account it does not have",
    ).toBe(false);
  });

  it("is not made again after the student says no", () => {
    expect(shouldOfferToKeepPlan({ ...AFTER_A_BUILD, dismissed: true })).toBe(false);
  });
});

describe("saying not now", () => {
  it("is remembered for the rest of the sitting", () => {
    expect(keepPlanOfferDismissed()).toBe(false);
    dismissKeepPlanOffer();
    expect(keepPlanOfferDismissed(), "the offer comes straight back after being dismissed").toBe(true);
  });

  it("is NOT remembered permanently", () => {
    // THE DECISION THIS PINS DOWN. A student who says "not now" on their
    // first plan and comes back a week later is asking a different
    // question from one who said it ten seconds ago. sessionStorage
    // forgets when the tab closes; localStorage would answer the second
    // question for ever on the strength of the first.
    dismissKeepPlanOffer();
    expect(
      [...local.keys()],
      "the dismissal was written somewhere that outlives the session",
    ).toEqual([]);
    expect(session.size, "nothing was written to sessionStorage either").toBeGreaterThan(0);
  });

  it("degrades to offering rather than to silence when storage is unavailable", () => {
    // Private browsing, or a locked-down profile. The write cannot have
    // landed either, so there is no dismissal to honour — and an offer
    // with a "Not now" beside it is the harmless failure. The opposite
    // would silently remove the one place a student is told their plan
    // is only on this device.
    const throwing = {
      getItem() { throw new Error("storage disabled"); },
      setItem() { throw new Error("storage disabled"); },
    };
    Object.defineProperty(globalThis, "sessionStorage", { value: throwing, configurable: true });
    try {
      expect(() => dismissKeepPlanOffer()).not.toThrow();
      expect(keepPlanOfferDismissed()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "sessionStorage", { value: storage(session), configurable: true });
    }
  });
});

/** Source-level, like `account-menu.test.ts`: the claim is about which rule
 * the component obeys, and there is no DOM here to render it in. */
const src = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "components", "KeepPlanBar.tsx"),
  "utf-8",
);

describe("the bar on the chart", () => {
  it("asks the rule rather than rewriting it", () => {
    // A second copy of "configured and has a plan and signed out" inside
    // the component is a copy that stops agreeing with the one under
    // test — and the tests above would keep passing while the bar did
    // something else.
    expect(src, "the bar does not use the shared rule").toMatch(/shouldOfferToKeepPlan\(/);
    expect(src, "the bar does not pass syncConfigured as the gate").toMatch(/configured:\s*syncConfigured/);
  });

  it("names what the student gets, not the machinery", () => {
    // "Save plan" and "Create an account" describe our side of it. The
    // student does not want an account; they want the plan to still be
    // there.
    const shown = [...src.matchAll(/>([^<>{}]{8,})</g)].map((m) => m[1]).join(" | ").replace(/\s+/g, " ");
    expect(shown, "the offer never says the plan is only in this browser").toMatch(/only in this browser/i);
    expect(shown, "the offer never says what keeping it buys").toMatch(/phone/i);
  });

  it("can be refused", () => {
    // A notice with no way out is not an offer. The planner stays usable
    // without identity, and this must not be the thing that changes that.
    expect(src, "nothing dismisses the offer").toMatch(/Not now/);
    expect(src).toMatch(/dismissKeepPlanOffer\(\)/);
  });
});
