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
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { requirementCoverage } from "@psu-planner/engine";
import { latestEdition, loadPrograms } from "../scripts/catalog-programs.mjs";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const read = (rel: string) => fs.readFileSync(path.join(dist, rel), "utf-8");
const exists = (rel: string) => fs.existsSync(path.join(dist, rel));

beforeAll(() => {
  if (!exists("index.html")) {
    throw new Error(`no build output at ${dist} — run \`pnpm --filter web build\` before this suite`);
  }
});

/* Two ceilings, both GZIPPED, both measured (ADR 0002).
 *
 * GZIPPED, not bytes on disk: the budget exists to bound the time a student
 * on a phone spends waiting, and what they wait for is the transfer. Three.js
 * is 535 KB on disk and 136 KB on the wire, and holding the page to the
 * former would be policing a number nobody experiences. Cloudflare Pages
 * compresses by default.
 *
 * WHY TWO. One number cannot do both jobs. The total stops the loophole the
 * old test had — deferring a chunk must not make it free. The eager number is
 * the thing the original 20 KB limit was actually protecting: first paint.
 * Fixing the metric is what revealed they had drifted apart, and that the
 * landing page was eagerly shipping 55 KB of Supabase client so a contact
 * form below the fold could decide whether to render.
 *
 * Do not round either up to make a build pass. Re-measure, and put the figure
 * in the commit message — that is the discipline the ADR exists to impose. */

/** Script that runs before the page is interactive. Measured at 4.2 KB. */
const LANDING_EAGER_CEILING_KB = 12;

/** Everything reachable, lazy chunks included. Measured at 190.7 KB — of
 * which Three.js is 135.6 and the Supabase client 56.0, both deferred. */
const LANDING_SCRIPT_CEILING_KB = 230;

/** Every script reachable from `entries`, static or dynamic, as dist-relative
 * paths.
 *
 * Rollup emits both kinds of edge as a bare `from "./chunk-x.js"` /
 * `import("./chunk-y.js")` specifier in the built file, so one scan catches
 * both — which is the point. Resolution is textual rather than a real parse:
 * a bundler's output is machine-written and regular, and a parser here would
 * be a second implementation of the thing under test. */
