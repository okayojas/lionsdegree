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
        theme_color: "#0f1520",
        background_color: "#0f1520",
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
            urlPattern: /\/catalog\/.*\.json$/,
            handler: "CacheFirst",
            options: {
              cacheName: "catalog",
              expiration: { maxEntries: 800, maxAgeSeconds: 60 * 60 * 24 * 120 },
            },
          },
        ],
      },
    }),
  ],
});
