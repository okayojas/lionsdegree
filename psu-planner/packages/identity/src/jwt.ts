/** Verifying a Supabase access token.
 *
 * The only thing between an anonymous request and a named student's
 * Plan, so it is written to refuse rather than to accept: every path
 * that is not a complete, current, correctly-signed token returns null,
 * and the caller gets no way to tell the failures apart. A verifier that
 * explains WHY a token was rejected is a verifier that helps someone
 * iterate towards one that works.
 *
 * TWO WAYS A SUPABASE PROJECT SIGNS, and a deploy must handle the one
 * its project actually uses. Legacy projects sign HS256 with the shared
 * JWT secret. Projects on JWT signing keys sign ES256 (or RS256) with a
 * private key whose public half is published at the project's JWKS
 * endpoint — and the shared secret verifies none of those.
 *
 * THIS IS NOT THEORETICAL. The connector refused every real sign-in for
 * a day with "Authorization failed, check your credentials": the OAuth
 * flow completed perfectly, Supabase issued a perfectly good token, and
 * this function rejected it because the project had migrated to ES256
 * and the verifier only knew HS256.
 *
 * THE ALGORITHM IS STILL NEVER TAKEN FROM THE TOKEN. For HS256 it is
 * fixed here; for the asymmetric path it comes from the PUBLISHED KEY,
 * which the token's `kid` selects and whose own `alg` must match. A
 * token asking for `none`, or asking to be verified as HMAC against a
 * public key, is refused — which is the whole of the `alg: none` and
 * algorithm-confusion attacks.
 *
 * Web Crypto only: this runs in a Worker.
 */

