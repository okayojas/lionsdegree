/** The authorization server the connector runs.
 *
 * WHY WE RUN ONE. MCP clients expect OAuth 2.1 with dynamic client
 * registration: an assistant that has never heard of us registers
 * itself, sends the student somewhere they recognise, and comes back
 * with a token. Supabase is not that. It is an authorization server for
 * OUR app — no DCR, no third-party clients — so this sits in front of
 * it: the connector is the authorization server, and Supabase is where
 * the student actually proves who they are, through the Google and
 * Microsoft providers already configured there.
 *
 * NO NEW CREDENTIAL. The token this hands back IS the Supabase access
 * token, verified on every request with the same secret the chat API
 * uses. There is no second identity system to keep in step and nothing
 * new to rotate.
 *
 * TWO PKCE EXCHANGES, NOT ONE, and conflating them is the mistake this
 * file was first written with. The assistant runs PKCE against US; we
 * run a SEPARATE PKCE against Supabase. Supabase's GoTrue only mints an
 * auth code when `code_challenge` is present on the authorize request —
 * without one it uses the implicit flow and returns tokens in a URL
 * FRAGMENT, which a server never receives. So the first version could
 * not have worked in production in two independent ways, and the test
 * missed it by stubbing `fetch` without looking at what was sent.
 *
 * WHAT IS STORED, and for how long:
 *   client:<id>   a registered assistant's name and redirect URIs.
 *   code:<code>   one authorization code, with the PKCE challenge and
 *                 the access token it stands for. Sixty seconds, single
 *                 use.
 *   pend:<state>  a flow in progress while the student is at Google,
 *                 including OUR verifier for the Supabase leg and a
 *                 hash of the cookie that binds it to one browser.
 *                 Five minutes, matching Supabase's own flow-state
 *                 expiry — holding it longer only produces a valid
 *                 record pointing at a dead upstream flow.
 *   anon:<ip>     unauthenticated write budget. See ANON_WRITES_PER_DAY.
 *   revoked:<fp>  a token fingerprint the student has disconnected.
 *
 * Nothing here holds a student's Plan.
 */
import { rateLimit, type KVLike } from "@psu-planner/identity";

export interface OAuthEnv {
  OAUTH?: KVLike;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
}

/** Everything the flow needs, or null if the operator has not finished
 * setting it up. Checked once at the door: issuing codes that nothing
 * can exchange is worse than refusing. */
function config(env: OAuthEnv): { kv: KVLike; supabase: string; anon: string } | null {
  if (!env.OAUTH || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  return { kv: env.OAUTH, supabase: env.SUPABASE_URL.replace(/\/+$/, ""), anon: env.SUPABASE_ANON_KEY };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

const NOT_CONFIGURED = () =>
  json({ error: "temporarily_unavailable", error_description: "This connector is not accepting sign-ins right now." }, 503);

/** URL-safe random, long enough that guessing is not a strategy. */
function randomId(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b);
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier) as BufferSource);
  return b64url(new Uint8Array(digest));
}

/** A redirect we are willing to send an authorization code to.
 *
 * HTTPS, or loopback — which is how a desktop assistant receives one,
 * and is safe because the hop never leaves the machine. Anything else
 * delivers the code to whoever is listening on the wire. */
function usableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

interface Pending {
  client_id: string;
  redirect_uri: string;
  /** The ASSISTANT's challenge, for the exchange it will make with us. */
  code_challenge: string;
  state?: string;
  /** OUR verifier, for the exchange WE make with Supabase. A separate
   * PKCE run; the two must not be confused. */
  supabase_verifier: string;
  /** Hash of the cookie set when this flow started.
   *
   * THE ACCOUNT TAKEOVER THIS PREVENTS. `state` is minted by us, so an
   * attacker can start a flow, read the state out of their own 302, and
   * send a victim a Supabase sign-in link carrying it. The victim signs
   * in — at Google, on their own machine, nothing visibly wrong — and
   * our callback hands the resulting code to the ATTACKER's redirect.
   * Binding the flow to the browser that began it makes step two
   * useless: the victim's browser does not have the attacker's cookie. */
  browser: string;
}

