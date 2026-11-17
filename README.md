# LionsDegree

**[lionsdegree.com](https://lionsdegree.com)** — a free degree planner for Penn State.

Pick your majors, minors and certificates. LionsDegree builds a semester-by-semester plan that
respects every prerequisite, stays under the credit cap and puts your capstone at the end. Then
drag any course to another semester and it tells you what breaks.

**Unofficial.** Not affiliated with, endorsed by, or an official product of The Pennsylvania State
University. Course data may be out of date or wrong. Check your plan with your academic adviser and
LionPATH before you register.

![A generated Computer Science B.S. plan, with prerequisite lines connecting courses across eight
semesters](docs/planner.png)

## What it does

- **Builds the plan** from the Bulletin's requirements and suggested academic plans for every
  program you pick, counting shared requirements once across a double major.
- **Knows the rules:** Gen Eds (with US/IL double-counting), Schreyer honors credits, AP credit,
  summer sessions, gap semesters, and integrated undergrad/grad programs.
- **What-ifs:** copy your plan into a tab, change anything (even your major), compare, and keep the
  one you like.
- **Sample plans:** browse the Bulletin's suggested plan for any of 383 programs and open it in the
  planner.
- **Works with your own AI:** connect Claude or another assistant at
  [lionsdegree.com/connect](https://lionsdegree.com/connect/) and ask it about your plan.
- **Honest about gaps:** where the Bulletin can't be read as a rule (about 5% of requirements), it
  says "verify manually" instead of guessing.

Your plan is saved in your browser; no account is needed. Sign in with Google to sync it across
devices. The site keeps one anonymous count of plans made and nothing else; the
[privacy policy](https://lionsdegree.com/privacy/) says exactly what.

## Run it locally

Needs Node 20.19+ and pnpm 9 (`corepack enable` picks up the pinned version).

```bash
cd psu-planner
pnpm install
pnpm --filter web dev        # http://localhost:5173
```

The catalog is committed, so it works offline with no account, key or server.

```bash
pnpm -r typecheck
pnpm -r test                 # engine, AI connector and web unit tests
pnpm test:e2e                # Playwright browser suite (run pnpm test:e2e:install once)
```

Sign-in and sync turn on only when `apps/web/.env.local` sets `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` (see `apps/web/.env.example` and `supabase/migrations/`).

## Layout

```
psu-catalog-pipeline/     Scraper: bulletins.psu.edu -> structured JSON
psu-planner/
  packages/engine/        Prerequisites, scheduling, degree audit (pure TypeScript, no I/O)
  packages/mcp/           The AI connector (MCP server), local or hosted
  apps/web/               The site and planner (React + Vite)
  apps/api/               Optional self-hosted AI advisor proxy, off by default
catalogs/                 Parser regression data
docs/adr/                 Architecture decisions
```

## Catalog updates

Two Bulletin editions ship (2025-2026 and 2026-2027); a plan stays on the edition it was made in.
`.github/workflows/refresh-catalog.yml` re-scrapes each August and January and opens a pull request
that has to pass the tests before it can merge. To refresh by hand, see
`psu-catalog-pipeline/` and `psu-planner/apps/web/scripts/sync-catalog.mjs`. The scraper respects
robots.txt at one request per second; please don't raise the rate.

## More

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, the data rules, and pointing this at another
  university. The engine isn't Penn State specific; the scraper targets CourseLeaf, which many
  universities use.
- [SECURITY.md](SECURITY.md): reporting a vulnerability.
- [DECISIONS.md](DECISIONS.md) and [docs/adr](docs/adr): why things are the way they are.
- [NOTICE](NOTICE): data provenance and attribution.

Apache-2.0 licensed.
