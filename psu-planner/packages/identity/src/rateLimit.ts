/** How often one student may ask.
 *
 * PER IDENTITY, NEVER PER IP. Students share campus networks and
 * eduroam, so an IP limit throttles a building because one person was
 * busy. The caller must have established who is asking before it gets
 * here — which is why this takes an identity rather than a Request.
 *
 * Cloudflare KV in production, a bounded in-memory Map otherwise. KV is
 * best-effort atomic: two requests landing together can both read the
 * same counter. A Durable Object is the exact answer and is noted as
 * such; over-admitting by a request or two is the right failure for a
 * limit whose job is to stop one student exhausting the service, not to
 * meter billing.
 */

export interface KVLike {
  /** `cacheTtl` is in SECONDS with a minimum of 30. Zero is REJECTED —
   * see the read below for why that matters. */
  get(key: string, opts?: { cacheTtl?: number }): Promise<string | null>;
  /** `expirationTtl` is in SECONDS and Cloudflare enforces a minimum of
   * 60. Anything smaller is rejected outright — which is why deleting is
   * `delete`, below, and not a short-lived tombstone. */
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RateLimitResult {
  ok: boolean;
  /** What is left in this window, for the caller's headers. */
  remaining: number;
  /** Seconds until the window rolls, for `Retry-After`. */
  resetInSeconds: number;
}

/** Bounded so a long-lived isolate cannot grow one entry per student
 * seen, forever. Cleared wholesale rather than evicted cleverly: the
 * cost of a cleared counter is that somebody gets a few extra requests. */
const MAX_TRACKED = 10_000;
const counters = new Map<string, { day: string; n: number }>();

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

function secondsUntilUtcMidnight(now: number): number {
  const next = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - now) / 1000));
}

export async function rateLimit(
  kv: KVLike | undefined,
  identity: string,
  limit: number,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const day = dayOf(now);
  const resetInSeconds = secondsUntilUtcMidnight(now);

  if (kv) {
    const key = `rl:${day}:${identity}`;
    // NO `cacheTtl`. This read used to pass `{ cacheTtl: 0 }`, meaning
    // "do not serve me a cached value" — and Cloudflare REJECTS any
    // cache TTL below 30, so every KV-backed read threw: "Invalid
    // cache_ttl of 0. Cache TTL must be at least 30." The limiter did
    // not merely run loose, it failed outright, and in the connector it
    // took the whole request down with it.
    //
    // The default edge cache is 60 seconds, so a burst inside that
    // window can read the same number more than once and over-admit.
    // That is the honest cost: this limit exists to stop one student
    // exhausting the service, not to meter anybody, and a Durable
    // Object is the exact answer when exactness is wanted.
    const n = parseInt((await kv.get(key)) ?? "0", 10) || 0;
    if (n >= limit) return { ok: false, remaining: 0, resetInSeconds };
    await kv.put(key, String(n + 1), { expirationTtl: 60 * 60 * 26 });
    return { ok: true, remaining: limit - n - 1, resetInSeconds };
  }

  if (counters.size > MAX_TRACKED) counters.clear();
  const held = counters.get(identity);
  const n = held?.day === day ? held.n : 0;
  if (n >= limit) return { ok: false, remaining: 0, resetInSeconds };
  counters.set(identity, { day, n: n + 1 });
  return { ok: true, remaining: limit - n - 1, resetInSeconds };
}

/** For tests, which must not inherit a previous one's counters. */
export function resetInMemoryCounters(): void {
  counters.clear();
}