interface IssuedCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  access_token: string;
  expires_in: number;
}

const CODE_TTL = 60;
/** Matches Supabase's own flow-state expiry. Longer only yields a valid
 * record of ours pointing at a dead flow of theirs. */
const PENDING_TTL = 300;

/** The last few sign-ins that did not finish.
 *
 * A BREADCRUMB AN OPERATOR CAN READ LATER. `console.error` only helps
 * somebody already watching a live tail, and a student's failed sign-in
 * does not wait for an audience — the first report of this connector
 * refusing people arrived as "it says you started connecting but didn't
 * finish", with nothing anywhere saying at which step.
 *
 * Read it with:
 *   npx wrangler kv key get --binding OAUTH oauth:recent-failures --remote
 *
 * WHAT GOES IN IS A STAGE AND A SHAPE, never a credential: no codes, no
 * verifiers, no tokens, no email. Enough to say which check refused and
 * what it was looking at, and nothing that would matter if the record
 * leaked. One day's retention, last ten only. */
const FAILURE_LOG = "oauth:recent-failures";
const FAILURE_LOG_TTL = 60 * 60 * 24;
const FAILURE_LOG_KEEP = 10;

async function noteFailure(kv: KVLike, stage: string, why: string): Promise<void> {
  console.error(`[oauth] ${stage}: ${why}`);
  try {
    const held = await kv.get(FAILURE_LOG);
    const past = held ? (JSON.parse(held) as unknown[]) : [];
    const next = [{ at: new Date().toISOString(), stage, why }, ...past].slice(0, FAILURE_LOG_KEEP);
    await kv.put(FAILURE_LOG, JSON.stringify(next), { expirationTtl: FAILURE_LOG_TTL });
  } catch (e) {
    // The record is a convenience. A sign-in must not fail differently
    // because writing a breadcrumb did.
    console.error("[oauth] could not record the failure", e);
  }
}

/** Unauthenticated writes per address per day.
 *
 * Every route here writes to KV and runs BEFORE the gate — it has to,
 * since these are how a caller GETS a token. That makes them the one
 * unmetered write path in the service, and an unmetered write path is
 * somebody else's bill. `/revoke` was the worst: its key is whatever
 * the caller sends, so each request wrote a NEW entry lasting 25 hours.
 *
 * KEYED BY ADDRESS, which everywhere else in this project is the wrong
 * answer — a shared campus network means one student throttles a
 * building. It is right HERE and only here, because there is no
 * identity yet: that is what these routes exist to establish. Set well
 * above what a lecture hall signing in together would reach. */
const ANON_WRITES_PER_DAY = 30;

const COOKIE = "ld_flow";

/** The browser that started a flow, if it says so. */
function flowCookie(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=") || null;
  }
  return null;
}

/** Refuse an unauthenticated caller who is writing too much. */
async function throttleAnonymous(request: Request, kv: KVLike): Promise<Response | null> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const budget = await rateLimit(kv, `anon:${ip}`, ANON_WRITES_PER_DAY);
  if (budget.ok) return null;
  return json(
    { error: "temporarily_unavailable", error_description: "Too many sign-in attempts. Try again later." },
    429,
    { "retry-after": String(budget.resetInSeconds) },
  );
}

