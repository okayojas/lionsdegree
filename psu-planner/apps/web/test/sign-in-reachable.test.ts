/** A returning student can find their way back to a saved plan.
 *
 * THE GAP. The account control lived only in the planner's toolbar, and
 * that toolbar renders only once a plan exists ON THIS DEVICE. So the
 * student this feature is for — somebody who built a plan on their
 * laptop and opened the site on their phone — got the onboarding form
 * with no sign-in anywhere on the page. The one control that would have
 * returned their plan was the one the screen did not offer.
 *
 * The landing page could not offer it either: it ships no Supabase
 * client, so its menu links into the planner with `?signin=1` rather
 * than growing a second auth implementation that would drift from the
 * first.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wantsSignIn } from "../src/data/deepLink";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf-8");

describe("the landing page offers a way in", () => {
  it("has a sign-in item in its menu", () => {
    const html = read("index.html");
    const menu = html.slice(html.indexOf('<div class="menu"'), html.indexOf("</nav>"));
    expect(menu, "the landing menu has no sign-in link, so a returning student has no way back").toMatch(
      /class="menu-signin"/,
    );
  });

  it("points it at the planner, carrying the intent", () => {
    const html = read("index.html");
    const href = /<a class="menu-signin" href="([^"]+)"/.exec(html)?.[1];
    expect(href, "the sign-in link has no href").toBeTruthy();
    expect(href!, "the sign-in link does not reach the planner").toMatch(/^\/plan\//);
    expect(
      wantsSignIn(href!.slice(href!.indexOf("?"))),
      `the planner will not read "${href}" as a request to sign in`,
    ).toBe(true);
  });

  it("does NOT pull an auth client into the marketing page", () => {
    // The whole reason this is a link. Two places that know how to sign a
    // student in is one place that silently stops matching the other.
    //
    // COMMENTS STRIPPED FIRST. The claim is that no auth client is
    // LOADED, not that the word never appears — the comment explaining
    // this very decision mentions Supabase by name, and the first
    // version of this test failed on it.
    const html = read("index.html").replace(/<!--[\s\S]*?-->/g, "");
    expect(html, "the landing page now loads an auth client of its own").not.toMatch(/supabase/i);
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts.length, "the landing page loads no scripts at all, so this check is vacuous").toBeGreaterThan(0);
    for (const s of scripts) {
      expect(s, `${s} is not one of the landing page's own small modules`).toMatch(/^\/src\/[a-z]+\.ts$/);
    }
  });

  it("keeps it quieter than the call to action everyone else came for", () => {
    // Findable, not competing. Signing in is what a RETURNING student
    // wants; "Open the planner" is what the rest of the page is for.
    const css = read("src/landing.css");
    const rule = css.slice(css.indexOf(".menu .menu-signin {"));
    expect(rule.slice(0, 200), "the sign-in link is not sized below the menu's other items").toMatch(/font-size:\s*clamp\(1rem/);
  });
});

describe("the planner reads the request", () => {
  it("opens the sign-in menu for the link the landing page writes", () => {
    expect(wantsSignIn("?signin=1")).toBe(true);
  });

  it("accepts the bare form a hand-written link takes", () => {
    // `?signin` with no value is what somebody types. Refusing it would
    // make a working-looking URL silently do nothing.
    expect(wantsSignIn("?signin")).toBe(true);
    expect(wantsSignIn("?signin=")).toBe(true);
  });

  it("leaves an ordinary visit alone", () => {
    // The common case by far. A student opening the planner normally must
    // not be shown an auth menu they did not ask for.
    expect(wantsSignIn(""), "a plain visit was treated as a sign-in request").toBe(false);
    expect(wantsSignIn("?programs=eberly-science-mathematics-minor")).toBe(false);
  });

  it("honours an explicit no", () => {
    expect(wantsSignIn("?signin=0")).toBe(false);
    expect(wantsSignIn("?signin=false")).toBe(false);
  });

  it("still works alongside a program deep link", () => {
    // An assistant hands over programs; the student also wants their
    // account. Neither should cancel the other.
    expect(wantsSignIn("?programs=a+b&signin=1")).toBe(true);
  });
});

describe("the account control is rendered before a plan exists", () => {
  it("sits above onboarding, not only in the toolbar", () => {
    // Asserted against the source because the alternative is a render
    // test of a component whose whole job is to appear on a screen that
    // has no plan — the condition the bug lived in.
    const app = read("src/App.tsx");
    const beforePlan = app.slice(0, app.indexOf("if (!plan)") + 600);
    expect(beforePlan, "nothing renders the account control on the onboarding screen").toMatch(
      /onboard-account[\s\S]*<AccountMenu/,
    );
    expect(beforePlan, "the onboarding account control ignores the sign-in request").toMatch(/openOnMount=\{wantsSignIn/);
  });

  it("stays reachable through onboarding's full height", () => {
    // Onboarding runs to ~3,500px. A control that scrolls away is one a
    // student has to scroll back up to find, at the moment they realise
    // they already have a plan.
    const css = read("src/styles.css");
    const rule = css.slice(css.indexOf(".onboard-account {"), css.indexOf(".onboard-account {") + 260);
    expect(rule, "the onboarding account control scrolls out of reach").toMatch(/position:\s*sticky/);
  });
});
