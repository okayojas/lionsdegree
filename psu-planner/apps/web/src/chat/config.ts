/** Is the in-app advisor configured, and where does it live?
 *
 * The project is open source and the model is bring-your-own-AI: a student
 * points their own assistant at the MCP server and pays nothing to anyone.
 * The bundled proxy exists for self-hosters, so it is OPTIONAL CONFIGURATION
 * rather than a default — a fork that deploys this must not be able to spend
 * the project's money, and a default install must cost nothing to run.
 *
 * Config-gated exactly like account sync (`data/sync.ts`), including its
 * lesson: that gate tested PRESENCE only, so a placeholder left in .env.local
 * satisfied it and the app crashed on a malformed URL. The shape is checked
 * here, and anything unusable degrades to "not configured" — which is the
 * conservative failure, because the alternative is a chat box that throws
 * when a student presses send.
 */

/** Hosts where plain http is acceptable: there is no network to sniff. */
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Normalise a configured endpoint, or return null when the advisor should be
 * treated as absent.
 *
 * SAME-ORIGIN ONLY. An absolute off-origin URL is rejected even when it is
 * https, for two reasons that both bite the student rather than the person
 * who configured it:
 *
 *   - `public/_headers` ships `connect-src 'self' https://*.supabase.co`, so
 *     the browser blocks the request. The Advisor tab would render and every
 *     send would fail -- precisely the "control that cannot work" this gate
 *     exists to prevent, and the same failure as the http case below.
 *   - useChat sends the student's Supabase access token as a Bearer header.
 *     That is the credential their row-level security depends on, and an
 *     off-origin endpoint hands it to a third party.
 *
 * A proxy hosted elsewhere is still supported: front it at your own origin,
 * which is what the bundled Pages Function does. Pointing the browser
 * straight at it would need the CSP widened too, and a config that silently
 * contradicts the shipped CSP is worse than one that refuses.
 *
 * Exported for tests; prefer `chatEndpoint` below.
 */
export function parseChatEndpoint(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  // A placeholder copied out of .env.example. Never a usable endpoint, and
  // catching it here is the difference between a hidden tab and a broken one.
  if (v.includes("<") || v.includes(">")) return null;

  if (v.startsWith("/")) return v;

  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  // Localhost is the one absolute form that works: there is no CSP on a dev
  // server and no network to carry the token off the machine.
  if (LOCAL.has(url.hostname)) return v;
  return null;
}

const configured = import.meta.env.VITE_CHAT_ENDPOINT as string | undefined;

if (configured && parseChatEndpoint(configured) === null) {
  console.error(
    `[chat] VITE_CHAT_ENDPOINT is not usable (${configured}). The advisor is HIDDEN and the ` +
      `planner is fully local. Use a path like /v1/chat or an https URL — see .env.example.`,
  );
}

/** The endpoint to POST to, or null when the advisor is not configured. */
export const chatEndpoint = parseChatEndpoint(configured);

/** Whether to offer the advisor at all. When false, no control for it is
 * rendered: a student who configured nothing is never shown a button that
 * cannot work. */
export const chatConfigured = chatEndpoint !== null;
