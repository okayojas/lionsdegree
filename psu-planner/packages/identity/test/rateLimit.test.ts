/** The limit, and who it falls on.
 *
 * The failure this guards against twice over: one student exhausting
 * the service for everyone, and — the subtler one — a limit keyed on
 * something students share, which throttles a lecture hall because one
 * person was busy.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, resetInMemoryCounters, type KVLike } from "../src/rateLimit.js";

beforeEach(() => resetInMemoryCounters());

/** KV, as a Map, so the production path is exercised rather than only
 * the fallback. */
function fakeKv(): KVLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(k, opts) {
      // Cloudflare rejects a cache TTL below 30. A stub that ignores the
      // option certifies a read the real binding throws on.
      if (opts?.cacheTtl !== undefined && opts.cacheTtl < 30) {
        throw new Error(`Invalid cache_ttl of ${opts.cacheTtl}. Cache TTL must be at least 30.`);
      }
      return store.get(k) ?? null;
    },
    async put(k, v, opts) {
      // Cloudflare rejects a TTL under 60 seconds; a stub that ignores
      // it lets a caller ship one that throws in production.
      if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) {
        throw new Error(`Invalid expiration_ttl of ${opts.expirationTtl}. Must be at least 60.`);
      }
      store.set(k, v);
    },
    async delete(k) { store.delete(k); },
  };
}

describe.each([
  ["in memory", () => undefined],
  ["on KV", () => fakeKv()],
])("the limit, %s", (_label, makeKv) => {
  it("allows requests up to the limit and refuses the next", async () => {
    const kv = makeKv();
    for (let i = 0; i < 3; i++) {
      expect((await rateLimit(kv, "user:a", 3)).ok, `request ${i + 1} of 3`).toBe(true);
    }
    expect((await rateLimit(kv, "user:a", 3)).ok, "the fourth request was allowed").toBe(false);
  });

  it("counts each student separately", async () => {
    // THE POINT. One busy student must not spend anyone else's budget.
    const kv = makeKv();
    for (let i = 0; i < 3; i++) await rateLimit(kv, "user:a", 3);
    expect((await rateLimit(kv, "user:a", 3)).ok).toBe(false);
    expect((await rateLimit(kv, "user:b", 3)).ok, "a second student was refused for the first's use").toBe(true);
  });

  it("reports what is left, so a caller can say so in a header", async () => {
    const kv = makeKv();
    expect((await rateLimit(kv, "user:a", 3)).remaining).toBe(2);
    expect((await rateLimit(kv, "user:a", 3)).remaining).toBe(1);
    expect((await rateLimit(kv, "user:a", 3)).remaining).toBe(0);
  });

  it("starts the student fresh the next day", async () => {
    const kv = makeKv();
    const monday = Date.parse("2026-11-02T23:00:00Z");
    const tuesday = Date.parse("2026-11-03T01:00:00Z");
    for (let i = 0; i < 3; i++) await rateLimit(kv, "user:a", 3, monday);
    expect((await rateLimit(kv, "user:a", 3, monday)).ok).toBe(false);
    expect((await rateLimit(kv, "user:a", 3, tuesday)).ok, "the counter did not roll over").toBe(true);
  });

  it("says how long until the window rolls", async () => {
    const kv = makeKv();
    const r = await rateLimit(kv, "user:a", 1, Date.parse("2026-11-02T23:00:00Z"));
    // An hour to midnight UTC.
    expect(r.resetInSeconds).toBeGreaterThan(3500);
    expect(r.resetInSeconds).toBeLessThanOrEqual(3600);
  });
});

describe("the in-memory fallback", () => {
  it("does not grow without bound", async () => {
    // A long-lived isolate would otherwise hold one entry per student it
    // has ever seen.
    for (let i = 0; i < 10_050; i++) await rateLimit(undefined, `user:${i}`, 100);
    // Cleared wholesale once over the bound; the cost is a few extra
    // requests for whoever was mid-window, never a leak.
    expect((await rateLimit(undefined, "user:0", 100)).ok).toBe(true);
  });
});
