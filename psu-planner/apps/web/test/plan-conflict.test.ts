/** What happens when two copies of a Plan are edited at once.
 *
 * THE FAILURE THIS GUARDS. Two tabs, both at rev 5, both save. The old
 * code compared timestamps in the browser and then wrote unconditionally,
 * so the second write won and the first student's edit was gone with
 * nothing said anywhere. Silent loss of a student's work is the worst
 * thing this app can do, and it was a live bug with no connector involved.
 *
 * The database refuses the stale write now (migration 0003). These tests
 * cover the half that lives in the browser: recognising that refusal and
 * turning it into something a student can act on, rather than a console
 * error nobody sees.
 *
 * Pure functions, no Supabase client — the same seam `sync-redirect.test.ts`
 * uses, and for the same reason: the interesting logic should be reachable
 * without a network.
 */
import { describe, it, expect } from "vitest";
import { isStaleRevError, conflictMessage, STALE_REV_CODE } from "../src/data/sync";

describe("recognising the database's refusal", () => {
  it("knows the stale-write error by its SQLSTATE", () => {
    // The code is the contract between migration 0003 and this client.
    // Matching on the message text would break the first time the wording
    // is improved.
    expect(isStaleRevError({ code: STALE_REV_CODE, message: "stale plan write: …" })).toBe(true);
  });

  it("does not mistake other failures for a conflict", () => {
    // Treating a network blip or a permission error as "someone else
    // edited this" would tell the student a specific, false story about
    // their own data — worse than saying nothing.
    for (const other of [
      { code: "PGRST301", message: "JWT expired" },
      { code: "23505", message: "duplicate key value violates unique constraint" },
      { code: "42501", message: "new row violates row-level security policy" },
      { message: "Failed to fetch" },
      {},
    ]) {
      expect(isStaleRevError(other), `${JSON.stringify(other)} was read as a conflict`).toBe(false);
    }
  });

  it("is not fooled by a null or undefined error", () => {
    // `error` is null on success, and this is called on every push.
    expect(isStaleRevError(null)).toBe(false);
    expect(isStaleRevError(undefined)).toBe(false);
  });
});

describe("what the student is told", () => {
  it("says their work is safe and names the one action", () => {
    // The message a student reads at the moment they would otherwise
    // assume they just lost an edit. It has to say three things: that the
    // save did not happen, that nothing was destroyed, and what to do.
    const msg = conflictMessage();
    expect(msg).toMatch(/not saved|could not be saved|wasn't saved/i);
    // "safe on this device" rather than "saved on this device": the thing
    // that just happened is a failed save, so reusing the word invites
    // exactly the misreading this sentence exists to prevent.
    expect(msg, "does not say the local copy survived").toMatch(/kept|safe on this device|backed up/i);
    expect(msg, "does not tell the student what to do").toMatch(/reload|refresh|load the newer/i);
    // And points at something they can open. "Your version is safe"
    // without a door is a reassurance, not a recovery path.
    expect(msg, "does not say where the kept copy can be found").toMatch(/plan history/i);
  });

  it("blames nobody and mentions no revision numbers", () => {
    // "rev 5 vs rev 6" is a fact about our schema, not about their degree.
    const msg = conflictMessage();
    expect(msg).not.toMatch(/\brev\b|revision \d|LD001|conflict/i);
  });
});
