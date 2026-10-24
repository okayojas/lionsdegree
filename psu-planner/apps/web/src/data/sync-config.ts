/** Is account sync configured in this build?
 *
 * Split out of `sync.ts` so a caller can ask the question without pulling in
 * `@supabase/supabase-js`. That client is 55 KB gzipped, and the landing
 * page was downloading all of it eagerly so that a contact form below the
 * fold could decide whether to show itself — which the old markup-scanning
 * budget test had no way to see (ADR 0002).
 *
 * Nothing here imports the client. Keep it that way.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** Tests the SHAPE, not just presence. A placeholder left in `.env.local`
 * (`https://<project-ref>.supabase.co`) passed a presence check, then
 * `createClient` threw "Invalid supabaseUrl" and took the account UI down
 * with it. Degrade to local-only instead — the conservative failure. */
export function isUsableUrl(u: string | undefined): u is string {
  if (!u) return false;
  try {
    const { protocol } = new URL(u);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

if (url && !isUsableUrl(url)) {
  console.error(
    `[sync] VITE_SUPABASE_URL is not a valid URL (${url}). Account sync is OFF and the ` +
      `planner will run local-only. Fix or remove it in apps/web/.env.local — see .env.example.`,
  );
}

export const supabaseUrl = url;
export const supabaseAnonKey = anonKey;
export const syncConfigured = isUsableUrl(url) && Boolean(anonKey);
