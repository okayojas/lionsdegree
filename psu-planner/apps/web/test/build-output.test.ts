/** Assertions about the BUILT output, not the source.
 *
 * The whole reason the build has two entries is that link previewers and
 * crawlers do not run JavaScript: a marketing page rendered by React unfurls
 * as a blank card, and a shared link is how this reaches students. That
 * property only holds in `dist`, so it is checked there.
 *
 * Run `pnpm build` first; these tests fail loudly rather than skipping if
 * dist is absent, because a test that quietly passes when it checked nothing
 * is worse than no test. */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const read = (rel: string) => fs.readFileSync(path.join(dist, rel), "utf-8");
const exists = (rel: string) => fs.existsSync(path.join(dist, rel));

beforeAll(() => {
  if (!exists("index.html")) {
    throw new Error(`no build output at ${dist} — run \`pnpm --filter web build\` before this suite`);
  }
});

describe("the landing document", () => {
  it("is a real document, readable with no JavaScript", () => {
    const html = read("index.html");
    expect(html).toMatch(/<h1[^>]*>\s*LionsDegree/);
    // Its description has to be in the markup for a preview card to show it.
    expect(html).toMatch(/<meta\s+name="description"/);
  });

  it("ships none of the planner's JavaScript", () => {
    const scripts = [...read("index.html").matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts.some((s) => /\/assets\/plan-.*\.js$/.test(s))).toBe(false);
    // Whatever it does load stays tiny; the planner bundle is ~500 KB.
    const bytes = scripts
      .filter((s) => s.startsWith("/"))
      .reduce((sum, s) => sum + fs.statSync(path.join(dist, s.slice(1))).size, 0);
    expect(bytes).toBeLessThan(20 * 1024);
  });

  it("carries the unaffiliated disclaimer", () => {
    expect(read("index.html")).toMatch(/[Nn]ot affiliated with/);
  });
});

describe("the planner", () => {
  it("is built at its own path", () => {
    expect(exists("plan/index.html")).toBe(true);
    expect(read("plan/index.html")).toMatch(/src="\/assets\/plan-[^"]*\.js"/);
  });

  it("is not offered to crawlers; the landing page is the one that ranks", () => {
    expect(read("plan/index.html")).toMatch(/name="robots"\s+content="noindex"/);
  });
});

describe("the service worker", () => {
  it("lives under the planner, which caps its scope there", () => {
    // A worker cannot control paths above its own location, so emitting it at
    // /plan/sw.js makes the landing page unreachable to it by construction
    // rather than by configuration that could drift.
    expect(exists("plan/sw.js")).toBe(true);
    expect(exists("sw.js")).toBe(false);
  });

  it("does not precache the landing page it can never serve", () => {
    const sw = read("plan/sw.js");
    const manifest = sw.match(/\[\{[^\]]*\}\]/);
    expect(manifest).not.toBeNull();
    const urls: string[] = JSON.parse(
      manifest![0].replace(/url:/g, '"url":').replace(/revision:/g, '"revision":'),
    ).map((e: { url: string }) => e.url);
    expect(urls).not.toContain("index.html");
    expect(urls.filter((u) => u.includes("landing"))).toEqual([]);
    // It must still precache the planner's own shell.
    expect(urls).toContain("plan/index.html");
  });

  it("installs the planner, not the marketing page", () => {
    const m = JSON.parse(read("plan/manifest.webmanifest"));
    expect(m.start_url).toBe("/plan/");
    expect(m.scope).toBe("/plan/");
    // The near-black from two palettes ago framed an installed app wrongly.
    expect(m.theme_color).toBe("#f1ebdf");
  });
});