export interface VerifiedIdentity {
  /** The Supabase user id. One token, one student. */
  sub: string;
  /** For a log line a human can read. Never used as an identifier —
   * emails change and are not unique over time; `sub` does not. */
  email?: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

export interface VerifyOptions {
  /** `SUPABASE_JWT_SECRET`, for a project still signing HS256. */
  secret?: string | undefined;
  /** The project's JWKS endpoint, for a project signing ES256 or RS256
   * — `https://<project>.supabase.co/auth/v1/.well-known/jwks.json`.
   *
   * Supply both and each token takes the path its own header names;
   * supply neither and nothing verifies, which is the correct
   * behaviour for a deploy that has configured nothing. */
  jwksUrl?: string | undefined;
  /** Injected so tests can serve a JWKS without a network. */
  fetch?: typeof fetch;
}

/** Published keys, remembered per isolate.
 *
 * Fetched rarely: a JWKS changes when a project rotates its signing
 * key, which is a human action, not a per-request event. An unknown
 * `kid` forces one refetch — that is what a rotation looks like from
 * here — and a second unknown `kid` is refused rather than becoming a
 * way to make this service fetch on demand. */
interface Jwks {
  keys: { kid?: string; alg?: string; kty?: string; crv?: string; use?: string }[];
}
let jwksCache: { url: string; at: number; keys: Jwks["keys"] } | null = null;
let lastForcedFetch = 0;
const JWKS_TTL_MS = 10 * 60 * 1000;
/** How often an unknown `kid` may force a refetch.
 *
 * A ROTATION IS RARE; A MADE-UP KID IS FREE. Without this, anyone can
 * send one token per second with a different `kid` and we fetch the
 * key set once per token — on their behalf, against Supabase, out of
 * this Worker's subrequest budget. Caught by its own test, which
 * asked for four made-up kids and counted five fetches.
 *
 * A minute is far below any plausible rotation and far above any
 * useful amplification. */
const FORCED_REFETCH_EVERY_MS = 60 * 1000;

/** Tests share an isolate; without this one test's key set leaks into
 * the next. */
export function resetJwksCache(): void {
  jwksCache = null;
  lastForcedFetch = 0;
}

/** The Web Crypto parameters for an algorithm we are willing to verify.
 *
 * AN ALLOWLIST, and `none` is not on it by construction. Nothing here
 * is derived from the token. */
const ASYMMETRIC: Record<string, { algorithm: EcKeyImportParams | RsaHashedImportParams; verify: AlgorithmIdentifier | EcdsaParams }> = {
  ES256: {
    algorithm: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
  RS256: {
    algorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
};

async function publishedKeys(opts: VerifyOptions, force = false): Promise<Jwks["keys"]> {
  const url = opts.jwksUrl!;
  const fresh = jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS;
  if (fresh && !force) return jwksCache!.keys;
  try {
    const res = await (opts.fetch ?? fetch)(url, { headers: { accept: "application/json" } });
    if (!res.ok) return fresh ? jwksCache!.keys : [];
    const body = (await res.json()) as Jwks;
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    jwksCache = { url, at: Date.now(), keys };
    return keys;
  } catch {
    // A fetch that failed is not a key set. Serve the cached one if we
    // have it rather than refusing every student over a blip; refuse
    // if we do not, because the alternative is accepting unverified
    // tokens.
    return fresh ? jwksCache!.keys : [];
  }
}

/** Verify against the project's published key, or return null. */
async function verifyAsymmetric(
  h: string, p: string, sig: string, alg: string, kid: string | undefined, opts: VerifyOptions,
): Promise<boolean> {
  const spec = ASYMMETRIC[alg];
  if (!spec || !opts.jwksUrl) return false;

  for (const force of [false, true]) {
    // A refetch for an unknown kid is throttled: see
    // FORCED_REFETCH_EVERY_MS. Skipping it here means an unknown kid
    // is simply refused, which is the right answer for a made-up one
    // and a one-minute delay for a genuine rotation.
    if (force && Date.now() - lastForcedFetch < FORCED_REFETCH_EVERY_MS) break;
    if (force) lastForcedFetch = Date.now();
    const keys = await publishedKeys(opts, force);
    // By `kid` when the token names one. A token with no `kid` against
    // a multi-key JWKS is ambiguous, and guessing is how a retired key
    // keeps working.
    const jwk = keys.find((k) => (kid ? k.kid === kid : keys.length === 1));
    if (!jwk) continue;

    // THE PUBLISHED KEY'S OWN ALGORITHM MUST AGREE. Taking the token's
    // word for it is the algorithm-confusion attack with extra steps.
    if (jwk.alg !== alg) return false;

    try {
      const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, spec.algorithm, false, ["verify"]);
      return await crypto.subtle.verify(
        spec.verify,
        key,
        b64urlToBytes(sig) as BufferSource,
        new TextEncoder().encode(`${h}.${p}`) as BufferSource,
      );
    } catch {
      return false;
    }
  }
  return false;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Verify a Supabase access token, however the project signs it.
 *
 * Nothing in the payload is trusted before the signature is checked —
 * including, especially, the header's own `alg`. */
export async function verifyJwt(token: string, opts: VerifyOptions): Promise<VerifiedIdentity | null> {
  // FAIL CLOSED. A deploy that configured neither a secret nor a key
  // set must not become a deploy that trusts everyone.
  if (!opts.secret && !opts.jwksUrl) return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    if (!h || !p || !sig) return null;

    // Read the header only to DISPATCH and to REFUSE. Neither branch
    // takes the token's word for anything: HS256 is verified with the
    // secret this deploy holds, and an asymmetric token is verified
    // with a PUBLISHED key whose own `alg` must agree. A token asking
    // for `none`, or asking to be checked as HMAC against a public
    // key, matches neither.
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as {
      alg?: string;
      kid?: string;
    };

    let good = false;
    if (header.alg === "HS256") {
      if (!opts.secret) return null;
      const key = await crypto.subtle.importKey(
        "raw",
        // `as BufferSource`: a `Uint8Array<ArrayBufferLike>` is not
        // assignable to `ArrayBufferView<ArrayBuffer>` under the DOM lib
        // the Workers builds use, and the bytes are identical either way.
        new TextEncoder().encode(opts.secret) as BufferSource,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      good = await crypto.subtle.verify(
        "HMAC",
        key,
        b64urlToBytes(sig) as BufferSource,
        new TextEncoder().encode(`${h}.${p}`) as BufferSource,
      );
    } else if (header.alg && ASYMMETRIC[header.alg]) {
      good = await verifyAsymmetric(h, p, sig, header.alg, header.kid, opts);
    }
    if (!good) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as {
      sub?: unknown;
      exp?: unknown;
      nbf?: unknown;
      aud?: unknown;
      email?: unknown;
      is_anonymous?: unknown;
    };

    // A SIGNATURE SAYS "FROM THIS PROJECT", NOT "A STUDENT WHO SIGNED
    // IN". One Supabase project signs more than one kind of token with
    // the same secret, so the audience is what separates a user session
    // from everything else minted alongside it.
    if (payload.aud !== "authenticated") return null;

    // Supabase can mint a session for someone who never signed in. Each
    // is a fresh `sub` — so a fresh rate-limit budget every time — and
    // none of them is a student with a Plan.
    if (payload.is_anonymous === true) return null;

    // An expiry is REQUIRED, not merely honoured when present. A token
    // with none cannot be outlived, so it cannot be revoked by waiting —
    // and Supabase always sets one, so its absence means this did not
    // come from where it claims to.
    if (typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 <= Date.now()) return null;

    // A token we have been told not to honour yet is not one to honour.
    if (typeof payload.nbf === "number" && payload.nbf * 1000 > Date.now()) return null;

    // Nothing to be and nothing to rate-limit on.
    if (typeof payload.sub !== "string" || !payload.sub) return null;

    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      expiresAt: payload.exp,
    };
  } catch {
    // Malformed base64, malformed JSON, a body that is not an object.
    // All the same answer: this is not a token we issued.
    return null;
  }
}
