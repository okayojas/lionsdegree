# Security

## Reporting

Report vulnerabilities privately through GitHub's "Report a vulnerability"
button on the Security tab, or by email to the address in
`psu-planner/apps/web/public/.well-known/security.txt`. Please do not open a
public issue for anything exploitable.

Expect an acknowledgement within a week. This is a volunteer project, so please
be patient on fixes.

## Scope

In scope: the planner app, the chat proxy in `apps/api`, the scraper, and the
Supabase sync path.

Out of scope: anything on Penn State's own systems. Do not test against
bulletins.psu.edu or LionPATH. If you find a problem in a Penn State service,
report it to Penn State, not here.

## If you self-host

The proxy in `apps/api` holds an AI provider key and will spend real money for
anyone who can reach it. Before exposing it publicly:

- Set `ALLOWED_ORIGINS` to your own origin. Without it, production blocks
  cross-origin browser calls, but do not rely on that alone.
- Bind a rate-limit store. The in-memory limiter is dev-only and resets on
  every cold start; on Cloudflare, bind the `RATE_LIMIT` KV namespace.
- Set `SUPABASE_JWT_SECRET` and `REQUIRE_AUTH=1` if you want the proxy to be
  usable only by signed-in users. Without the secret, the identity gate is
  inactive and limiting falls back to IP.
- Set a monthly spend cap in your provider's dashboard. It is the only limit
  that actually binds.

Running entirely local (a local model, no hosted key) sidesteps all of this,
which is one reason it is the recommended default. See README.

## Known accepted risks

Documented in `DECISIONS.md` section 6. The notable one: the rate limiter is
not atomic under concurrent requests. A Durable Object would fix it; for a
single-user local install it does not matter.
