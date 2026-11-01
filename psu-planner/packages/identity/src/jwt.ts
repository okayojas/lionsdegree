/** Verifying a Supabase access token.
 *
 * The only thing between an anonymous request and a named student's
 * Plan, so it is written to refuse rather than to accept: every path
 * that is not a complete, current, correctly-signed token returns null,
 * and the caller gets no way to tell the failures apart. A verifier that
 * explains WHY a token was rejected is a verifier that helps someone
 * iterate towards one that works.
 *
 * HS256 only. Supabase legacy projects sign with the shared JWT secret,
 * and the algorithm is CHOSEN HERE rather than read from the token —
 * which is the whole of the `alg: none` and algorithm-confusion attacks.
 * A project on asymmetric keys needs a JWKS path added deliberately, not
 * a header field trusted.
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
  /** `SUPABASE_JWT_SECRET`. Absent means the gate is not configured, and
   * an unconfigured gate refuses everything rather than trusting it. */
  secret: string | undefined;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Verify a Supabase HS256 token, or return null.
 *
 * Nothing in the payload is trusted before the signature is checked —
 * including, especially, the header's own `alg`. */
export async function verifyJwt(token: string, opts: VerifyOptions): Promise<VerifiedIdentity | null> {
  // FAIL CLOSED. A deploy that forgot the secret must not become a
  // deploy that trusts everyone.
  if (!opts.secret) return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    if (!h || !p || !sig) return null;

    // Read the header only to REFUSE on it. The algorithm we verify with
    // is fixed below, so a token asking for `none` or for RS256 is
    // rejected rather than honoured — the two attacks that turn a
    // verifier into a rubber stamp.
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { alg?: string };
    if (header.alg !== "HS256") return null;

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
    const good = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(sig) as BufferSource,
      new TextEncoder().encode(`${h}.${p}`) as BufferSource,
    );
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
