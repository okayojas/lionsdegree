import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  baseUrl: "https://bulletins.psu.edu",
  userAgent: "psu-degree-planner-scraper/0.1 (+https://github.com/okayojas/lionsdegree)",
  requestDelayMs: 1000,
  requestJitterMs: 300,
  maxRetries: 3,
  // Catalog edition label, e.g. "2025-2026-fall". Overridable via CLI --edition.
  edition: process.env.EDITION ?? "2025-2026",
  rawDir: (edition: string) => path.join(ROOT, "data", "raw", edition),
  outDir: (edition: string) => path.join(ROOT, "data", "out", edition),
  paths: {
    subjectsIndexUG: "/university-course-descriptions/undergraduate/",
    subjectsIndexGrad: "/university-course-descriptions/graduate/",
    programsIndex: "/programs/",
    genEd: "/undergraduate/general-education/",
  },
};
