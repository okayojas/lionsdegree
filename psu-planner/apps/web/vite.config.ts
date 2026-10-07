import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

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
export default defineConfig({
  server: {
    proxy: { "/v1": "http://localhost:8788" },
  },
  build: {
    rollupOptions: {
      input: {
        landing: resolve(__dirname, "index.html"),
        plan: resolve(__dirname, "plan/index.html"),
      },
    },
  },
  plugins: [
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
        id: "/plan/",
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
        // The landing page is outside this worker's scope, so precaching it
        // would store bytes the worker can never serve.
        globIgnores: ["index.html", "assets/landing-*.js"],
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
