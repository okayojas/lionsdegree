import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: {
    proxy: { "/v1": "http://localhost:8788" },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "LionsDegree",
        short_name: "LionsDegree",
        description: "LionsDegree — prerequisite-aware degree planning for Penn State students (unofficial).",
        // The cream "map paper" background of the current identity (see
        // DECISIONS.md 5.2). This was still #0f1520, a near-black from two
        // palettes ago, so an installed PWA framed the app in the wrong colour.
        theme_color: "#f1ebdf",
        background_color: "#f1ebdf",
        display: "standalone",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        // App shell precached; catalog JSON cached on first use so the
        // flowchart, search, and prereq checks work offline after first visit.
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
