import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

// Load apps/api/.env if present (native Node 20.12+; no dotenv dependency).
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch { /* no .env — fall back to shell environment */ }

const app = createApp({
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  FREE_DAILY_LIMIT: process.env.FREE_DAILY_LIMIT,
  // The Node server is the DEV entry (production runs as a Pages Function);
  // default to development so localhost origins are allowed.
  NODE_ENV: process.env.NODE_ENV ?? "development",
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
  REQUIRE_AUTH: process.env.REQUIRE_AUTH,
});

const port = parseInt(process.env.PORT ?? "8788", 10);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port} (model: ${process.env.OPENAI_MODEL ?? "gpt-5-mini"}, key: ${process.env.OPENAI_API_KEY ? "set" : "MISSING"})`);
});
