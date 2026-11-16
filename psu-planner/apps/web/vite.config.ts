import { defineConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { SITE_HEADER_SLOT, SITE_PAGES, siteHeader } from "./src/site/header";

/** TWO ENTRY POINTS. The root is a static document; the planner is the SPA,
 * served from /plan/.
 *
 * The split exists because link previewers and crawlers do not run
 * JavaScript, so a marketing page rendered by React unfurls as a blank card —
 * and a shared link is how this reaches students. It also means the landing
 * page ships none of the planner's bundle, which is what makes it load
 * instantly on a phone.
 *
 * Vite handles this natively, so there is no router and no prerenderer. */
/** The canonical origin, in ONE place.
 *
 * It appears in canonical, og:url, og:image and twitter:image. As four
 * literals in the markup, moving the site meant finding all four, and a
 * preview deployed to *.pages.dev would unfurl the production card. Override
 * with SITE_URL in the environment for a preview build. */
const SITE_URL = (
  // Explicit wins: a local preview deploy sets this.
  process.env.SITE_URL ??
  // Cloudflare sets CF_PAGES_URL on every Pages build, including previews, so
  // a preview built BY Cloudflare labels itself correctly with no ceremony.
  // Without this a preview inherits the production canonical URL and unfurls
  // the production card, which is how a half-finished build gets shared
  // looking like the real site.
  process.env.CF_PAGES_URL ??
  "https://lionsdegree.com"
).replace(/\/$/, "");

/** The coverage figure, computed before the build by scripts/coverage-facts.mts
 * and read here.
 *
 * Not computed inline: the engine's modules import each other with `.js`
 * specifiers that Node cannot resolve when it loads this config as ESM, and
 * reimplementing the counting here would put a second copy of the rule
 * somewhere it could drift from the tested one.
 *
 * Throws rather than falling back. A landing page that shipped `%COVERAGE_
 * PERCENT%` as literal text, or a stale figure from a previous catalog, is
 * worse than a build that stops and says why. */
function coverageFacts(): Record<string, string> {
  const file = resolve(__dirname, "coverage.generated.json");
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing. The landing page states a coverage figure computed from the ` +
        `catalog; run \`npm run coverage\` (the build does this for you) before building.`,
    );
  }
  const f = JSON.parse(readFileSync(file, "utf-8")) as Record<string, string | number>;
  return {
    "%COVERAGE_PERCENT%": String(f.percent),
    "%COVERAGE_RESOLVED%": String(f.resolved),
    "%COVERAGE_NAMED%": String(f.named),
    "%COVERAGE_PATTERNED%": String(f.patterned),
    "%COVERAGE_GENED%": String(f.genEd),
    "%COVERAGE_UNREADABLE%": String(f.unreadable),
    "%COVERAGE_TOTAL%": String(f.total),
    "%COVERAGE_ADVISER%": String(f.adviser),
    "%COVERAGE_PROGRAMS%": String(f.programs),
    "%COVERAGE_PROGRAMS_RAW%": String(f.programsRaw),
    "%COVERAGE_COURSES%": String(f.courses),
    "%COVERAGE_COURSES_RAW%": String(f.coursesRaw),
    "%COVERAGE_EDITION%": String(f.edition),
  };
}

/** Substitutes %SITE_URL% and the coverage facts in index.html. Vite only
 * expands %VAR% from loaded .env files, and none of these are secrets. */
const siteUrl = () => ({
  name: "site-url",
  transformIndexHtml: (html: string) => {
    let out = html.replaceAll("%SITE_URL%", SITE_URL);
    // Computed once per build, and only when the page actually asks for it.
    if (out.includes("%COVERAGE_")) {
      for (const [k, v] of Object.entries(coverageFacts())) out = out.replaceAll(k, v);
    }
    return out;
  },
});

/** Writes the shared header into every hand-written page that asks for it.
 *
 * The header is one function (src/site/header.ts). The legal documents are
 * generated and call it themselves; a hand-written page leaves a comment
 * where it goes. Filled in here rather than by a prebuild script so that the
 * dev server and the build cannot disagree about what the page contains.
 *
 * `ctx.path` is the document being served ("/connect/index.html"), which is
 * how the header knows which of its links is the current page. */
