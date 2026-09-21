# Contributing to LionsDegree

Thanks for looking. This is an unofficial, non-commercial tool built by a Penn
State student. Contributions are welcome, especially from people at other
universities who want to point the pipeline somewhere else.

By contributing you agree your work is licensed under Apache-2.0 (see LICENSE).

## Getting set up

```bash
git clone <repo> && cd psu-planner
pnpm install
pnpm --filter web dev     # http://localhost:5173
```

The catalog is committed under `apps/web/public/catalog`, so the planner works
immediately. You only need the scraper if you are changing parsing or refreshing
the edition — see README "Refreshing the catalog".

```bash
pnpm -r test        # 112 engine tests, incl. real-catalog + flowchart regression
pnpm -r typecheck
```

Both must pass before a PR. CI runs them plus the pipeline's parser regression.

## The rules that are not negotiable

These come from real incidents. `DECISIONS.md` has the full log; read section 2
before touching the pipeline.

1. **No LLM output ever enters the dataset.** A model once fabricated 48
   elective courses that looked entirely plausible. Every field in
   `public/catalog` must trace to a deterministic parse of bytes we fetched.
   Using a headless browser to capture DOM or network responses is fine;
   asking a model to read a page and tell you what it says is not.
2. **Degrade conservatively.** If a requirement will not parse, emit UNK and
   say "verify manually". Never emit "satisfied" on a guess. A student who
   trusts a false green does not graduate on time.
3. **The live bulletin is the authority at render time.** Pipeline `unverified`
   flags feed the review queue; they are not permission to invent a value.
4. **Coverage relations are directional.** MATH 251 covers MATH 250. The
   reverse is false and will silently break prerequisite chains.
5. **The cap-aware optimizer runs last.** An invariant enforced in an earlier
   pass is void if a later pass re-packs. This caused a 25-credit semester once.
6. **Respect robots.txt.** `bulletins.psu.edu/search/` and `/ribbit/` are
   disallowed. The crawler runs at 1 request/second and caches to disk. Do not
   raise the rate.

## Working on the engine

`packages/engine` is framework-free TypeScript with no I/O. That is deliberate:
it makes the scheduling logic testable and portable. Keep DOM, fetch, and
storage out of it.

If you change the optimizer, expect `test/flowchart-validation.test.ts` to
argue with you — it gates every engineering major against its official advising
flowchart. That test failing usually means the change is wrong, not the test.

## Working on the scraper

Prerequisite-parser changes must pass the regression corpus in `catalogs/`,
which is the original demo data kept precisely for this purpose.

When a bulletin markup change breaks a parser, the symptom is a jump in
`data/out/<edition>/review/needs_review.jsonl`. Check that count before and
after any parsing change.

## Pointing this at another university

The engine is not Penn State specific — it operates on courses, requirement
sections, and templates. What is PSU-specific is `psu-catalog-pipeline`, which
targets CourseLeaf (the CMS behind bulletins.psu.edu and a lot of other
universities' catalogs). A sibling pipeline that emits the same JSON shapes
should work with the existing app. Open an issue if you are attempting this;
the schemas are in `psu-catalog-pipeline/src/validate/schemas.ts`.

## What not to add

- Anything that scrapes LionPATH. It is `Disallow: /` and it is behind auth.
- Anything that republishes grade distributions or professor ratings. The app
  constructs outbound search links; it does not fetch, cache, or store them.
- Tracking, analytics, or telemetry. The app is local-first and stays that way.
