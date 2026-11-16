/** The pages outside the planner share one header and one surface (#61).
 *
 * The browser suite (e2e/site-pages.spec.ts) checks what a visitor sees. This
 * checks the things that are only visible in the source: that there is one
 * header and not a copy of it per page, that the two marks are each still
 * the file their job needs, and that every page is findable as itself.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { HEADER_PAGES as PAGES, SITE_HEADER_SLOT, pageName, siteHeader } from "../src/site/header.js";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => fs.readFileSync(path.join(web, rel), "utf-8");

/** "/connect/" -> "connect/index.html", "/" -> "index.html" */
const fileOf = (page: string) => (page === "/" ? "index.html" : `${pageName(page)}/index.html`);
const FILES = PAGES.map(fileOf);

describe("the shared header", () => {
  it("is the planner's wordmark, from the planner's markup", () => {
    // One word in the markup: `<b>` colours half of it without splitting it,
    // which is what keeps it "LionsDegree" to a screen reader and to
    // find-in-page. App.tsx carries the same run.
    expect(siteHeader("/")).toContain("<b>Lions</b>Degree");
    expect(source("src/App.tsx")).toContain("<b>Lions</b>Degree");
  });

  it("marks the page it is on, and no other", () => {
    expect(siteHeader("/connect/")).toMatch(/href="\/connect\/" aria-current="page"/);
    expect(siteHeader("/connect/").match(/aria-current/g)).toHaveLength(1);
    expect(siteHeader("/privacy/")).not.toContain("aria-current");
  });

  it.each(PAGES)("%s gets it from the one place, exactly once", (page) => {
    // Two ways in, and a page uses one of them. A generated document has
    // the header written into it by the generator; a hand-written one
    // leaves the slot and the build fills it. What no page may have is a
    // header typed into it by hand, because that is a copy.
    const html = source(fileOf(page));
    const generated = html.includes(siteHeader(page)) ? 1 : 0;
    const slotted = html.split(SITE_HEADER_SLOT).length - 1;
    expect(generated + slotted, "a page gets the header one way: generated, or one slot").toBe(1);
    expect(html.match(/class="brand"/g) ?? [], "a header typed into the page by hand").toHaveLength(generated);
  });

  it.each(FILES)("%s is pinned to the light theme", (file) => {
    // Not merely "no longer dark": with no theme named, the stylesheet
    // follows the system, and these pages have no dark version to follow it
    // into.
    expect(source(file)).toMatch(/<html lang="en" data-theme="light">/);
    expect(source(file)).toMatch(/<meta name="theme-color" content="#f1ebdf" \/>/);
  });
});

describe("a page of its own", () => {
  /** Every document the site serves, the landing page and the planner
   * included: a title or a description shared between two of them is one
   * search result standing in for both. */
  const DOCUMENTS = ["plan/index.html", ...FILES];
  const head = (file: string) => {
    const html = source(file);
    return {
      title: /<title>([^<]+)<\/title>/.exec(html)?.[1].trim(),
      description: /<meta\s+name="description"\s+content="([^"]+)"/.exec(html)?.[1].trim(),
      canonical: /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1],
    };
  };

  it.each(FILES)("%s has a title, a description and its own address", (file) => {
    const seen = head(file);
    expect(seen.title, "no title").toMatch(/LionsDegree/);
    expect(seen.description?.length ?? 0, "no description for a preview card to show").toBeGreaterThan(40);
    expect(seen.canonical).toBe(`%SITE_URL%/${file.replace(/index\.html$/, "")}`);
  });

  it("shares neither with any other page", () => {
    const heads = DOCUMENTS.map(head);
    const titles = heads.map((h) => h.title);
    const descriptions = heads.map((h) => h.description).filter(Boolean);
    expect(new Set(titles).size, `two pages share a title: ${titles.join(" | ")}`).toBe(titles.length);
    expect(new Set(descriptions).size, "two pages share a description").toBe(descriptions.length);
  });

  it("the discovery prompt is written down once, on Connect your AI", () => {
    // It was on the landing page and is on the Connect page (#63). Two copies
    // is one that gets reworded and one that does not, and a student pastes
    // whichever they happened to find.
    //
    // Searched: the source of every document the site serves, and everything
    // under src/ that could write text into one. Whitespace is flattened
    // first, so a copy re-wrapped across lines is still a copy. Two phrases,
    // so that rewording one end of it does not hide it. This is the source,
    // not the browser, because "nowhere else" is a claim about pages nobody
    // thought to open.
    const PHRASES = ["Use LionsDegree to find programs", "minors and certificates that share credits with it"];
    const flat = (file: string) => source(file).replace(/\s+/g, " ");
    const written = (fs.readdirSync(path.join(web, "src"), { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx|css|html|json|md)$/.test(f))
      .map((f) => `src/${f.replaceAll("\\", "/")}`);
    for (const phrase of PHRASES) {
      const holders = [...DOCUMENTS, ...written].filter((file) => flat(file).includes(phrase));
      expect(holders, `"${phrase}"`).toEqual(["connect/index.html"]);
      expect(flat("connect/index.html").split(phrase), "it is on the Connect page twice").toHaveLength(2);
    }
  });
});

