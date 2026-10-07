# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context**: the planner and the catalog pipeline are separate domains with their own vocabulary.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** at the repo root: system-wide decisions.
- **`<context>/docs/adr/`**: context-scoped decisions. Read the ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT-MAP.md                     ← points at both contexts
├── docs/adr/                          ← system-wide decisions
│   ├── 0001-local-first-planning.md
│   └── 0002-....md
├── psu-planner/                       ← the planner: degree plans, scheduling, prerequisites
│   ├── CONTEXT.md
│   ├── docs/adr/
│   ├── apps/web
│   ├── apps/api
│   └── packages/engine
└── psu-catalog-pipeline/              ← the scraper: bulletin ingest, catalog data
    ├── CONTEXT.md
    └── docs/adr/
```

The two contexts meet at the catalog data the pipeline produces and the planner consumes. Decisions about that boundary belong in the root `docs/adr/`, not in either context's own.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
