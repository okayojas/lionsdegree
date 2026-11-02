/** Verifying tokens from a project that signs with a published key.
 *
 * WHY THIS EXISTS, and it is not hypothetical. The hosted connector
 * refused every real sign-in for a day with "Authorization failed —
 * check your credentials". The OAuth flow completed perfectly,
 * Supabase issued a perfectly good token, and the verifier rejected it
 * because the project had migrated to JWT signing keys while the
 * verifier only knew the legacy shared secret.
 *
 * Nothing logged it, and that was correct: from the gate's side, a
 * token signed by a key it cannot check is indistinguishable from a
 * forgery. Which is exactly why it took a day to find, and why the
 * asymmetric path needs the same adversarial treatment as the first
 * one rather than a happy-path test.
 *
 * Real ES256 keys, really generated, really signing. A fixture can
 * only prove the verifier accepts what its author imagined.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetJwksCache, verifyJwt, type VerifyOptions } from "../src/jwt.js";

const JWKS_URL = "https://project.supabase.co/auth/v1/.well-known/jwks.json";
const KID = "test-key-1";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encode = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const anHourAgo = () => Math.floor(Date.now() / 1000) - 3600;

const ecdsa = () =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

async function signWith(
  key: CryptoKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "ES256", typ: "JWT", kid: KID },
): Promise<string> {
  const body = `${encode(header)}.${encode(payload)}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(body)),
  );
  return `${body}.${b64url(sig)}`;
}

let pair: CryptoKeyPair;
// `kid`/`alg`/`use` are JWKS fields TypeScript's JsonWebKey does not model.
let jwks: { keys: Record<string, unknown>[] };

const served = (): VerifyOptions => ({
  jwksUrl: JWKS_URL,
  fetch: (async () => Response.json(jwks)) as typeof fetch,
});

const aStudent = () => ({ sub: "user-1", aud: "authenticated", exp: inAnHour(), email: "s@psu.edu" });

beforeEach(async () => {
  resetJwksCache();
  pair = await ecdsa();
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwks = { keys: [{ ...(pub as Record<string, unknown>), kid: KID, alg: "ES256", use: "sig" }] };
});

describe("a token the project really signed", () => {
  it("is accepted", async () => {
    const id = await verifyJwt(await signWith(pair.privateKey, aStudent()), served());
    expect(id?.sub, "a genuine ES256 token was refused — this is the production bug").toBe("user-1");
    expect(id?.email).toBe("s@psu.edu");
  });

  it("is still subject to every claim rule the HS256 path applies", async () => {
    // A second signing path is a second chance to forget the checks
    // that make a signature mean "a student signed in" rather than
    // "this came from the project".
    const o = served();
    const refused = async (payload: Record<string, unknown>, why: string) =>
      expect(await verifyJwt(await signWith(pair.privateKey, payload), o), why).toBeNull();

    await refused({ sub: "u", aud: "service", exp: inAnHour() }, "wrong audience");
    await refused({ sub: "u", exp: inAnHour() }, "no audience");
    await refused({ sub: "u", aud: "authenticated" }, "no expiry");
    await refused({ sub: "u", aud: "authenticated", exp: anHourAgo() }, "expired");
    await refused({ aud: "authenticated", exp: inAnHour() }, "no subject");
    await refused({ sub: "u", aud: "authenticated", is_anonymous: true, exp: inAnHour() }, "anonymous sign-in");
    await refused({ sub: "u", aud: "authenticated", nbf: inAnHour(), exp: inAnHour() + 60 }, "not valid yet");
  });
});

describe("a token the project did not sign", () => {
  it("signed with somebody else's key is refused", async () => {
    // The whole point: anyone can generate a P-256 key pair.
    const theirs = await ecdsa();
    expect(await verifyJwt(await signWith(theirs.privateKey, aStudent()), served())).toBeNull();
  });

  it("naming a kid the project does not publish is refused", async () => {
    const t = await signWith(pair.privateKey, aStudent(), { alg: "ES256", typ: "JWT", kid: "not-published" });
    expect(await verifyJwt(t, served())).toBeNull();
  });

  it("CLAIMING AN ALGORITHM THE KEY DOES NOT HAVE is refused", async () => {
    // Algorithm confusion in its asymmetric form: the token says
    // RS256, the published key is an ES256 EC key. A verifier that
    // honours the token's claim can be talked into the wrong
    // primitive. THE KEY DECIDES, never the token.
    const t = await signWith(pair.privateKey, aStudent(), { alg: "RS256", typ: "JWT", kid: KID });
    expect(await verifyJwt(t, served())).toBeNull();
  });

  it("claiming alg:none is refused even with a key set configured", async () => {
    const unsigned = `${encode({ alg: "none", typ: "JWT", kid: KID })}.${encode(aStudent())}.`;
    expect(await verifyJwt(unsigned, served())).toBeNull();
  });

  it("with the payload edited after signing is refused", async () => {
    const t = await signWith(pair.privateKey, aStudent());
    const [h, , sig] = t.split(".");
    expect(await verifyJwt(`${h}.${encode({ ...aStudent(), sub: "somebody-else" })}.${sig}`, served())).toBeNull();
  });

  it("is refused when the key set names a different algorithm than it serves", async () => {
    // A JWKS entry whose `alg` disagrees with the key material is not
    // something to reconcile — it is something to refuse.
    jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", pair.publicKey) as Record<string, unknown>), kid: KID, alg: "RS256" }] };
    expect(await verifyJwt(await signWith(pair.privateKey, aStudent()), served())).toBeNull();
  });
});

describe("when the key set cannot be read", () => {
  it("refuses everything rather than skipping the signature", async () => {
    // FAIL CLOSED. An unreachable JWKS is not permission to trust.
    const id = await verifyJwt(await signWith(pair.privateKey, aStudent()), {
      jwksUrl: JWKS_URL,
      fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });
    expect(id).toBeNull();
  });

  it("refuses when the fetch itself throws", async () => {
    const id = await verifyJwt(await signWith(pair.privateKey, aStudent()), {
      jwksUrl: JWKS_URL,
      fetch: (async () => { throw new Error("network"); }) as typeof fetch,
    });
    expect(id).toBeNull();
  });

  it("keeps working on a blip once it has the keys", async () => {
    // Refusing every student because one fetch failed would turn a
    // momentary network problem into an outage. A cached key set is
    // still a verified signature.
    let calls = 0;
    const flaky: VerifyOptions = {
      jwksUrl: JWKS_URL,
      fetch: (async () => {
        calls++;
        return calls === 1 ? Response.json(jwks) : new Response("down", { status: 503 });
      }) as typeof fetch,
    };
    expect((await verifyJwt(await signWith(pair.privateKey, aStudent()), flaky))?.sub).toBe("user-1");
    resetJwksCacheIsNotCalledHere();
    expect(
      (await verifyJwt(await signWith(pair.privateKey, aStudent()), flaky))?.sub,
      "a cached key set was discarded on a blip",
    ).toBe("user-1");
  });

  /** Reads as a comment at the call site: the cache is deliberately
   * NOT reset between those two calls. */
  function resetJwksCacheIsNotCalledHere(): void {}
});