const siteHeaderSlot = () => ({
  name: "site-header",
  transformIndexHtml: (html: string, ctx: { path: string }) =>
    html.includes(SITE_HEADER_SLOT)
      ? html.replaceAll(SITE_HEADER_SLOT, siteHeader(ctx.path.replace(/index\.html$/, "")))
      : html,
});

export default defineConfig({
  resolve: {
    alias: {
      // THE CONNECTOR'S SANDBOX, REACHED FROM THE BROWSER.
      //
      // A candidate tab is the plan the planner would have after a list of
      // changes, and the planner must not be a second implementation of
      // applying them: a tab and a `simulate_changes` preview of the same
      // changes that disagree is a picture of a degree nobody can have.
      // So the browser runs the SAME `sandbox.ts` the connector runs.
      //
      // An alias rather than a workspace dependency because
      // `lionsdegree-mcp` is published to npm with only `dist/` in its
      // files; giving it an `exports` entry pointing into `src/` would
      // publish a path that is not there. Mirrored in tsconfig paths and
      // vitest.config.ts — three places, which is two too many, but each
      // one is a different resolver.
      "@connector": resolve(__dirname, "../../packages/mcp/src"),
    },
  },
  server: {
    proxy: { "/v1": "http://localhost:8788" },
  },
  build: {
    rollupOptions: {
      input: {
        landing: resolve(__dirname, "index.html"),
        plan: resolve(__dirname, "plan/index.html"),
        // Generated by scripts/legal-pages.mts from src/legal/content.ts.
        // Separate entries, not routes: an OAuth reviewer and a crawler both
        // need these to exist without running any JavaScript.
        connect: resolve(__dirname, "connect/index.html"),
        privacy: resolve(__dirname, "privacy/index.html"),
        terms: resolve(__dirname, "terms/index.html"),
      },
    },
  },
  plugins: [
    siteUrl(),
    siteHeaderSlot(),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Registered by hand from the planner entry (src/main.tsx) rather than
      // injected, so the landing page never ships a registration and the
      // worker's scope stays /plan/.
      injectRegister: null,
      // Emitting the worker UNDER /plan/ caps its scope there by construction:
      // a worker cannot control paths above its own location. The landing page
      // is then an ordinary cacheable document that no worker intercepts.
      filename: "plan/sw.js",
      scope: "/plan/",
      manifestFilename: "plan/manifest.webmanifest",
      manifest: {
        // Identity stays "/" -- the value an existing install already has.
        // Changing it would register a SECOND app rather than update the one
        // a student installed, leaving them with a stale duplicate.
        id: "/",
        name: "LionsDegree",
        short_name: "LionsDegree",
        description: "LionsDegree — prerequisite-aware degree planning for Penn State students (unofficial).",
        scope: "/plan/",
        start_url: "/plan/",
        // The cream "map paper" background of the current identity (see
        // DECISIONS.md 5.2). This was still #0f1520, a near-black from two
        // palettes ago, so an installed PWA framed the app in the wrong colour.
        theme_color: "#f1ebdf",
        background_color: "#f1ebdf",
        display: "standalone",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        // Everything outside /plan/ is outside this worker's scope, so
        // precaching it would store bytes the worker can never serve. That
        // is the landing page and every page that wears the site header,
        // with the stylesheet, script and 3D chunk only they load. The list
        // had only ever named the landing page's own files, so a student
        // installing the planner was also handed the three documents and
        // the landing page's copy of three.js.
        globIgnores: [
          "index.html",
          // "/connect/" -> "connect/**"
          ...SITE_PAGES.map((page) => `${page.slice(1)}**`),
          "assets/landing-*.js",
          "assets/landing-*.css",
          "assets/journey-*.js",
          "assets/site-*.css",
          "assets/copy-*.js",
          "og.png",
        ],
        // Deep links inside the planner resolve to its shell. The denylist
        // keeps the worker's hands off the catalog and off anything outside
        // /plan/, which it could not reach anyway from this scope.
        navigateFallback: "/plan/index.html",
        navigateFallbackDenylist: [/^\/catalog\//, /^\/v1\//],
        runtimeCaching: [
          {
            // Paths are /catalog/<edition>/... — one cache spanning editions.
            urlPattern: /\/catalog\/.*\.json$/,
            handler: "CacheFirst",
            options: {
              cacheName: "catalog",
              // A single edition is ~1,300 files, so the old 800 evicted even
              // one edition mid-use. Budget for several.
              expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 120 },
            },
          },
        ],
      },
    }),
  ],
});
