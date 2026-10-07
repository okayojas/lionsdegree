# Forward-only catalog editions

A Penn State student's degree requirements are governed by the bulletin Edition
in force when they entered their major, so the planner pins each Plan to an
Edition and must keep old ones. Penn State publishes eight archived Editions
(2018-19 through 2025-2026), but every one of them lives under
`bulletins.psu.edu/archive/`, which the site's `robots.txt` disallows. We honor
robots.txt, so we cannot obtain any Edition we did not scrape while it was live.

**We therefore accumulate Editions forward only.** We hold 2025-2026, scraped on
2026-07-11 while it was the live Edition and since rotated into the archive. We
add each new Edition during the academic year it is published, and we never
backfill. A student whose Edition predates our oldest is told plainly that we do
not have theirs and which one they are being shown instead.

**The operational consequence is the part worth remembering: a missed year is
missed permanently.** Scraping each Edition while it is live is not a
maintenance chore that can slip a semester. It is the only opportunity.

## Considered options

- **Scrape the archive anyway.** Available and technically trivial. Rejected:
  the project's standing rule is to honor robots.txt, and the catalog is
  redistributed publicly under a NOTICE that asserts provenance. Taking data we
  were asked not to take would undermine the claim the NOTICE makes.
- **The archive's whole-bulletin PDF.** Not disallowed. Rejected: PDF-derived
  requirement lists truncate silently, which is the exact mechanism behind the
  fabricated-electives incident in DECISIONS.md §2.5, and truncation is
  invisible to referential-integrity checking because the surviving entries are
  all real.
- **Stay single-Edition, newest wins.** Simplest. Rejected: it silently re-plans
  every continuing student against requirements that do not govern them, and
  continuing students are the population most likely to use this.

## Consequences

- `PlanDoc` carries an Edition from creation. Retrofitting this later would be a
  migration over saved plans, so it lands before any second Edition exists.
- Catalog sync must be additive. A sync that replaces the published catalog
  destroys an Edition we cannot re-fetch, and the scheduled refresh workflow
  did exactly that as originally written.
- Registry Entries are scoped by Edition, because a requirement's satisfying
  list is an Edition-level fact.
- Storage is not the constraint people assume. Editions are highly similar and
  git stores identical files once, so a second Edition adds single-digit
  megabytes to the packed repository despite adding ~33 MB to the working tree.