describe("how often the key set is fetched", () => {
  it("once, not per request", async () => {
    // Every tool call carries a token. A JWKS fetch per call puts a
    // network round trip in front of every answer a student gets.
    let fetches = 0;
    const counting: VerifyOptions = {
      jwksUrl: JWKS_URL,
      fetch: (async () => { fetches++; return Response.json(jwks); }) as typeof fetch,
    };
    for (let i = 0; i < 5; i++) await verifyJwt(await signWith(pair.privateKey, aStudent()), counting);
    expect(fetches, "the key set was refetched for every request").toBe(1);
  });

  it("again when a kid it has never seen appears", async () => {
    // What a key rotation looks like from here. Without this, a
    // rotation locks every student out until the cache expires.
    let fetches = 0;
    const rotating: VerifyOptions = {
      jwksUrl: JWKS_URL,
      fetch: (async () => { fetches++; return Response.json(jwks); }) as typeof fetch,
    };
    await verifyJwt(await signWith(pair.privateKey, aStudent()), rotating);
    expect(fetches).toBe(1);

    const rotated = await ecdsa();
    jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", rotated.publicKey) as Record<string, unknown>), kid: "rotated", alg: "ES256" }] };
    const id = await verifyJwt(
      await signWith(rotated.privateKey, aStudent(), { alg: "ES256", typ: "JWT", kid: "rotated" }),
      rotating,
    );
    expect(fetches, "an unknown kid did not prompt a refetch").toBe(2);
    expect(id?.sub, "a rotated key locked the student out").toBe("user-1");
  });

  it("does not refetch forever for a kid that will never exist", async () => {
    // Otherwise an attacker invents a kid per request and we fetch a
    // JWKS per request on their behalf.
    let fetches = 0;
    const counting: VerifyOptions = {
      jwksUrl: JWKS_URL,
      fetch: (async () => { fetches++; return Response.json(jwks); }) as typeof fetch,
    };
    for (let i = 0; i < 4; i++) {
      await verifyJwt(
        await signWith(pair.privateKey, aStudent(), { alg: "ES256", typ: "JWT", kid: `made-up-${i}` }),
        counting,
      );
    }
    expect(fetches, "a made-up kid buys an unbounded number of fetches").toBeLessThanOrEqual(4);
  });
});

describe("a deploy configured for neither", () => {
  it("refuses everything", async () => {
    expect(await verifyJwt(await signWith(pair.privateKey, aStudent()), {})).toBeNull();
  });
});
