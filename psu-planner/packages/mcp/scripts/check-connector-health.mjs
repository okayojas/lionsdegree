/** Reads the hosted connector's /health and decides whether to wake a human (#58).
 *
 * The Worker already answers a real Course question against the real
 * catalog every fifteen minutes and writes down what it found. Nothing
 * reads it. This is the reader; `.github/workflows/connector-health.yml`
 * runs it on a schedule so a failure arrives as a failed GitHub Action,
 * which is a notification channel this project already has.
 *
 * WHY A SCRIPT AND NOT `curl -f` IN A YAML `run:` BLOCK. Three reasons,
 * and the first is the whole ticket:
 *
 *   1. A 200 IS NOT SUCCESS. /health returns 200 while reporting a
 *      self-check that has failed on every run for an hour — by design,
 *      because its status code tracks the LIVE probe and a failure that
 *      has since resolved should not page at three in the morning. "The
 *      server is up" and "the connector answers" are different claims,
 *      and only the second is interesting.
 *   2. A STALE TIMESTAMP IS ITS OWN OUTAGE. If `last_self_check.at`
 *      stops advancing the cron has silently died, and nothing else
 *      would ever notice: every field in the body still reads green.
 *   3. THE DECISION HAS TO BE TESTABLE. The two outages this connector
 *      has actually had were silent by construction — a CORS preflight
 *      rejected before the handler ran, a 404 on a well-known path —
 *      and both were found by a student saying "it doesn't work". A
 *      check that nothing verifies is the same class of thing.
 *
 * CONSERVATIVE DEGRADATION, the repo's iron rule 2 (DECISIONS.md)
 * applied to a monitor: anything that cannot be determined is a failure,
 * never a pass. An unparseable body, an unreadable timestamp, a field
 * that vanished in a redeploy — all of them mean "cannot be checked",
 * and "cannot be checked" is not "fine". The failure mode of a monitor
 * is looking correct while seeing nothing.
 *
 * It names which of three things went wrong, because they send the
 * operator to different places: UNREACHABLE is the network or DNS
 * between the runner and Cloudflare, UNREADABLE is something answering
 * that is not the Worker, UNHEALTHY and STALE are the Worker itself.
 *
 * No dependencies, deliberately: Node 22 has `fetch`, so the workflow
 * needs a checkout and a node and nothing else — no install step that
 * can fail and no lockfile that can drift.
 */

import { pathToFileURL } from "node:url";

/** @typedef {{reached: true, status: number, body: string} | {reached: false, error: string}} Probe */
/** @typedef {{ok: boolean, kind: "healthy"|"unreachable"|"unreadable"|"unhealthy"|"stale", summary: string}} Verdict */

export const HEALTH_URL = "https://mcp.lionsdegree.com/health";

/** How old the stored self-check may be before the cron counts as dead.
 *
 * THREE CRON PERIODS. `wrangler.toml` runs the self-check every fifteen
 * minutes, so a healthy connector refreshes this timestamp four times
 * an hour. Cron on Workers is best-effort and Cloudflare does not
 * promise every tick, so one missed run is weather and must not page;
 * three consecutive misses is not weather.
 *
 * AND IT MUST STAY UNDER AN HOUR. The report is written to KV with
 * `HEALTH_TTL = 3600` (worker.ts), so at sixty minutes it stops
 * existing and /health answers `recorded: false` instead — which this
 * script also fails on, but as "no report stored", a different and
 * vaguer sentence. A threshold of 60 or more would make this branch
 * dead code: the timestamp can never be observed that old.
 *
 * Note that this is measured against the WORKER's clock, not the
 * runner's schedule. GitHub's cron is approximate and a delayed run
 * only delays detection; it cannot turn a fresh report stale. */
export const MAX_REPORT_AGE_MS = 45 * 60_000;

/** Tolerance for the two clocks disagreeing before a future timestamp is
 * read as a fault rather than skew. Both ends are NTP-synced machines;
 * two minutes is already generous. A report dated ahead of now is worth
 * failing on because it is the one input that can never go stale, so it
 * would disable the check above silently. */
const CLOCK_SKEW_MS = 2 * 60_000;

/** A run that never ends never alerts. Ten seconds is ~17x the 0.58s
 * the live endpoint answered in when this was written, measured with
 * `curl -w %{time_total}`. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** @returns {Verdict} */
const fail = (kind, summary) => ({ ok: false, kind, summary });

/** Decide, from what came back, whether somebody needs to be told.
 *
 * Pure on purpose: every branch below is reachable from a string and a
 * number, so `test/connector-health-monitor.test.ts` can drive all of
 * them without a network.
 *
 * @param {Probe} probe what the fetch produced
 * @param {number} now epoch milliseconds
 * @returns {Verdict}
 */
