# LionsDegree

Prerequisite-aware degree planning for Penn State. Pick your majors, minors, and
certificates; the planner builds a semester-by-semester schedule that respects
every prerequisite, stays under the credit cap, front-loads the prescribed core,
and lands your capstone at the end — then lets you drag it around and tells you
what breaks.

**Unofficial.** Not affiliated with, endorsed by, or an official product of The
Pennsylvania State University. Course data may be out of date or wrong. Verify
everything with your academic adviser and LionPATH before you register.

Apache-2.0 licensed. Local-first: your plan lives in your browser, there is no
tracking, and nothing is sent anywhere unless you turn on the AI advisor or
account sync yourself.

![The planner: a generated Computer Science B.S. plan, with prerequisite route
lines connecting courses across eight semesters](docs/planner.png)

---

## Quick start

Requires **Node 20.19+** (CI runs 22) and **pnpm 9**. If you have Corepack,
`corepack enable` picks up the pinned pnpm automatically.

```bash
cd psu-planner
pnpm install
pnpm --filter web dev        # http://localhost:5173
```

That is the whole setup. The catalog ships in the repo, so the planner works
offline, with no account, no API key, and no server. Pick a major, press
**Build my flowchart**, and you get a scheduled plan.

To check your copy is sound:

```bash
pnpm -r typecheck
pnpm -r test                 # 112 engine tests
```

## What it does

**Plans the degree.** Merges the bulletin's requirement tables and suggested
academic plans for every program you pick, deduplicates shared requirements
across a double major (max, not sum), and schedules the result. The optimizer
packs into the fewest full-time semesters that stay feasible, reserves about one
gen ed per term, phases electives in along a curve mined from 1,078 real
suggested plans, and anchors the capstone sequence contiguously at the end.

**Knows the rules.** Gen Ed (the 45-credit framework, with US/IL double-counting
optimized so one course never burns two slots), Schreyer honors credit windows
(21 in years 1–2, 14 in years 3–4, RCL pinned to the first two semesters, H-twin
course swaps), summer sessions, integrated undergrad/grad programs with
GCAC-210 double-count math, AP credit from 45 exams, and gap semesters for a
co-op or leave.

**Shows the graph.** A pan/zoom canvas where courses are stations and
prerequisite chains are route lines, with an accessibility-equivalent list view
that does everything the canvas does using semantic markup and keyboard
controls.

**Degrades honestly.** Where the bulletin cannot be parsed into a rule, you get
"verify manually" — never a false green. About 3% of requirement rows land
there today.

## The AI advisor (optional)

The planner is fully usable with the AI turned off, and the hard work —
prerequisite solving, credit packing, requirement auditing — is deterministic
TypeScript in `packages/engine`, not a model. The advisor is a conversational
front end to that engine: it calls the same functions the buttons call.

**It is off unless you configure it, and there is no advisor tab until you
do.** The default build has no endpoint compiled into it and the default
deploy ships nothing billable: a fork cannot spend anyone else's money, and an
install that configures nothing costs nothing to run. The project's model is
bring-your-own-AI — point your own assistant at `lionsdegree-mcp` and pay
nobody.

To run it yourself you need a proxy holding an OpenAI-compatible key:

```bash
cd psu-planner/apps/api
cp .env.example .env                   # then put your key in OPENAI_API_KEY
npm run dev                            # :8788
```

Then, in `apps/web/.env.local`:

```
VITE_CHAT_ENDPOINT=/v1/chat
```

and `pnpm --filter web dev` in another shell — Vite proxies `/v1` to the API,
so the advisor tab appears and starts answering. Without that variable the tab
is hidden entirely, which is deliberate: a student who configured nothing is
never shown a control that cannot work.

**Deploying with the advisor.** The Cloudflare Pages Function lives at
`apps/web/self-host/functions/`, not at `apps/web/functions/`, because
`wrangler pages deploy` compiles any `functions/` directory it finds in the
working directory and there is no flag to point it elsewhere. Its location is
what keeps the default deploy free:

```bash
npm run deploy             # static only, nothing billable
npm run deploy:self-host   # puts the proxy in place for one deploy, then removes it
```

`VITE_CHAT_ENDPOINT` must be same-origin: the shipped CSP allows
`connect-src 'self'` plus Supabase, and the request carries the student's
Supabase token, so an off-origin endpoint is rejected rather than shipped as
a chat that cannot send. Host the proxy wherever you like and front it at
your own origin.

The self-host deploy needs `OPENAI_API_KEY` (secret) and a `RATE_LIMIT` KV
binding on the Pages project, and it refuses to run without
`VITE_CHAT_ENDPOINT` — otherwise it would ship a billable proxy that the
build it accompanies can never call.
Its hardening — rate limiting, the identity gate, prompt-injection fencing —
is unchanged.

`apps/api/.env.example` documents every variable the proxy reads: model,
completion budget, reasoning effort, CORS origins, rate limit, and the optional
Supabase identity gate.

