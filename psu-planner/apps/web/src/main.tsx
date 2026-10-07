import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Self-hosted display/UI face — bundled by Vite and served same-origin, so it
// works under the strict CSP (font-src 'self') with no external fetch.
import "@fontsource-variable/space-grotesk";
import "./styles.css";

// Apply the saved theme before first paint (no inline <script> — the CSP
// forbids it — but a bundled module runs early enough to avoid a flash).
const savedTheme = localStorage.getItem("lionsdegree-theme");
if (savedTheme === "dark" || savedTheme === "light") {
  document.documentElement.dataset.theme = savedTheme;
}

// Registered here rather than injected into every HTML entry, so the landing
// page stays script-light and the worker only ever controls the planner.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/plan/sw.js", { scope: "/plan/" }).catch(() => {
      /* offline support is a bonus, never a reason to fail boot */
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
