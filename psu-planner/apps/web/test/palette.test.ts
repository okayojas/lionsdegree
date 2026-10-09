/** The palette, checked by measurement rather than by eye.
 *
 * Contrast is the kind of thing that looks fine to whoever picked the colour
 * and fails for someone else, so every pairing the interface actually renders
 * is computed here. The identity is deliberately MUTED (DECISIONS.md 5.2), and
 * muted palettes are exactly where contrast quietly slips. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const css = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css"),
  "utf-8",
);

/** Custom properties declared in the block that starts at `marker`. */
function tokens(marker: string): Record<string, string> {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`no block matching ${marker} in styles.css`);
  // Walk braces so a nested block (the media query) is captured whole.
  let depth = 0, i = css.indexOf("{", start), end = i;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) { end = i; break; }
  }
  const out: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const light = tokens(":root {");
const dark = tokens(':root[data-theme="dark"]');
const darkMedia = tokens("@media (prefers-color-scheme: dark)");

const HEX = /^#[0-9a-f]{6}$/i;
function lin(c: number) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Pairings the interface genuinely renders, per theme. */
const PAIRS: [string, string, string][] = [
  ["--text", "--bg", "body text on the page"],
  ["--text", "--surface", "body text on a card"],
  ["--text-muted", "--bg", "secondary text on the page"],
  ["--text-muted", "--surface", "secondary text on a card"],
  // --surface-2 is inputs and raised chrome: the side-panel tabs, the search
  // field. It was missing from this list, and the dark pair measured 4.12:1 --
  // below AA, and only caught later by axe in the browser suite. A token
  // checked against two of the three surfaces it actually sits on is a
  // partial check that reads like a complete one.
  ["--text-muted", "--surface-2", "secondary text on an input or a raised tab"],
  // Status text sits on its OWN tinted background, not on --bg. The block
  // below checks each status colour against --bg and stopped there, so the
  // pairing actually rendered -- amber on amber-tint -- went unchecked.
  ["--warning", "--warning-bg", "a warning message on its tint"],
  ["--danger", "--danger-bg", "an error message on its tint"],
  ["--success", "--success-bg", "a success message on its tint"],
  ["--primary", "--bg", "accent on the page"],
  ["--primary", "--surface", "accent on a card"],
  ["--primary-fg", "--primary", "label on an accent fill"],
  ["--accent-text", "--bg", "accent text on the page"],
  ["--text", "--primary-tint", "text on a selected row"],
  ["--text", "--surface-2", "text on an input"],
];

for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
  describe(`${name} theme`, () => {
    it.each(PAIRS)("%s on %s meets WCAG AA (%s)", (fg, bg) => {
      expect(theme[fg], `${fg} missing`).toMatch(HEX);
      expect(theme[bg], `${bg} missing`).toMatch(HEX);
      expect(contrast(theme[fg], theme[bg])).toBeGreaterThanOrEqual(4.5);
    });

    it("the focus ring is visible against the page", () => {
      // Keyboard users rely on this; 3:1 is the non-text minimum.
      expect(contrast(theme["--focus-ring"], theme["--bg"])).toBeGreaterThanOrEqual(3);
    });

    it("status colours are legible, desaturated as they are", () => {
      for (const t of ["--success", "--warning", "--danger"]) {
        expect(contrast(theme[t], theme["--bg"]), `${t} on --bg`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
}

describe("the two route lines", () => {
  it("are told apart by hue, not only by lightness", () => {
    // The hero shows two routes converging. If both read as the same colour
    // the drawing says nothing, so the second line stays green while the
    // accent is blue.
    const hue = (hex: string) => {
      const h = hex.replace("#", "");
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max === min) return 0;
      const d = max - min;
      const deg = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return ((deg * 60) % 360 + 360) % 360;
    };
    for (const theme of [light, dark]) {
      const gap = Math.abs(hue(theme["--primary"]) - hue(theme["--route-b"]));
      expect(Math.min(gap, 360 - gap)).toBeGreaterThan(40);
    }
  });
});

describe("the dark theme is declared once, in effect", () => {
  it("the media query and the explicit override agree", () => {
    // Both blocks exist so the system preference and the toggle both work.
    // They are hand-maintained duplicates, which is exactly how a palette
    // drifts apart one edit at a time.
    const drift = Object.keys(dark)
      .filter((k) => darkMedia[k] !== undefined && darkMedia[k] !== dark[k])
      .map((k) => `${k}: ${darkMedia[k]} vs ${dark[k]}`);
    expect(drift).toEqual([]);
  });
});

describe("the outgoing accent is gone", () => {
  it("no violet hue survives in colour emitted from components", () => {
    // The stylesheet is not the only place colour comes from: the canvas
    // builds route lines with hsl(). An earlier version of this test scanned
    // only styles.css and reported clean while violet edges still rendered.
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.tsx?$/.test(e.name)) files.push(f);
      }
    };
    walk(srcDir);
    const violetHues: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf-8");
      for (const m of text.matchAll(/\b(2[5-9]\d|3[0-1]\d)\b(?=[,\s\]])/g)) {
        // Only inside an array of hues or an hsl() call.
        const around = text.slice(Math.max(0, m.index! - 80), m.index! + 20);
        if (/HUES|hsl\(/.test(around)) violetHues.push(`${path.basename(f)}: ${m[0]}`);
      }
    }
    expect(violetHues).toEqual([]);
  });

  it("no violet survives anywhere in the stylesheet", () => {
    // Retuning a palette by changing --primary alone leaves the old hue in
    // hover states, tints and legacy aliases, which reads as a bug.
    const strays = [...css.matchAll(/#[0-9a-f]{6}/gi)]
      .map((m) => m[0])
      .filter((hex) => {
        const h = hex.replace("#", "");
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        // Violet: blue and red both clearly above green.
        return b > g + 25 && r > g + 15;
      });
    expect([...new Set(strays)]).toEqual([]);
  });
});