> **In progress:** making this provider-agnostic, so you can point it at a model
> you run yourself instead of a hosted key. See "Roadmap".

## Refreshing the catalog

The committed catalog is edition `2025-2026`. Penn State publishes a new edition
each summer; `.github/workflows/refresh-catalog.yml` re-scrapes on Aug 25 and
Jan 5 and opens a PR, gated on the engine tests passing against the new data.

To do it by hand:

```bash
cd psu-catalog-pipeline
npm install
npx tsx src/cli.ts scrape --edition 2026-2027   # ~25-40 min, 1 req/s, disk-cached
npx tsx scripts/buildIndex.ts --edition 2026-2027
npx tsx scripts/scrapeIug.ts --edition 2026-2027
npx tsx scripts/scrapeApCredits.ts --edition 2026-2027   # Playwright
node ../psu-planner/apps/web/scripts/sync-catalog.mjs 2026-2027
```

The crawler respects robots.txt and runs at one request per second. Do not
raise the rate.

## Layout

```
psu-catalog-pipeline/   Scraper: bulletins.psu.edu -> structured JSON
psu-planner/
  packages/engine/      Pure TS core: prereq parser, optimizer, audits (112 tests)
  apps/web/             React + Vite PWA
  apps/api/             Hono AI proxy (optional, off by default)
catalogs/               Original demo data, kept as the parser regression corpus
```

`packages/engine` has no I/O and no framework. Everything scheduling-related
lives there and is unit tested.

## Accounts and sync (optional)

Config-gated: with no `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, the
sign-in UI hides and the app stays local-only. To enable it, create a Supabase
project, run `supabase/migrations/0001_plans.sql` (deny-by-default RLS), enable
the OAuth providers you want, and copy `apps/web/.env.example` to
`.env.local` with those two values. Both must be set; a malformed URL is
reported in the console and sync stays off rather than breaking the planner.

## Known limitations

Worth knowing before you rely on it:

- **Desktop-first.** The planner's side panel does not collapse on narrow
  screens, so the flowchart and list views are both unusable on a phone.
  Onboarding is fine. A responsive layout is on the roadmap.
- **The catalog is edition `2025-2026`.** Refresh it yourself (below) if you
  need the current one.
- **~3% of requirement rows do not parse** into rules and are shown as "verify
  manually" rather than guessed at.
- **IUG (integrated master's) covers 3 of 41 programs.**
- The canvas is pointer-driven; the list view is the keyboard- and
  screen-reader-equivalent path and does everything the canvas does.

## Roadmap

- Provider-agnostic AI: point it at a model you run yourself, or bring a key.
  (Fully in-browser tool calling is not yet practical — the smallest models
  that do it reliably are still a several-hundred-MB download. See
  `psu-planner/docs/ai-assistant-research.md`.)
- Mobile-responsive layout
- Landing page
- IUG coverage beyond the current 3 of 41 programs
- Normalizing the remaining ~3% of unstructured requirement rows

## Updates

The catalog is the part that goes stale. Penn State publishes a new bulletin
edition each summer, and `.github/workflows/refresh-catalog.yml` re-scrapes on
**Aug 25** and **Jan 5**, opening a pull request rather than pushing — the
engine tests have to pass against the new data first. A bad refresh degrades
every generated plan silently, so it is gated deliberately.

If you are running your own copy, pull before each semester's registration
opens, or refresh the catalog yourself (see above).

Changes worth knowing about land here:

### Unreleased

_Nothing yet._

### 2026-09-23 — first public release

- Prerequisite-aware planning for majors, minors, and certificates, with
  dual-major requirement deduplication.
- Flow-ordered packing optimizer: 19-credit cap, front-loaded prescribed core,
  elective curve mined from 1,078 suggested plans, contiguous capstone.
- Gen Ed (45-credit framework, US/IL double-counting), Schreyer honors credit
  windows, summer sessions, gap semesters, AP credit from 45 exams.
- Integrated undergrad/grad (IUG) support for 3 programs.
- Pan/zoom prerequisite canvas plus an equivalent keyboard and screen-reader
  list view.
- Optional AI advisor over a proxy you run (off unless configured), and optional account sync.
- Catalog edition `2025-2026`.

## Documentation

- `DECISIONS.md` — every design decision and incident, with the reasoning.
  Read section 2 before touching the pipeline.
- `CONTRIBUTING.md` — setup, the non-negotiable data rules, how to point this
  at another university.
- `SECURITY.md` — reporting, and what to lock down if you self-host.
- `NOTICE` — data provenance and attribution.
- `psu-planner/docs/ai-assistant-research.md` — cost, latency, and the
  local-model options for the advisor, measured against this codebase.
- `psu-catalog-pipeline/docs/iug-programs.md` — how integrated undergrad/grad
  programs work and what the scraper can see of them.

## Another university?

The engine is not Penn State specific; the scraper is, and it targets CourseLeaf,
which many universities use. See CONTRIBUTING.md.
