/** The signature check, from the attacker's side.
 *
 * This is the only thing between an anonymous request and a named
 * student's degree. Every case below is a way someone might try to be
 * somebody else, and the happy path is the least interesting one here.
 *
 * Real tokens, really signed, with Web Crypto — not fixtures. A fixture
 * can only prove the verifier accepts what the test author believed a
 * token looks like.
 */
import { describe, it, expect } from "vitest";
import { verifyJwt, type VerifiedIdentity } from "../src/jwt.js";

const SECRET = "a-test-secret-not-the-real-one";
const OTHER = "a-different-secret-entirely";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encode = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** Sign a real HS256 token the way Supabase does. */
async function sign(
  payload: Record<string, unknown>,
  secret = SECRET,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): Promise<string> {
  const body = `${encode(header)}.${encode(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const anHourAgo = () => Math.floor(Date.now() / 1000) - 3600;

const ok = async (t: string): Promise<VerifiedIdentity | null> => verifyJwt(t, { secret: SECRET });

describe("a token we issued", () => {
  it("is accepted and names exactly one student", async () => {
    const id = await ok(await sign({ sub: "user-123", exp: inAnHour(), email: "s@psu.edu" }));
    expect(id?.sub).toBe("user-123");
  });

  it("carries the email through, for a log line a human can read", async () => {
    const id = await ok(await sign({ sub: "user-123", exp: inAnHour(), email: "s@psu.edu" }));
    expect(id?.email).toBe("s@psu.edu");
  });
});

describe("a token we did not issue", () => {
  it("signed with another secret is refused", async () => {
    expect(await ok(await sign({ sub: "user-123", exp: inAnHour() }, OTHER))).toBeNull();
  });

  it("with the signature stripped is refused", async () => {
    const [h, p] = (await sign({ sub: "user-123", exp: inAnHour() })).split(".");
    expect(await ok(`${h}.${p}.`)).toBeNull();
  });

  it("with the payload edited after signing is refused", async () => {
    // The attack this exists for: take your own valid token and change
    // `sub` to somebody else's.
    const token = await sign({ sub: "user-123", exp: inAnHour() });
    const [h, , sig] = token.split(".");
    const forged = `${h}.${encode({ sub: "somebody-else", exp: inAnHour() })}.${sig}`;
    expect(await ok(forged)).toBeNull();
  });

  it("claiming alg:none is refused", async () => {
    // The classic. A verifier that reads `alg` from the token and obeys
    // it will happily skip the check it exists to perform.
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: "user-123", exp: inAnHour() })}.`;
    expect(await ok(unsigned)).toBeNull();
  });

  it("claiming an asymmetric alg is refused, not verified as HMAC", async () => {
    // The algorithm-confusion attack: present an RS256 header so a naive
    // verifier treats the PUBLIC key as an HMAC secret.
    const t = await sign({ sub: "user-123", exp: inAnHour() }, SECRET, { alg: "RS256", typ: "JWT" });
    expect(await ok(t)).toBeNull();
  });

  it("that has expired is refused", async () => {
    expect(await ok(await sign({ sub: "user-123", exp: anHourAgo() }))).toBeNull();
  });

  it("with no expiry at all is refused", async () => {
    // A token that never expires cannot be revoked by waiting, and
    // Supabase always sets one — so its absence means this is not a
    // token we issued.
    expect(await ok(await sign({ sub: "user-123" }))).toBeNull();
  });

  it("with no subject is refused", async () => {
    // Nothing to rate-limit on and nobody to be.
    expect(await ok(await sign({ exp: inAnHour() }))).toBeNull();
  });

  it("that is not a token at all is refused without throwing", async () => {
    for (const junk of ["", "not.a.token", "a.b", "....", "null", "{}", "Bearer x", "a".repeat(10_000)]) {
      expect(await ok(junk), `${junk.slice(0, 20)} was accepted`).toBeNull();
    }
  });

  it("is refused when no secret is configured, rather than accepted", async () => {
    // FAIL CLOSED. A deploy that forgot the secret must not become a
    // deploy that trusts everyone.
    expect(await verifyJwt(await sign({ sub: "user-123", exp: inAnHour() }), { secret: "" })).toBeNull();
    expect(await verifyJwt(await sign({ sub: "user-123", exp: inAnHour() }), { secret: undefined })).toBeNull();
  });
});

describe("expiry at the boundary", () => {
  it("accepts a token expiring in a moment", async () => {
    const id = await ok(await sign({ sub: "user-123", exp: Math.floor(Date.now() / 1000) + 5 }));
    expect(id?.sub).toBe("user-123");
  });

  it("refuses one that expired a moment ago", async () => {
    expect(await ok(await sign({ sub: "user-123", exp: Math.floor(Date.now() / 1000) - 5 }))).toBeNull();
  });
});
