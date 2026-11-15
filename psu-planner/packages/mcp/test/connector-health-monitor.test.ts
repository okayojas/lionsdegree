/** The thing that reads /health and decides whether to wake somebody (#58).
 *
 * The Worker already checks itself every fifteen minutes and writes down
 * what it found. Nobody reads it. These tests are for the reader.
 */
import { describe, it, expect } from "vitest";
import { judge, check } from "../scripts/check-connector-health.mjs";

const NOW = Date.parse("2026-11-15T18:20:00.000Z");

/** The body `https://mcp.lionsdegree.com/health` actually returned, copied
 * from a live request on 2026-11-15. */
const LIVE = {
  ok: true,
  edition: "2026-2027",
  courses: 14615,
  last_self_check: { recorded: true, ok: true, at: "2026-11-15T18:15:18.990Z" },
};

const reached = (body: unknown, status = 200) => ({
  reached: true as const,
  status,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("judging a /health body", () => {
  it("passes a connector that is answering", () => {
    expect(judge(reached(LIVE), NOW).ok).toBe(true);
  });

  it("FAILS A 200 THAT SAYS ok:false", () => {
    // The whole reason this is a script and not `curl -f`. A check that
    // reads the status code and stops is the check #58 exists to replace.
    const verdict = judge(reached({ ...LIVE, ok: false, not_serving: "the connector is refusing every request" }), NOW);
    expect(verdict.ok, "a connector refusing every student was passed because the HTTP code was fine").toBe(false);
    expect(verdict.kind).toBe("unhealthy");
  });

  it("fails a non-200, and still says what the body said", () => {
    // /health answers 503 when the connector is not serving, so this is
    // the same outage arriving by the other door. The status code is not
    // the verdict, but it is not ignored either: a 500 with no usable
    // body must not pass on the strength of an unparsed page.
    const verdict = judge(reached({ ok: false }, 503), NOW);
    expect(verdict.ok).toBe(false);
    expect(verdict.summary, "the operator is told nothing about the status code").toMatch(/503/);
  });

  it("fails a non-200 even when the body looks perfectly healthy", () => {
    // Cloudflare's own error pages are HTML, but an intermediary can
    // cache or rewrite a body, and a Worker can be replaced by something
    // that answers 500 with yesterday's JSON. "The code is wrong" is a
    // thing nobody here has thought about, which is a failure.
    expect(judge(reached(LIVE, 502), NOW).ok, "a 502 was passed because its body parsed").toBe(false);
  });
});

/** A /health body whose stored report is `minutes` old at NOW. */
const aged = (minutes: number, rest: Record<string, unknown> = {}) =>
  reached({
    ...LIVE,
    last_self_check: { recorded: true, ok: true, at: new Date(NOW - minutes * 60_000).toISOString(), ...rest },
  });

describe("a self-check that has stopped advancing", () => {
  it("passes a report from within the last cron period", () => {
    // The guard against the opposite bug: a staleness check that is
    // always red is a check nobody will leave switched on.
    expect(judge(aged(14), NOW).ok, "a report fourteen minutes old was called stale").toBe(true);
  });

  it("still passes at forty-four minutes, because Cloudflare skips runs", () => {
    // Cron on Workers is best-effort. One missed run is weather; this
    // must not page for it.
    expect(judge(aged(44), NOW).ok).toBe(true);
  });

  it("FAILS at forty-six minutes — three periods with no report is a dead cron", () => {
    const verdict = judge(aged(46), NOW);
    expect(verdict.ok, "a cron that has not run in three quarters of an hour was passed").toBe(false);
    expect(verdict.kind).toBe("stale");
    expect(verdict.summary, "the operator is not told how old the report is").toMatch(/46|minute/);
  });

  it("fails a timestamp that is not a date, rather than reading it as very old or very new", () => {
    // Iron rule 2 (DECISIONS.md): unparseable degrades to "cannot be
    // checked", never to "fine". `Date.parse` of rubbish is NaN, and
    // every comparison against NaN is false — so the naive version of
    // this check passes everything it cannot read.
    const verdict = judge(reached({ ...LIVE, last_self_check: { recorded: true, ok: true, at: "soon" } }), NOW);
    expect(verdict.ok, "an unreadable timestamp was treated as fresh").toBe(false);
    expect(verdict.kind).toBe("unreadable");
  });

  it("fails a timestamp from the future, because one of the two clocks is wrong", () => {
    // Not pedantry: a report dated ahead of now can never go stale, so
    // this is the one input that disables the staleness check entirely.
    expect(judge(aged(-30), NOW).ok, "a report dated half an hour from now was accepted").toBe(false);
  });
});

describe("what the stored report itself says", () => {
  it("FAILS WHEN THE LIVE CHECK IS GREEN AND THE STORED ONE IS NOT", () => {
    // THE CASE THAT ANSWERS 200. /health's status code tracks the live
    // probe only — by design, so a resolved failure does not page at
    // three in the morning. A cron that has been failing every fifteen
    // minutes since is therefore invisible to anything watching the
    // code, and this is the only reader that sees it.
    const verdict = judge(aged(5, { ok: false }), NOW);
    expect(verdict.ok, "a self-check failing on every run was passed because the live probe was fine").toBe(false);
    expect(verdict.kind).toBe("unhealthy");
  });

  it("fails when no report is stored at all, and says so rather than 'it failed'", () => {
    // `recorded: false` has three causes that look identical from here:
    // never run, the write failed, or it aged out of KV. All three mean
    // nothing is checking the connector.
    //
    // THE SENTENCE IS THE POINT, not just the exit code. Drop this guard
    // and the one below catches the same body — reporting "the last
    // self-check FAILED, at undefined", which is a wrong diagnosis sent
    // to a person at three in the morning. Nothing failed; nothing ran.
    const verdict = judge(reached({ ...LIVE, last_self_check: { recorded: false } }), NOW);
    expect(verdict.ok, "a connector with no self-check at all was passed").toBe(false);
    expect(verdict.summary, "an absent report was reported as a failed one").toMatch(/no self-check report is stored/);
  });

  it("fails when last_self_check is missing from the body entirely", () => {
    // A field that disappears in a redeploy must not read as a pass. An
    // absent key and a passing report are the same `undefined` to a
    // check written with optional chaining and no explicit `=== true`.
    const { last_self_check: _dropped, ...withoutIt } = LIVE;
    expect(judge(reached(withoutIt), NOW).ok, "a body with no self-check field was passed").toBe(false);
  });
});

describe("a body that cannot be read at all", () => {
  it("fails on HTML, which is what an edge error page looks like", () => {
    const verdict = judge(reached("<!DOCTYPE html><title>502 Bad Gateway</title>", 502), NOW);
    expect(verdict.ok).toBe(false);
    expect(verdict.kind).toBe("unreadable");
  });

  it("fails on an empty body answered with a 200", () => {
    // The emptiest possible pass. A proxy that terminates the connection
    // after the headers gives exactly this, and `JSON.parse("")` throws
    // rather than returning something falsy — which is the only reason
    // the naive version does not read it as healthy.
    expect(judge(reached("", 200), NOW).ok, "an empty 200 was read as healthy").toBe(false);
  });

  it("fails on JSON that is not an object", () => {
    // `JSON.parse("null")` succeeds. So does `"true"`. Neither has an
    // `ok` field, and neither should pass.
    for (const body of ["null", "true", '"ok"', "[]"]) {
      expect(judge(reached(body, 200), NOW).ok, `${body} was read as a healthy connector`).toBe(false);
    }
  });
});

describe("the three failures are told apart", () => {
  // "It is broken" and "I could not tell" are different pages at three in
  // the morning: one means go and look at the Worker, the other means go
  // and look at the network between here and it. A monitor that reports a
  // single "DOWN" for both sends the operator to the wrong place.
  it("names unreachable, unreadable and unhealthy distinctly", () => {
    expect(judge({ reached: false, error: "getaddrinfo ENOTFOUND" }, NOW).kind).toBe("unreachable");
    expect(judge(reached("not json", 200), NOW).kind).toBe("unreadable");
    expect(judge(reached({ ...LIVE, ok: false }, 503), NOW).kind).toBe("unhealthy");
  });

  it("fails when the endpoint could not be reached", () => {
    const verdict = judge({ reached: false, error: "The operation timed out" }, NOW);
    expect(verdict.ok, "a connector nobody could reach was passed").toBe(false);
    expect(verdict.summary, "the transport error was swallowed").toMatch(/timed out/);
  });
});

describe("fetching it", () => {
  const stub = (res: Response | (() => never)) => async () => (typeof res === "function" ? res() : res);

  it("reads the body even when the status says everything is fine", async () => {
    // The bug this wiring exists to not have: an `if (!res.ok) return`
    // early exit makes every assertion above unreachable in production
    // while the suite stays green.
    const verdict = await check({
      url: "https://example.invalid/health",
      fetchImpl: stub(new Response(JSON.stringify({ ...LIVE, ok: false }), { status: 200 })),
      now: NOW,
    });
    expect(verdict.ok, "a 200 carrying ok:false was never parsed").toBe(false);
  });

  it("reads the body even when the status says it is broken", async () => {
    // And the mirror image: a non-200 must not skip the parse either, or
    // the operator is told "HTTP 503" when the body says which way.
    const verdict = await check({
      url: "https://example.invalid/health",
      fetchImpl: stub(new Response(JSON.stringify({ ok: false, not_serving: "refusing every request" }), { status: 503 })),
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.summary, "the 503 body was thrown away unread").toMatch(/503/);
  });

  it("turns a transport failure into a verdict rather than a crash", async () => {
    // An unhandled rejection exits non-zero too, which looks like it
    // works — until the log says "fetch failed" and nothing about which
    // URL or what was expected.
    const verdict = await check({
      url: "https://example.invalid/health",
      fetchImpl: stub(() => {
        throw new TypeError("fetch failed");
      }),
      now: NOW,
    });
    expect(verdict.kind).toBe("unreachable");
    expect(verdict.summary).toMatch(/fetch failed/);
  });

  it("unwraps the cause, because 'fetch failed' names no fault", async () => {
    // MEASURED, not imagined: run this script against a hostname that
    // does not resolve and Node's fetch rejects with the literal string
    // "TypeError: fetch failed". What actually happened — ENOTFOUND, a
    // TLS failure, a refused connection — is on `cause`, and those are
    // three different mornings for whoever is reading the alert.
    const verdict = await check({
      url: "https://example.invalid/health",
      fetchImpl: stub(() => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND example.invalid") });
      }),
      now: NOW,
    });
    expect(verdict.summary, "the alert says only that it failed, not what failed").toMatch(/ENOTFOUND/);
  });

  it("gives up rather than hanging, because a run that never ends never alerts", async () => {
    // A scheduled job blocked on a half-open socket is indistinguishable
    // from a healthy one until GitHub kills it six hours later.
    //
    // The verdict ALONE is not enough to pass this: a fetch called with
    // no signal at all makes the stub below throw on `init.signal`, and
    // the catch in `check` turns that into "unreachable" too — so the
    // test would be green with the timeout deleted. What distinguishes
    // the two is that it aborted, and that it took as long as it was
    // told to and not longer.
    const started = Date.now();
    const verdict = await check({
      url: "https://example.invalid/health",
      fetchImpl: (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
      timeoutMs: 50,
      now: NOW,
    });
    const elapsed = Date.now() - started;
    expect(verdict.kind, "the check hung instead of failing").toBe("unreachable");
    expect(verdict.summary, "it failed for some reason other than giving up").toMatch(/timeout|abort/i);
    expect(elapsed, "it returned before the deadline it was given, so nothing waited").toBeGreaterThanOrEqual(45);
    expect(elapsed, "it did not give up anywhere near when it was told to").toBeLessThan(5_000);
  });
});