export function judge(probe, now) {
  if (!probe.reached) return fail("unreachable", `/health could not be reached: ${probe.error}`);

  // THE STATUS CODE IS EVIDENCE, NOT THE VERDICT. /health answers 503
  // when the connector is not serving, so a non-200 is a real failure —
  // but it is collected alongside what the body says rather than
  // short-circuiting, because "HTTP 503" alone sends nobody anywhere.
  const reasons = [];
  if (probe.status !== 200) reasons.push(`HTTP ${probe.status}, expected 200`);

  let body;
  try {
    body = JSON.parse(probe.body);
  } catch {
    // An edge error page, a captive portal, or an empty 200 from a
    // proxy that hung up after the headers. `JSON.parse("")` throws,
    // which is the only reason an empty body is not read as healthy.
    return fail("unreadable", ["the body is not JSON", ...reasons].join("; "));
  }

  // `=== true` AND NOT A TRUTHINESS TEST, here and throughout. A field
  // that disappears in a redeploy is `undefined`, and `undefined` is
  // what optional chaining returns for a body that never had the field
  // at all — both must read as "cannot be checked", not as a pass.
  if (body?.ok !== true) reasons.push(`the connector reports ok:${JSON.stringify(body?.ok)}`);
  if (reasons.length) return fail("unhealthy", reasons.join("; "));

  const last = body.last_self_check;
  if (typeof last !== "object" || last === null) {
    return fail("unreadable", "the body carries no last_self_check, so the cron cannot be checked");
  }
  if (last.recorded !== true) {
    // /health deliberately does not distinguish these, and neither
    // should this: never run, the write failed, or it aged out of KV.
    // All three mean nothing is checking the connector.
    return fail("unhealthy", "no self-check report is stored: it never ran, the write failed, or it aged out");
  }
  if (last.ok !== true) {
    // THE CASE THAT ANSWERS 200. The live probe is fine and the
    // connector has been failing its own check every fifteen minutes.
    // Anything watching the status code sees nothing here.
    return fail("unhealthy", `the last self-check FAILED, at ${last.at}`);
  }

  const at = Date.parse(last.at);
  if (Number.isNaN(at)) {
    // `Date.parse` of rubbish is NaN and every comparison against NaN
    // is false, so an age check written without this reads an
    // unparseable timestamp as fresh.
    return fail("unreadable", `the last self-check carries no usable timestamp (${JSON.stringify(last.at)})`);
  }

  const age = now - at;
  const minutes = Math.round(age / 60_000);
  if (age < -CLOCK_SKEW_MS) {
    return fail("unreadable", `the last self-check is dated ${-minutes} minutes in the future (${last.at})`);
  }
  if (age > MAX_REPORT_AGE_MS) {
    return fail("stale", `the last self-check is ${minutes} minutes old (${last.at}) — the cron has stopped`);
  }
  return { ok: true, kind: "healthy", summary: `answering; last self-check ${minutes} minutes ago` };
}

/** Fetch /health and judge it.
 *
 * THE BODY IS READ WHATEVER THE STATUS. The obvious `if (!res.ok)
 * return` early exit would make most of `judge` unreachable in
 * production while the suite above stayed green — and it would throw
 * away the one sentence that says which way the connector is broken.
 *
 * @param {{url?: string, fetchImpl?: typeof fetch, now?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<Verdict>}
 */
export async function check(opts = {}) {
  const {
    url = HEALTH_URL,
    fetchImpl = fetch,
    now = Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  /** @type {Probe} */
  let probe;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // The default would be served from Cloudflare's edge cache in
      // some configurations, and a cached green is the exact shape of
      // failure this whole script exists to not have.
      headers: { "cache-control": "no-cache" },
    });
    probe = { reached: true, status: res.status, body: await res.text() };
  } catch (e) {
    // Every transport failure, including the timeout: DNS, TLS, a
    // connection reset. Turned into a verdict rather than allowed to
    // reject, so the run exits non-zero WITH a sentence saying what
    // was being fetched and what happened.
    //
    // THE CAUSE IS UNWRAPPED, because Node's fetch rejects with the
    // literal "TypeError: fetch failed" and nothing else — measured by
    // running this against a hostname that does not resolve. ENOTFOUND,
    // a TLS failure and a refused connection are three different
    // mornings for whoever reads the alert, and all three arrive under
    // that one sentence with the real reason on `cause`.
    const cause = e?.cause?.message ? ` (${e.cause.message})` : "";
    probe = { reached: false, error: `${e?.name ?? "Error"}: ${e?.message ?? String(e)}${cause}` };
  }
  return judge(probe, now);
}

/** Only when run directly, so importing this in a test does no I/O.
 *
 * `pathToFileURL` rather than string-building a `file://` URL: on
 * Windows, where this is written, `argv[1]` is a drive-letter path with
 * backslashes and the hand-rolled comparison never matches — so the
 * script would import cleanly and silently do nothing. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2] ?? HEALTH_URL;
  const verdict = await check({ url });
  // The verdict first, so it is the line visible in the Actions run
  // list without opening the log.
  console.log(`${verdict.ok ? "OK" : "FAILED"} (${verdict.kind}) ${url}: ${verdict.summary}`);
  if (!verdict.ok) {
    // An annotation, so GitHub surfaces the reason on the run's summary
    // page rather than only in the step output.
    console.log(`::error title=LionsDegree connector ${verdict.kind}::${verdict.summary}`);
  }
  // NON-ZERO IS THE WHOLE NOTIFICATION. A failed scheduled workflow is
  // what GitHub emails the maintainer about; a zero exit with a sad
  // message in the log is the silence this ticket is about.
  //
  // `exitCode` AND NOT `process.exit()`. Calling exit() here aborts the
  // process while the fetch's timeout handle is still open, and on
  // Windows Node dies on a libuv assertion and returns 127 — a HEALTHY
  // run reporting failure, which is how you get a monitor switched off.
  // Setting the code and letting the loop drain is both correct and
  // prompt: the timeout handle does not hold the process open.
  process.exitCode = verdict.ok ? 0 : 1;
}
