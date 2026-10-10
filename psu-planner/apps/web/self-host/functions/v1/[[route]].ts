/** Cloudflare Pages Function: serves /v1/* from the SAME origin as the app —
 * no CORS, no separate worker to manage. The Hono app comes from apps/api
 * (the identical code that runs on Node in dev).
 *
 * Production bindings (set once in the Pages project):
 *   - secret  OPENAI_API_KEY
 *   - KV      RATE_LIMIT
 *   - vars    OPENAI_MODEL, FREE_DAILY_LIMIT (optional)
 */
import { createApp, type Env } from "../../../api/src/app";

interface PagesContext {
  request: Request;
  env: Env;
}

export const onRequest = (ctx: PagesContext): Response | Promise<Response> => {
  const app = createApp(ctx.env);
  return app.fetch(ctx.request);
};
