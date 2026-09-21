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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