/** Handle an OAuth route, or return null if this is not one. */
export async function handleOAuth(request: Request, env: OAuthEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  const p = url.pathname;

  if (p === "/.well-known/oauth-protected-resource") {
    if (!config(env)) return NOT_CONFIGURED();
    return json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://lionsdegree.com/connect/",
    });
  }

  if (p === "/.well-known/oauth-authorization-server") {
    if (!config(env)) return NOT_CONFIGURED();
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      // S256 ONLY. OAuth 2.1 requires PKCE, and `plain` is not a
      // challenge — it is the verifier sent twice.
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["openid", "email"],
    });
  }

  if (p === "/register" && request.method === "POST") {
    const cfg = config(env);
    if (!cfg) return NOT_CONFIGURED();
    const throttled = await throttleAnonymous(request, cfg.kv);
    if (throttled) return throttled;

    let body: { client_name?: unknown; redirect_uris?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return oauthError("invalid_client_metadata", "The registration body is not JSON.");
    }
    const uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (!uris.length) return oauthError("invalid_redirect_uri", "At least one redirect_uri is required.");
    if (!uris.every(usableRedirect)) {
      return oauthError("invalid_redirect_uri", "Redirect URIs must be https, or http on loopback.");
    }

    const client: Client = {
      client_id: randomId(16),
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "an assistant",
      redirect_uris: uris.slice(0, 10),
    };
    await cfg.kv.put(`client:${client.client_id}`, JSON.stringify(client), { expirationTtl: 60 * 60 * 24 * 180 });
    // No `client_secret`: an assistant cannot keep one, and issuing a
    // secret that cannot be protected invites it being treated as if it
    // could be.
    return json({ ...client, token_endpoint_auth_method: "none" }, 201);
  }

  if (p === "/authorize") {
    const cfg = config(env);
    if (!cfg) return NOT_CONFIGURED();
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const challenge = q.get("code_challenge") ?? "";
    const method = q.get("code_challenge_method") ?? "";

    const raw = await cfg.kv.get(`client:${clientId}`);
    const client = raw ? (JSON.parse(raw) as Client) : null;
    // REFUSED IN PLACE, never by redirecting. Anyone can call this with
    // somebody else's client_id; bouncing the error to an unverified
    // redirect is how the next request's code reaches an attacker.
    if (!client) return oauthError("invalid_client", "Unknown client. Register first.");
    if (!client.redirect_uris.includes(redirectUri)) {
      return oauthError("invalid_request", "That redirect_uri is not registered to this client.");
    }
    if (q.get("response_type") !== "code") {
      return oauthError("unsupported_response_type", "Only the authorization code flow is supported.");
    }
    if (!challenge || method !== "S256") {
      return oauthError("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }

    const throttled = await throttleAnonymous(request, cfg.kv);
    if (throttled) return throttled;

    // OUR OWN PKCE, for the Supabase leg. Without `code_challenge`
    // upstream, GoTrue mints no auth code at all and falls back to the
    // implicit flow, which returns tokens in a URL fragment a server
    // never sees. Two separate exchanges: the assistant's challenge is
    // for the code WE issue, this one is for the code SUPABASE issues.
    const supabaseVerifier = randomId(32);
    const state = randomId(24);
    const browserSecret = randomId(24);

    const pending: Pending = {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      state: q.get("state") ?? undefined,
      supabase_verifier: supabaseVerifier,
      browser: await s256(browserSecret),
    };
    await cfg.kv.put(`pend:${state}`, JSON.stringify(pending), { expirationTtl: PENDING_TTL });

    const provider = q.get("provider") === "azure" ? "azure" : "google";
    const to = new URL(`${cfg.supabase}/auth/v1/authorize`);
    to.searchParams.set("provider", provider);
    to.searchParams.set("code_challenge", await s256(supabaseVerifier));
    to.searchParams.set("code_challenge_method", "s256");
    to.searchParams.set("redirect_to", `${issuer}/callback?state=${encodeURIComponent(state)}`);

    // `SameSite=Lax` so it comes back on the top-level redirect from
    // Supabase and on nothing a third-party page initiates. HttpOnly so
    // no script can read it; Secure so it never crosses plain http.
    return new Response(null, {
      status: 302,
      headers: {
        location: to.toString(),
        "set-cookie":
          `${COOKIE}=${browserSecret}; Path=/callback; Max-Age=${PENDING_TTL}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  if (p === "/callback") {
    const cfg = config(env);
    if (!cfg) return NOT_CONFIGURED();
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const raw = state ? await cfg.kv.get(`pend:${state}`) : null;
    if (!raw) {
      // LOGGED, BECAUSE NOTHING ELSE RECORDS A FAILED SIGN-IN. Every
      // refusal below says the same vague thing to the browser on
      // purpose; without a matching log line the only account of what
      // went wrong is a student saying "it didn't work". The reason
      // names the STAGE, never the code or the verifier.
      await noteFailure(cfg.kv, "callback", `no pending flow for this state (state_present=${!!state}) — expired after 5 minutes, already used, or never started here`);
      return new Response("This sign-in link has expired. Start again from your assistant.", { status: 400 });
    }
    const pending = JSON.parse(raw) as Pending;

    // THE BROWSER THAT FINISHES MUST BE THE BROWSER THAT BEGAN.
    const presented = flowCookie(request);
    if (!presented || (await s256(presented)) !== pending.browser) {
      await noteFailure(
        cfg.kv,
        "callback",
        `browser binding failed (cookie_present=${!!presented}) — the browser finishing is not the one that started, or the cookie was dropped`,
      );
      await cfg.kv.delete(`pend:${state}`);
      return new Response("This sign-in could not be completed. Start again from your assistant.", { status: 400 });
    }

    if (!code) {
      await noteFailure(cfg.kv, "callback", "the provider returned no code — cancelled, or sign-in failed upstream");
      return new Response("Sign-in was cancelled or failed. Start again from your assistant.", { status: 400 });
    }

    // Both halves, or GoTrue refuses: "both auth code and code verifier
    // should be non-empty". The first version sent only the code.
    const exchanged = await fetch(`${cfg.supabase}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: cfg.anon },
      body: JSON.stringify({ auth_code: code, code_verifier: pending.supabase_verifier }),
    }).catch(() => null);
    const session = exchanged?.ok
      ? ((await exchanged.json()) as { access_token?: string; expires_in?: number })
      : null;
    if (!session?.access_token) {
      await noteFailure(cfg.kv, "callback", `supabase refused the code exchange (status=${exchanged?.status ?? "no response"})`);
      return new Response("Could not complete sign-in. Start again from your assistant.", { status: 502 });
    }

    // NO REFRESH TOKEN IS KEPT OR PASSED ON. One outlives the access
    // token the denylist holds, so handing one out made revocation
    // advisory: the holder exchanges it with Supabase directly and
    // returns with something we have never seen and cannot refuse. An
    // assistant re-runs the flow instead, which is the cost of
    // "disconnect" meaning what a student thinks it means.
    const ourCode = randomId(32);
    const issued: IssuedCode = {
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      access_token: session.access_token,
      expires_in: session.expires_in ?? 3600,
    };
    await cfg.kv.put(`code:${ourCode}`, JSON.stringify(issued), { expirationTtl: CODE_TTL });
    await cfg.kv.delete(`pend:${state}`);

    const back = new URL(pending.redirect_uri);
    back.searchParams.set("code", ourCode);
    if (pending.state) back.searchParams.set("state", pending.state);
    return new Response(null, {
      status: 302,
      headers: {
        location: back.toString(),
        // The flow is over; the cookie has nothing left to bind.
        "set-cookie": `${COOKIE}=; Path=/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  if (p === "/token" && request.method === "POST") {
    const cfg = config(env);
    if (!cfg) return NOT_CONFIGURED();
    const form = new URLSearchParams(await request.text());
    if (form.get("grant_type") !== "authorization_code") {
      return oauthError("unsupported_grant_type", "Only authorization_code is supported.");
    }

    const code = form.get("code") ?? "";
    const raw = code ? await cfg.kv.get(`code:${code}`) : null;
    if (!raw) {
      // THE ONE MOST LIKELY TO BE OURS RATHER THAN THE CALLER'S. The
      // code was written to KV by /callback moments earlier, possibly
      // in a different region from the one serving this request, and
      // KV writes take time to propagate. A code that was issued and
      // is already unreadable looks identical here to a replayed one.
      await noteFailure(
        cfg.kv,
        "token",
        `no record for this code (code_len=${code.length}) — already spent, expired after 60s, or the write has not propagated across regions`,
      );
      return oauthError("invalid_grant", "That code is not valid. It may already have been used.");
    }
    // SINGLE USE, deleted before anything else can go wrong.
    //
    // `delete`, not a short-lived tombstone: Cloudflare rejects a TTL
    // under 60 seconds, so `put(key, "", {expirationTtl: 1})` THREW —
    // the exchange 500ed and the code stayed spendable for its full
    // minute.
    await cfg.kv.delete(`code:${code}`);

    const issued = JSON.parse(raw) as IssuedCode;
    if (form.get("client_id") !== issued.client_id) {
      await noteFailure(cfg.kv, "token", "client_id does not match the one the code was issued to");
      return oauthError("invalid_grant", "That code was not issued to this client.");
    }
    if (form.get("redirect_uri") !== issued.redirect_uri) {
      await noteFailure(
        cfg.kv,
        "token",
        `redirect_uri mismatch (sent=${form.get("redirect_uri")}, issued_for=${issued.redirect_uri})`,
      );
      return oauthError("invalid_grant", "The redirect_uri does not match the one the code was issued for.");
    }

    // PKCE. Without this, a code intercepted on its way back through
    // the browser is enough to get the token.
    const verifier = form.get("code_verifier") ?? "";
    if (!verifier || (await s256(verifier)) !== issued.code_challenge) {
      await noteFailure(cfg.kv, "token", `PKCE verifier does not match (verifier_present=${!!verifier})`);
      return oauthError("invalid_grant", "The PKCE verifier does not match.");
    }

    return json({
      access_token: issued.access_token,
      token_type: "Bearer",
      expires_in: issued.expires_in,
    });
  }

  if (p === "/revoke" && request.method === "POST") {
    const cfg = config(env);
    if (!cfg) return NOT_CONFIGURED();
    const throttled = await throttleAnonymous(request, cfg.kv);
    if (throttled) return throttled;

    const form = new URLSearchParams(await request.text());
    const token = form.get("token") ?? "";

    // WHY A DENYLIST AND NOT A LOOKUP. The access token is a signed
    // statement with an expiry; nothing about revoking a Supabase
    // session reaches back and unsigns it. Without this, "I revoked
    // access" would mean "access ends within the hour", which is not
    // what a student pressing that button believes.
    //
    // Keyed by the token itself rather than by the student, so revoking
    // one assistant does not sign them out of another. Held only until
    // the token would have expired anyway.
    if (token) {
      await cfg.kv.put(`revoked:${await fingerprint(token)}`, "1", { expirationTtl: 60 * 60 * 25 });
    }

    // RFC 7009: always 200. Telling a caller whether a token existed is
    // telling them whether they guessed one.
    return json({}, 200);
  }

  return null;
}

/** A short stable id for a token, so the denylist holds no credentials.
 *
 * Storing the token itself would make a KV dump a bag of working
 * credentials. A hash answers the only question asked of it. */
export async function fingerprint(token: string): Promise<string> {
  return (await s256(token)).slice(0, 32);
}

/** Has this token been revoked? */
export async function isRevoked(env: OAuthEnv, token: string): Promise<boolean> {
  // FAILS CLOSED. Without the binding we cannot know whether this token
  // was revoked, and "we cannot tell" must not read as "it was not" —
  // every other check in this flow refuses when it is unsure, and this
  // was the one that did not.
  if (!env.OAUTH) return true;
  return (await env.OAUTH.get(`revoked:${await fingerprint(token)}`)) === "1";
}