describe("the two marks", () => {
  const PAPER = [241, 235, 223];
  const fromPaper = (px: Buffer, i: number) =>
    Math.hypot(px[i] - PAPER[0], px[i + 1] - PAPER[1], px[i + 2] - PAPER[2]);

  it("the header's mark has no paper left in it", async () => {
    const { data, info } = await sharp(path.join(web, "public", "mark-clear.png"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    let clear = 0, solid = 0, paperLeft = 0;
    for (let p = 0; p < n; p++) {
      const a = data[p * 4 + 3];
      if (a === 0) clear++;
      if (a === 255) solid++;
      // A pixel that still shows and is still paper-coloured is the box, or
      // the pale halo an edge leaves when it is faded instead of unmixed.
      if (a > 0 && fromPaper(data, p * 4) < 24) paperLeft++;
    }
    // Measured on the file as shipped: 30% clear, 60% solid, and the rest
    // is the soft edge between them. The floors sit well under both, since
    // the point is "the cut happened and the ink survived it", not the
    // exact share.
    expect(clear / n, "nothing was cut out").toBeGreaterThan(0.2);
    expect(solid / n, "the ink went with the paper").toBeGreaterThan(0.5);
    expect(paperLeft, "paper-coloured pixels are still visible in the mark").toBe(0);
  });

  it("the header states the size the file actually is", async () => {
    // The <img> reserves its box from these two numbers before the file
    // arrives. Wrong ones mean the header jumps when it does, or the mark is
    // drawn squashed.
    const meta = await sharp(path.join(web, "public", "mark-clear.png")).metadata();
    expect(siteHeader("/")).toContain(`src="/mark-clear.png" width="${meta.width}" height="${meta.height}"`);
  });

  it("the opaque mark is untouched, because a card needs a rectangle", async () => {
    const mark = path.join(web, "public", "mark.png");
    const meta = await sharp(mark).metadata();
    expect(meta.hasAlpha, "mark.png has gained an alpha channel").toBe(false);
    const { data } = await sharp(mark).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]], "mark.png no longer sits on the app's paper").toEqual(PAPER);
  });

  it("social cards and icons never point at the transparent one", () => {
    // A previewer composites onto whatever colour it likes; a transparent
    // mark on a dark chat bubble is a navy shape on near-black.
    for (const file of [...FILES, "plan/index.html"]) {
      const meta = [...source(file).matchAll(/<(?:meta|link)\b[^>]*>/g)].map((m) => m[0]);
      expect(meta.filter((t) => t.includes("mark-clear")), `${file} uses the transparent mark in its <head>`).toEqual([]);
    }
    expect(source("index.html")).toMatch(/property="og:image" content="%SITE_URL%\/og\.png"/);
  });
});

describe("the content security policy", () => {
  it("is the one the privacy policy was written against", () => {
    // Adding a display face is the classic moment a font host gets
    // allowlisted. Raleway is served from here, so this line does not move.
    const csp = /^\s*Content-Security-Policy: (.+)$/m.exec(source("public/_headers"))?.[1];
    expect(csp).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "font-src 'self'; connect-src 'self' https://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; " +
        "form-action 'self'; object-src 'none'; upgrade-insecure-requests",
    );
  });
});