function reachableScripts(entries: string[], follow: "static" | "all"): Set<string> {
  const seen = new Set<string>();
  const queue = entries.map((e) => e.replace(/^\//, ""));

  while (queue.length) {
    const rel = queue.shift()!;
    if (seen.has(rel) || !exists(rel)) continue;
    seen.add(rel);

    const src = read(rel);
    const dir = path.posix.dirname(rel);
    // `import("x")` is the dynamic edge; `from "x"` and a bare `import "x"`
    // are static. Rollup writes both as plain relative specifiers, so the
    // only thing separating them is the parenthesis.
    const edges = /(?:\bfrom\s*|\bimport\s*(\()?\s*)["']([^"']+\.js)["']/g;
    for (const m of src.matchAll(edges)) {
      const dynamic = Boolean(m[1]);
      if (dynamic && follow === "static") continue;
      const spec = m[2];
      // Bare specifiers would mean an unbundled dependency; there are none in
      // this build, and treating one as a path would silently measure zero.
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      queue.push(path.posix.normalize(spec.startsWith("/") ? spec.slice(1) : path.posix.join(dir, spec)));
    }
  }
  return seen;
}

/** Transfer size of every reachable script, which is what a reader waits for.
 *
 * `statSync` would report the uncompressed file; the browser is handed the
 * gzipped stream. For Three.js the gap is 535 KB against 136 KB, so the two
 * numbers lead to completely different decisions. */
function scriptKb(entries: string[], follow: "static" | "all"): number {
  let total = 0;
  for (const rel of reachableScripts(entries, follow)) {
    total += zlib.gzipSync(fs.readFileSync(path.join(dist, rel))).length;
  }
  return total / 1024;
}

const entryScripts = () =>
  [...read("index.html").matchAll(/<script\b[^>]*\bsrc="(\/[^"]+)"/g)].map((m) => m[1]);

describe("the landing document", () => {
  it("is a real document, readable with no JavaScript", () => {
    const html = read("index.html");
    // An h1 with real text in the markup -- not produced by a script, which
    // is the entire reason this page is a document rather than an app shell.
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    expect(h1, "no h1 in the built landing document").toBeTruthy();
    expect(h1![1].replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(8);
    // And the product has to be named somewhere a visitor can see it. The h1
    // is the page's thesis, not the wordmark, so this looks at the body.
    expect(html.slice(html.indexOf("<body"))).toMatch(/LionsDegree/);
    // Its description has to be in the markup for a preview card to show it.
    expect(html).toMatch(/<meta\s+name="description"/);
  });

  it("ships none of the planner's JavaScript", () => {
    // SCRIPT sources only. This matched every `src=` attribute, which meant
    // the hero mark -- an <img> -- was being weighed as JavaScript the moment
    // one was added. It measured scripts by accident, because the old hero
    // was inline SVG and the page happened to contain no images.
    const scripts = [...read("index.html").matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts.some((s) => /\/assets\/plan-.*\.js$/.test(s))).toBe(false);
  });

  it("keeps the first paint light: what loads before anyone scrolls", () => {
    // THE NUMBER THAT PROTECTS THE PHONE READER. Static import graph only --
    // the bytes a student waits for when the page opens, before any lazy
    // chunk is asked for. Measured at 4.2 KB.
    const kb = scriptKb(entryScripts(), "static");
    expect(kb, `${kb.toFixed(1)} KB of script runs before the page is interactive`).toBeLessThan(
      LANDING_EAGER_CEILING_KB,
    );
  });

  it("weighs every script a visitor downloads, including lazy chunks", () => {
    // ADR 0002. This assertion used to read `<script src>` out of the markup
    // and stop there -- so a chunk fetched by a runtime `import()` appeared in
    // neither this limit nor the image one. Lazy-loading Three.js would have
    // passed the suite without the suite ever having considered it.
    //
    // A budget that can be stepped around by changing HOW a file is requested
    // rather than WHETHER it is downloaded measures nothing. Together with
    // the eager limit above, the pair says: deferring work is allowed, and
    // deferring it does not make it free.
    const entries = entryScripts();
    expect(entries.length, "no entry scripts on the landing page").toBeGreaterThan(0);
    const kb = scriptKb(entries, "all");
    expect(kb, `landing scripts total ${kb.toFixed(1)} KB across the whole import graph`).toBeLessThan(
      LANDING_SCRIPT_CEILING_KB,
    );
  });

  it("still never reaches the planner through a lazy import either", () => {
    // The markup check above only sees entry scripts. The whole point of
    // walking the graph is that a transitive edge is just as real an import,
    // and `plan-*.js` arriving that way would be the same failure wearing a
    // different hat.
    const entries = [...read("index.html").matchAll(/<script\b[^>]*\bsrc="(\/[^"]+)"/g)].map((m) => m[1]);
    const reached = [...reachableScripts(entries)];
    expect(
      reached.filter((f) => /^assets\/plan-.*\.js$/.test(f)),
      "the planner bundle is reachable from the landing page",
    ).toEqual([]);
  });

  it("keeps its imagery light enough to be worth loading", () => {
    // Images are the largest contentful paint here, so their weight is what a
    // student on a phone actually waits for. The brand mark alone was 192 KB
    // of full-depth PNG for four flat colours before it was quantised.
    const srcs = [...read("index.html").matchAll(/<img\b[^>]*\bsrc="(\/[^"]+)"/g)].map((m) => m[1]);
    expect(srcs, "no brand mark in the built page").toContain("/mark.png");
    // The product screenshot assertion was removed with the screenshots. The
    // page's imagery is now the live prerequisite scene and the static chain
    // behind it -- a screenshot of the planner alongside that would be two
    // pictures of the same claim. The weight limits below still bind
    // whatever images the page does carry.

    const kb = (s: string) => fs.statSync(path.join(dist, s.slice(1))).size / 1024;
    for (const s of srcs) expect(kb(s), `${s} is ${kb(s).toFixed(0)} KB on its own`).toBeLessThan(140);
    // DISTINCT files: the hero shot illustrates a feature section too, and
    // the browser fetches it once.
    const total = [...new Set(srcs)].reduce((n, s) => n + kb(s), 0);
    expect(total, `${total.toFixed(0)} KB of images on the landing page`).toBeLessThan(260);
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

describe("the icons", () => {
  it("are the logo, not the placeholder squares", () => {
    // The placeholders were flat navy squares, which PNG compresses to a few
    // hundred bytes. Artwork does not. Crude, but it is the property that
    // actually distinguishes them without decoding the image.
    for (const icon of ["icon-192.png", "icon-512.png", "apple-touch-icon.png"]) {
      expect(exists(icon), `${icon} missing`).toBe(true);
      expect(fs.statSync(path.join(dist, icon)).size, icon).toBeGreaterThan(5_000);
    }
    expect(exists("favicon.ico")).toBe(true);
  });

  it("are declared by both entry points", () => {
    for (const page of ["index.html", "plan/index.html"]) {
      expect(read(page), page).toMatch(/rel="icon"/);
      expect(read(page), page).toMatch(/rel="apple-touch-icon"/);
    }
  });

  it("sets one theme colour, because the landing page has one", () => {
    // It was a light/dark pair while the page was cream-led. The canvas
    // design pins the landing dark whatever the system preference says, so a
    // scheme-scoped pair would hand the chrome a cream the document never
    // paints -- the exact mismatch the pair existed to prevent. One canvas,
    // one value; the toggle still governs /plan/.
    const html = read("index.html");
    const tags = [...html.matchAll(/<meta\s+name="theme-color"[^>]*content="([^"]+)"/g)].map((m) => m[1]);
    expect(tags, "expected exactly one theme-color on a page with one canvas").toHaveLength(1);
    expect(html, "a scheme-scoped theme-color on a page that ignores the scheme").not.toMatch(
      /theme-color[^>]*prefers-color-scheme/,
    );
    // `bundles()` belongs to the font describe; resolve the sheet here rather
    // than reaching across scopes for it.
    const sheet = fs.readdirSync(path.join(dist, "assets")).find((f) => f.startsWith("landing-") && f.endsWith(".css"));
    expect(sheet, "no landing stylesheet in dist/assets").toBeTruthy();
    const css = read(path.join("assets", sheet!));
    // Both values have to be colours the page actually paints, or the chrome
    // agrees with the document in one scheme and not the other.
    for (const colour of tags) {
      expect(css, `theme-color ${colour} is a colour the stylesheet never uses`).toContain(colour);
    }
  });
});

describe("the service worker", () => {
  it("lives under the planner, which caps its scope there", () => {
    // A worker cannot control paths above its own location, so emitting it at
    // /plan/sw.js makes the landing page unreachable to it by construction
    // rather than by configuration that could drift.
    expect(exists("plan/sw.js")).toBe(true);
  });

  it("leaves a tombstone at the old root path", () => {
    // A worker from before the split is still registered at the root and
    // answers "/" from its own cache, so page-side cleanup never runs. The
    // browser does re-fetch the worker script, and a 404 there makes it KEEP
    // the registration -- so the file has to exist and has to self-destruct.
    expect(exists("sw.js")).toBe(true);
    const sw = read("sw.js");
    expect(sw).toMatch(/registration\.unregister\(\)/);
    expect(sw).toMatch(/caches\.delete/);
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
    // An existing install must UPDATE, not be duplicated alongside a new one.
    expect(m.id).toBe("/");
    // The near-black from two palettes ago framed an installed app wrongly.
    expect(m.theme_color).toBe("#f1ebdf");
  });
});

describe("the link preview card", () => {
  /** A student sends the link to a group chat. The previewer fetches the HTML,
   * does NOT run scripts, and renders whatever it finds in the head. Every
   * property below has to be in the static markup. */
  const html = () => read("index.html");

  it("carries a title, a description and an image", () => {
    for (const prop of ["og:title", "og:description", "og:image"]) {
      expect(html(), `${prop} is missing from the built document`).toContain(`property="${prop}"`);
    }
    expect(html()).toContain('name="twitter:card"');
  });

  it("points the image at an absolute URL", () => {
    // A previewer resolves og:image against its OWN host unless the URL is
    // absolute, so a relative path silently yields a card with no image.
    const src = /property="og:image" content="([^"]+)"/.exec(html())?.[1];
    expect(src, "no og:image content").toBeTruthy();
    expect(src).toMatch(/^https:\/\//);
  });

  it("ships the image it promises, at the size it declares", () => {
    const src = /property="og:image" content="([^"]+)"/.exec(html())![1];
    const rel = new URL(src).pathname.replace(/^\//, "");
    expect(exists(rel), `${rel} is referenced but not in dist`).toBe(true);

    // PNG header: width and height are big-endian 32-bit at bytes 16..24.
    const buf = fs.readFileSync(path.join(dist, rel));
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect(`${width}x${height}`).toBe("1200x630");
    const declared = {
      w: /property="og:image:width" content="(\d+)"/.exec(html())?.[1],
      h: /property="og:image:height" content="(\d+)"/.exec(html())?.[1],
    };
    expect(`${declared.w}x${declared.h}`, "declared size disagrees with the file").toBe(`${width}x${height}`);
  });

  it("describes the image for people who cannot see it", () => {
    expect(html()).toContain('property="og:image:alt"');
  });
});

describe("the landing page's content", () => {
  const html = () => read("index.html");

  it("says what this is as static text, before asking for anything", () => {
    // The headline has to be in the markup, not produced by a script: that is
    // the entire reason this page is a document.
    expect(html()).toMatch(/Your degree is a route/i);
    expect(html()).toMatch(/prerequisite/i);
  });

  it("sends people to a walkthrough instead of showing them code", () => {
    // There was an npx command and a JSON config block here. A student who
    // has never opened a terminal cannot act on either, and being shown them
    // says "this is not for you" -- which is the opposite of the page's job.
    expect(html(), "the landing page is showing code").not.toMatch(/<(pre|code)\b/);
    expect(html()).toMatch(/href="\/connect\/"/);
  });

  it("states the limits and keeps the disclaimer prominent", () => {
    expect(html()).toMatch(/not affiliated with/i);
    expect(html()).toMatch(/LionPATH/);
    expect(html()).toMatch(/adviser/i);
  });
});

describe("the monospace face", () => {
  /** Course codes are the one thing set in mono, and they have to look the
   * same everywhere. Naming a family that is not shipped means the code falls
   * back to whatever the operating system calls "monospace" -- Consolas on
   * Windows, SF Mono on a Mac -- so the same plan sets differently per
   * student.
   *
   * BOTH bundles. The first version of this test read only the landing
   * stylesheet and passed green while the PLANNER -- where course codes
   * overwhelmingly appear -- shipped no mono face at all. A font check that
   * covers one of the two places the font is used is a partial check that
   * reads like a complete one. */
  const bundles = () => {
    const dir = path.join(dist, "assets");
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".css"));
    const landing = all.find((f) => f.startsWith("landing-"));
    const planner = all.find((f) => f.startsWith("plan-"));
    expect(landing, "no landing stylesheet in dist/assets").toBeTruthy();
    expect(planner, "no planner stylesheet in dist/assets").toBeTruthy();
    return { landing: landing!, planner: planner! };
  };

  for (const which of ["landing", "planner"] as const) {
    it(`is shipped with the ${which}, not left to the operating system`, () => {
      const css = read(path.join("assets", bundles()[which]));

      // It is named by the token...
      expect(css, "--font-mono is not declared in this bundle").toMatch(/--font-mono:/);
      // ...so the face it names has to be here too.
      const faces = [...css.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]);
      const mono = faces.filter((f) => /JetBrains Mono/i.test(f));
      expect(mono.length, `${which} names JetBrains Mono but ships no @font-face for it`).toBeGreaterThan(0);

      // Each has to come from us. Vite inlines small faces as a data: URI and
      // emits larger ones as files; both are self-hosted. What must never
      // appear is a remote host, which would make the page depend on someone
      // else's uptime and leak a request per visitor.
      for (const f of mono) {
        const url = (/url\(([^)]+)\)/.exec(f)?.[1] ?? "").replace(/^["']|["']$/g, "");
        expect(url, `mono face loaded from a remote host: ${url}`).not.toMatch(/^https?:/);
        if (url.startsWith("data:")) continue;
        expect(exists(url.replace(/^\//, "")), `${url} is referenced by @font-face but not in dist`).toBe(true);
      }
    });
  }
});

describe("the default deployment", () => {
  /** `wrangler pages deploy` compiles a `functions/` directory sitting in the
   * working directory, with no flag to point it elsewhere. So the presence of
   * that directory IS the difference between a free deploy and a billable
   * one, and it is the kind of thing a future change re-adds without anyone
   * noticing until a bill arrives. */
  const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  it("ships no proxy: wrangler finds no functions directory to compile", () => {
    expect(
      fs.existsSync(path.join(web, "functions")),
      "apps/web/functions exists, so `npm run deploy` would deploy a billable proxy. " +
        "The proxy belongs at self-host/functions and is put in place only by deploy:self-host.",
    ).toBe(false);
  });

  it("keeps the proxy in the repository for self-hosters", () => {
    // Off by default is not the same as deleted: the ticket requires it stay
    // available, with its hardening intact.
    expect(fs.existsSync(path.join(web, "self-host", "functions", "v1", "[[route]].ts"))).toBe(true);
  });

  it("bakes no chat endpoint into the shipped bundle", () => {
    // "No endpoint is hardcoded into the client". A build with nothing
    // configured must contain no route to a proxy at all.
    // Name the FILES that contain it, never the bundle itself. Asserting
    // `expect(wholeBundle).not.toContain(...)` prints a megabyte of minified
    // JavaScript on failure, which is unreadable and buries the answer.
    const offenders = fs
      .readdirSync(path.join(dist, "assets"))
      .filter((f) => f.endsWith(".js"))
      .filter((f) => read(path.join("assets", f)).includes("/v1/chat"));
    expect(
      offenders,
      `a chat endpoint is compiled into: ${offenders.join(", ")}. ` +
        `If this build was made with VITE_CHAT_ENDPOINT set, rebuild without it.`,
    ).toEqual([]);
  });
});

describe("the coverage figure", () => {
  /** The claim on the public site. Its whole point is that it is computed
   * rather than written, so the test recomputes it from the shipped catalog
   * and compares -- a hand-edited number, or one left over from a previous
   * catalog, fails here. */
  const html = () => read("index.html");

  it("states a percentage, not a placeholder", () => {
    expect(html(), "a %COVERAGE_% placeholder shipped as literal text").not.toContain("%COVERAGE");
    expect(html()).toMatch(/<strong>\d{1,3}%<\/strong>/);
  });

  it("matches what the shipped catalog actually computes to", () => {
    // The same files the build read, via the same loader. Recomputing the
    // STATISTIC is the independence that matters; re-enumerating directories
    // identically bought no drift detection, only a third copy to maintain.
    const stat = requirementCoverage(loadPrograms());
    const shown = Number(/<strong>(\d{1,3})%<\/strong>/.exec(html())?.[1]);
    expect(shown, `the page says ${shown}% but the catalog computes to ${stat.percent}%`).toBe(stat.percent);

    // The programs the figure is measured across, so "95%" cannot quietly
    // become a percentage of something smaller.
    expect(html()).toContain(loadPrograms().length.toLocaleString("en-US"));
  });

  it("never lets the number travel without its qualifier", () => {
    // THE HONESTY GUARD, and the reason this describe still exists after the
    // breakdown section was removed for brevity. A bare "95%" reads as a
    // guarantee; what makes it a measurement is saying what the other 5% is.
    // The long breakdown is gone by request -- the clause is not, and this is
    // what stops it being tidied away next time the page gets shorter.
    const claim = /<strong>\d{1,3}%<\/strong>([\s\S]{0,240})/.exec(html())?.[1] ?? "";
    expect(
      claim,
      "the coverage percentage is stated with nothing qualifying it",
    ).toMatch(/flagged|never guessed|verify|cannot be verified/i);
  });
});
