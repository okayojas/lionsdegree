/** Every custom property a stylesheet uses must exist.
 *
 * This is a silent failure, which is why it needs a test. A `var()` naming a
 * property that was never defined makes the WHOLE declaration invalid at
 * computed-value time, and the browser falls back to the initial value with
 * no console warning and no visual error — the rule simply does not apply.
 *
 * It cost real time: the landing page used `--sp-5` and `--sp-7`, which look
 * plausible beside `--sp-4` and `--sp-6` but do not exist. The app's spacing
 * scale is 4/8/12/16/24/32 and deliberately skips those steps. The symptom
 * was a logo that would not centre, because `margin: 0 auto var(--sp-5)` was
 * being thrown away entirely — including the `auto`.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const sheets = fs
  .readdirSync(src)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ name: f, text: fs.readFileSync(path.join(src, f), "utf-8") }));

/** Properties DEFINED anywhere, since the sheets import one another. */
const defined = new Set(
  sheets.flatMap(({ text }) => [...text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])),
);

/** Set from markup rather than CSS: the route stops carry `style="--i:0"` so
 * each station can stagger its own reveal. Legitimately absent from any
 * stylesheet, so it is named here rather than silently tolerated. */
const SET_INLINE = new Set(["--i"]);

describe("custom properties", () => {
  it("found stylesheets to check", () => {
    // A wrong directory here would make the whole suite vacuously green.
    expect(sheets.map((s) => s.name)).toContain("styles.css");
    expect(sheets.map((s) => s.name)).toContain("landing.css");
    expect(defined.size, "no custom properties were parsed").toBeGreaterThan(30);
  });

  it.each(sheets.map((s) => [s.name, s.text] as const))("%s references none that are undefined", (_name, text) => {
    const used = new Set([...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    const missing = [...used].filter((v) => !defined.has(v) && !SET_INLINE.has(v)).sort();
    expect(
      missing,
      `undefined custom properties — every declaration using one is silently discarded`,
    ).toEqual([]);
  });

  it("would catch a typo", () => {
    // Mutation check: the assertion above is only worth its lines if it fires.
    const pretend = "a { margin: 0 auto var(--sp-5); }";
    const used = [...pretend.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
    expect(used.filter((v) => !defined.has(v))).toEqual(["--sp-5"]);
  });
});
