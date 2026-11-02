/** What the account control says about a student's own session.
 *
 * THE BUG THIS EXISTS FOR was a single word. A student signed in with
 * Google, it worked, and the button read "✓ Syncing · name" — so they
 * asked why it was stuck. A present participle describes something in
 * progress; the signed-in state is not in progress, it is done. The
 * interface was telling them it had succeeded and they reasonably read
 * a spinner that never finished.
 *
 * Source-level, like `vocabulary.test.ts`, because the property is
 * about the words rather than the rendering.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "components", "AccountMenu.tsx"),
  "utf-8",
);

/** Only what a student reads: JSX text and quoted strings, not
 * identifiers. `syncConfigured` is a variable name nobody sees. */
const studentFacing = (): string =>
  [
    ...[...src.matchAll(/>([^<>{}]{3,})</g)].map((m) => m[1]),
    ...[...src.matchAll(/"([^"\\]{4,})"/g)].map((m) => m[1]),
  ]
    .join(" | ")
    .replace(/\s+/g, " ");

describe("the signed-in label", () => {
  it("does not describe a finished state as an ongoing one", () => {
    // "Syncing" is the whole bug. So is "Loading", "Connecting" and
    // anything else that invites a student to wait for something that
    // already happened.
    const shown = studentFacing();
    for (const inProgress of ["Syncing", "Signing in", "Connecting", "Loading"]) {
      expect(shown, `the account control says "${inProgress}", which reads as not-yet-finished`).not.toMatch(
        new RegExp(`\\b${inProgress}\\b`, "i"),
      );
    }
  });

  it("still says somewhere that the plan is synced, as a fact rather than an activity", () => {
    // Removing the word must not remove the reassurance. A student who
    // signed in for cross-device sync needs to know it is on.
    expect(studentFacing(), "nothing tells the student their plan is being kept in their account").toMatch(
      /synced|saved to (this|your) account/i,
    );
  });
});

describe("the account menu", () => {
  it("is a menu, not a single button that signs you out", () => {
    // It used to be one button whose only behaviour was a confirm()
    // dialog. There was nowhere to see which account you were in, and
    // the one affordance was destructive.
    expect(src).toMatch(/aria-haspopup="menu"[\s\S]{0,400}aria-expanded/);
    expect(src.match(/role="menuitem"/g)?.length ?? 0, "the signed-in menu has nothing in it").toBeGreaterThan(2);
  });

  it("says which account you are signed in as", () => {
    // The question that prompted all of this was "am I even signed
    // in?", asked by someone who was.
    expect(studentFacing()).toMatch(/Signed in as/i);
  });

  it("can be dismissed without choosing anything", () => {
    // A menu you can only leave by picking an item — one of which
    // signs you out — is a trap.
    expect(src, "no way to close the menu by clicking away").toMatch(/mousedown/);
    expect(src, "Escape does not close the menu").toMatch(/Escape/);
  });
});

describe("the Microsoft option", () => {
  it("is not offered as though it works", () => {
    // IT IS THE ONE A PENN STATE STUDENT REACHES FOR FIRST, and it
    // fails: the app is not approved in the university's tenant, so
    // their own address is refused with an error that reads like they
    // mistyped it. Same rule as the ChatGPT instructions on /connect/
    // — a path that looks like it works and cannot is worse than one
    // that is not offered.
    const offersAzure = /onClick=\{\(\) => void signIn\("azure"\)\}/.test(src);
    const saysSo = /aren.{0,3}t working yet|not available yet/i.test(src);
    expect(
      offersAzure && !saysSo,
      "Microsoft sign-in is offered as working, and for a PSU account it is not",
    ).toBe(false);
  });

  it("tells the student it is not their mistake, and what to do instead", () => {
    const shown = studentFacing();
    expect(shown, "no explanation of why the PSU option does not work").toMatch(/approve|not available yet/i);
    expect(shown, "no alternative offered").toMatch(/Google/);
  });

  it("is behind one flag, so turning it on is a one-line change", () => {
    // When the university approves it, nobody should have to find
    // three places and guess which copy is still true.
    expect(src).toMatch(/PSU_MICROSOFT_WORKS/);
  });
});
