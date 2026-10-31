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
 * uses. There is no second identity system to keep in step, no second
 * place a student's session can be stale, and nothing new to rotate.
 *
 * WHAT IS STORED, and for how long:
 *   client:<id>   a registered assistant's name and redirect URIs.
 *   code:<code>   one authorization code, with the PKCE challenge and
 *                 the Supabase session it stands for. Sixty seconds,
 *                 single use.
 *   pend:<state>  a flow in progress while the student is at Google.
 *                 Ten minutes.
 *
 * Nothing here holds a student's Plan, and the session it stores is
 * deleted the moment it is exchanged.
 */
import type { KVLike } from "@psu-planner/identity";

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
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier) as BufferSource);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
  code_challenge: string;
  state?: string;
}

interface IssuedCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

const CODE_TTL = 60;
const PENDING_TTL = 600;

/** Handle an OAuth route, or return null if this is not one.
 *
 * Returning null rather than 404ing lets the Worker keep one router and
 * keeps every "is this an auth path" decision in this file. */
export async function handleOAuth(request: Request, env: OAuthEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;
  const p = url.pathname;

  if (p === "/.well-known/oauth-protected-resource") {
    if (!config(env)) return NOT_CONFIGURED();
    // What a 401's `WWW-Authenticate` points at: this resource, and who
    // can issue tokens for it.
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
    let body: { client_name?: unknown; redirect_uris?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return oauthError("invalid_client_metadata", "The registration body is not JSON.");
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (!uris.length) {
      return oauthError("invalid_redirect_uri", "At least one redirect_uri is required.");
    }
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

    // The student goes to Supabase, which takes them to Google or
    // Microsoft. We never see a password and never ask for one.
    const state = randomId(24);
    const pending: Pending = { client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, state: q.get("state") ?? undefined };
    await cfg.kv.put(`pend:${state}`, JSON.stringify(pending), { expirationTtl: PENDING_TTL });

    const provider = q.get("provider") === "azure" ? "azure" : "google";
    const to = new URL(`${cfg.supabase}/auth/v1/authorize`);
    to.searchParams.set("provider", provider);
    to.searchParams.set("redirect_to", `${issuer}/callback?state=${encodeURIComponent(state)}`);
    return Response.redirect(to.toString(), 302);
  }

  if (p === "/callback") {
    const cfg = config(env);
    if (!cfg) return NOT_CONFIGURED();
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const raw = state ? await cfg.kv.get(`pend:${state}`) : null;
    if (!raw) {
      return new Response("This sign-in link has expired. Start again from your assistant.", { status: 400 });
    }
    const pending = JSON.parse(raw) as Pending;
    if (!code) {
      return new Response("Sign-in was cancelled or failed. Start again from your assistant.", { status: 400 });
    }

    // Exchange Supabase's code for the student's session. The anon key
    // is public by design and ships in the website's bundle.
    const exchanged = await fetch(`${cfg.supabase}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: cfg.anon },
      body: JSON.stringify({ auth_code: code }),
    }).catch(() => null);
    const session = exchanged?.ok ? ((await exchanged.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }) : null;
    if (!session?.access_token) {
      console.error("[mcp] supabase code exchange failed", exchanged?.status);
      return new Response("Could not complete sign-in. Start again from your assistant.", { status: 502 });
    }

    // Our own code, bound to the assistant's PKCE challenge. Sixty
    // seconds and single use: it is a bearer credential in a URL, which
    // is where credentials end up in logs and shoulder-surfing range.
    const ourCode = randomId(32);
    const issued: IssuedCode = {
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in ?? 3600,
    };
    await cfg.kv.put(`code:${ourCode}`, JSON.stringify(issued), { expirationTtl: CODE_TTL });
    await cfg.kv.put(`pend:${state}`, "", { expirationTtl: 1 });

    const back = new URL(pending.redirect_uri);
    back.searchParams.set("code", ourCode);
    if (pending.state) back.searchParams.set("state", pending.state);
    return Response.redirect(back.toString(), 302);
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
    if (!raw) return oauthError("invalid_grant", "That code is not valid. It may already have been used.");
    // SINGLE USE, deleted before anything else can go wrong. A code that
    // survives its exchange is a code that can be replayed.
    await cfg.kv.put(`code:${code}`, "", { expirationTtl: 1 });

    const issued = JSON.parse(raw) as IssuedCode;
    if (form.get("client_id") !== issued.client_id) {
      return oauthError("invalid_grant", "That code was not issued to this client.");
    }
    if (form.get("redirect_uri") !== issued.redirect_uri) {
      return oauthError("invalid_grant", "The redirect_uri does not match the one the code was issued for.");
    }

    // PKCE. Without this, a code intercepted on its way back through
    // the browser is enough to get the token.
    const verifier = form.get("code_verifier") ?? "";
    if (!verifier || (await s256(verifier)) !== issued.code_challenge) {
      return oauthError("invalid_grant", "The PKCE verifier does not match.");
    }

    return json({
      access_token: issued.access_token,
      token_type: "Bearer",
      expires_in: issued.expires_in,
      refresh_token: issued.refresh_token,
    });
  }

  if (p === "/revoke" && request.method === "POST") {
    const cfg = config(env);
    if (!cfg) return NOT_CONFIGURED();
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
    // the token would have expired anyway — after that the signature
    // check refuses it and the entry is dead weight.
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
 * Storing the token itself would mean a KV dump is a bag of working
 * credentials. A hash answers the only question asked of it. */
export async function fingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token) as BufferSource);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 32);
}

/** Has this token been revoked? */
export async function isRevoked(env: OAuthEnv, token: string): Promise<boolean> {
  if (!env.OAUTH) return false;
  return (await env.OAUTH.get(`revoked:${await fingerprint(token)}`)) === "1";
}
