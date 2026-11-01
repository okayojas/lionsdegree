## Problem Statement

A student's AI assistant cannot reach their Plan.

The MCP server exists and works — twelve tools, tested — but it runs only
on the student's own machine over stdio. To use it they must install Node,
run a package from a terminal, and point it at a plan file on their disk.
Almost no undergraduate will do that, and the ones who would are not the
ones who most need help reading a degree audit.

Worse, the site already tells them otherwise. `/connect/` is live in
production and instructs students to paste `https://mcp.lionsdegree.com/sse`
into their assistant. That host does not resolve, and `/sse` is the older
transport in any case. Every student who follows the published instructions
today fails, and nothing on the page tells them why.

Meanwhile the part that makes an assistant genuinely useful is the part that
needs the student's own data. "What are the prerequisites for CMPSC 465" is
a question the Bulletin answers. "What should I take next term, and what
breaks if I drop Organic Chemistry" is a question only their Plan answers,
and that is the question they actually have.

## Solution

LionsDegree runs a hosted connector at `https://mcp.lionsdegree.com/mcp`.
A student pastes one URL into their assistant, signs in with the Penn State
Google or Microsoft account they already use, and their assistant can read
and reason about their real Plan. Nothing to install.

Signing in is the point, not a toll. The tools that matter are the ones
that read personal data, so the connector is gated rather than offering a
degraded anonymous mode.

The assistant can also *propose*. A student asks what happens if they take
a lighter spring, or push a Capstone back a Term, or swap a Program — and
gets back a complete candidate Plan they can look at before deciding
anything. The proposal is a thing they can see and reject, not an edit that
has already happened.

## User Stories

1. As a student, I want to connect my assistant with a single URL, so that I do not need a terminal to get help with my degree.
2. As a student, I want to sign in with the Google or Microsoft account I already use for Penn State, so that I am not creating another password.
3. As a student, I want my assistant to read my actual Plan, so that its answers are about my degree rather than a generic one.
4. As a student, I want to ask what is left to graduate and get an answer computed from my Plan, so that I can stop maintaining a spreadsheet.
5. As a student, I want to ask what I can take next Term, so that I can register with some confidence.
6. As a student, I want to ask what breaks if I drop a Course, so that I learn the consequence before the drop deadline rather than after.
7. As a student, I want to see a candidate Plan for a change I am considering, so that I can judge it against the one I have.
8. As a student, I want a proposed Plan to show what moved and why, so that I am not asked to trust a wall of output.
9. As a student, I want a proposal to stay a proposal until I accept it, so that asking a question cannot quietly rearrange my degree.
10. As a student, I want my assistant's answers to reflect edits I made in the planner a moment ago, so that I am not told something that stopped being true.
11. As a student, I want to be told when my assistant is working from a stale copy, so that I can refresh rather than act on it.
12. As a student, I want my assistant's changes to appear in the planner, so that the two are one Plan rather than two.
13. As a student, I want a change my assistant makes to never silently overwrite one I just made myself, so that work is not lost without being mentioned.
14. As a student, I want to be asked in my own words before a required Course is removed, so that a misread sentence cannot drop a graduation requirement.
15. As a student, I want my Plan to stay governed by the Edition it was created under, so that a hosted tool does not re-audit me against requirements that do not apply.
16. As a student, I want to revoke my assistant's access, so that connecting is not permanent.
17. As a student, I want to know what the connector can see before I authorise it, so that consent means something.
18. As a student who never signs in, I want the planner to keep working exactly as it does now, so that the account is optional for the thing I came for.
19. As a student, I want the connector to say plainly when it cannot answer, so that I do not get a confident guess.
20. As a student, I want the connector to be as fast as the website, so that asking my assistant is not slower than looking it up myself.
21. As a student on a phone, I want to connect from a phone, so that setup is not gated on owning a laptop.
22. As a prospective student, I want to describe an interest and get real credential combinations, so that I can see what the degree would look like.
23. As a student, I want my assistant's Course facts to come from the Bulletin, so that they are not invented.
24. As a student, I want the connector to refuse to act on instructions hidden inside Course text, so that a Bulletin entry cannot steer my assistant.
25. As an operator, I want the connector to run without a container to babysit, so that there is no server to keep alive.
26. As an operator, I want one student's heavy use not to degrade everyone else's, so that the service stays usable.
27. As an operator, I want a cold start to be fast enough that nobody notices, so that the first question is not the slow one.
28. As an operator, I want the hosted and local servers to share one catalog implementation, so that they cannot drift into answering differently.
29. As an operator, I want the local stdio server to keep working unchanged, so that existing users are not broken by the hosted one shipping.
30. As an operator, I want to know when the connector is failing, so that I am not told by a student.
31. As a maintainer, I want the published connector URL to be the one that exists, so that the documentation is not the bug.
32. As a maintainer, I want the hosted surface to be the same tools as the local one, so that there is one tool surface to reason about rather than two. (Twelve when this was written; thirteen since #37 added plan simulation. The count is deliberately not restated here — the invariant is that the two surfaces match, and a number in prose is the part that goes stale.)
33. As a maintainer, I want mutations to be rejected rather than merged when they are based on a stale read, so that conflicts are loud.
34. As a security reviewer, I want a token to grant access to exactly one student's Plan, so that a leaked token is bounded.
35. As a security reviewer, I want the database to refuse cross-user reads independently of application code, so that an application bug is not a breach.
36. As a security reviewer, I want authorisation to federate to the existing providers rather than introduce new credentials, so that there is no new secret to store.

## Implementation Decisions

### Transport and hosting

The connector is a Cloudflare Worker served at `mcp.lionsdegree.com/mcp`,
using Streamable HTTP. The MCP SDK ships a web-standard transport that
imports no Node APIs and speaks in `Request`/`Response`, which is what makes
a Worker viable at all; the Node/express transport is not used.

`/sse` is not implemented. The page that advertises it is wrong and is
corrected as part of this work — see *Out of Scope* for the interim.

Cloudflare was chosen over a Node container because the site, the domain and
the deployment credentials already live there, and because a Worker has no
cold start worth naming and no machine to keep alive. The cost is that the
catalog cannot be held in memory, which forces the next decision.

### The catalog cannot be loaded the way it is loaded today

MEASURED on the current catalog: 64 MB of heap, 138 MB RSS, 158 ms to parse
both Editions. A Worker isolate has 128 MB. The present approach — read
`search-index.json` once at connect and keep everything resident — cannot
run there. This is a hard constraint, not a preference.

The artifacts that fix it already exist, built during the planner's boot
work: a slim audit index covering every Course at roughly 212 KB gzipped,
the search postings separated out at roughly 1.26 MB gzipped, and the
per-subject Course files. The hosted catalog loads the audit index always,
the postings only when someone searches, and a subject file only when a
Course detail or prerequisite chain needs one. The 11 MB combined index is
no longer read by the connector.

### `CatalogSource`

Catalog reads go behind a single interface that answers "give me the bytes
at this path". Two implementations: the filesystem, for the local stdio
server, and fetch against the Worker's static assets. The edition loader
becomes asynchronous and is otherwise unchanged.

One implementation of the catalog, two ways of reaching the bytes. A second
copy of the loader would be a second set of answers about what a Course
requires, which is the drift this seam exists to prevent.

Warm isolates cache the parsed audit index at module scope; a cold isolate
re-fetches it, which is cheap at this size.

### `PlanStore`

Plan reads and writes go behind a second interface. The local server backs
it with the plan file it already reads. The Worker backs it with Supabase,
under the authenticated student's identity.

This is where the concurrency rule lives, so that it is stated once rather
than restated in each mutating tool.

### Plans are already synced; this makes them authoritative

The `plans` table exists, carries deny-by-default row-level security
restricting every operation to `auth.uid() = user_id`, and the planner
already pushes and pulls. This work does not build plan storage. It changes
the reconciliation rule and makes sign-in a prerequisite for the connector
rather than an optional extra.

### Optimistic concurrency on `rev`

Once the connector can write, a Plan has two writers: the student's browser
and the model. Today both reconcile by last-write-wins on `updatedAt`, which
means a model write landing inside the browser's debounce window silently
erases an edit the student just made, or is itself erased, and nobody is
told either happened.

Every write therefore states the `rev` it was computed from and is rejected
if that `rev` is no longer current. The `rev` column already exists. A
rejected write is returned to the model as a stale-read error instructing it
to re-read the Plan and try again — never merged, never applied on a guess.

The planner's own sync adopts the same rule, because a conflict rule honoured
by one writer is not a conflict rule.

This is iron rule 2 applied to concurrency: a write that cannot be shown to
be based on current state is refused, not best-guessed.

### Freshness is reported, not assumed

`get_plan` returns the Plan's `updatedAt` and `rev`, so a model can say how
fresh its view is rather than implying it is live. The planner flushes any
pending push when the tab is hidden, which closes the common case of a
student alt-tabbing from the planner to their assistant mid-edit.

### Authorisation

OAuth 2.1 with dynamic client registration, which is what hosted MCP
connectors expect. The connector's authorisation and token endpoints
federate to the Google and Microsoft providers already configured in
Supabase; no new identity provider and no new stored secret.

An access token resolves to exactly one Supabase user, and every Plan query
runs under that identity so row-level security is the enforcing layer. An
application bug must not be sufficient to read another student's Plan.

### Mutating tools, hosted

Four tools mutate: adding a Course, removing one, setting a Constraint, and
re-optimising. They remain available, under three conditions.

The existing consent guard is kept exactly as written: removing a required
Course demands `user_explicitly_asked`, and a model must never assert that on
its own behalf — it has to have been told, in the student's own words. The
guard was written for a local file the student owned. Hosted, it is the only
thing between a misread sentence and a dropped graduation requirement, so it
hardens rather than relaxes: the hosted path rejects the flag unless the
request also carries the student's own utterance.

Every mutation is `rev`-checked as above.

Every mutation returns the resulting Plan, so the model can state what
actually changed rather than describing what it intended.

### Plan simulation

A new tool answers "what would my Plan look like if…" without changing
anything. It takes the student's current Plan plus a described change and
returns a complete candidate Plan, computed by the existing optimiser, with
a summary of what moved and any new conflicts.

It is a pure read. The candidate is returned to the model and shown to the
student; it does not touch the stored Plan. Accepting one is an explicit
separate act in the planner.

This is the feature that makes the connector worth gating behind sign-in: a
student can see a decision before making it.

### Carried-over invariants

Catalog prose reaching a model stays fenced in `untrusted_catalog_text`,
using the existing engine implementation rather than a second copy — a
duplicated security boundary drifts from the original.

A Plan stays pinned to its Edition. The connector reads the Edition from the
Plan, never the newest one, per ADR 0001. Editions are forward-only and a
stale index across an Edition change is a correctness bug.

Unparseable or partial data degrades to "could not be checked", never to a
satisfied requirement.

### Rate limiting

Per authenticated student, not per IP: students share campus networks, so an
IP limit punishes a building. Enforced at the Worker before any tool runs.

## Testing Decisions

A good test here asserts what a caller observes and nothing else: the result
of a tool call, the status of an HTTP response, whether a write was accepted.
Tests that reach for which file was read, or how a catalog was cached, will
fail on every refactor and tell nobody anything. The existing MCP suite is
the model — it drives whole tools and asserts on their output.

**`executeTool`** stays the seam for tool behaviour, including the new
simulation tool. Forty-three tests already run through it. Nothing about
hosting changes what a tool returns for a given Plan and catalog, so nothing
about hosting needs a parallel set of tool tests.

**`CatalogSource`** gets one contract test run against both implementations.
The same assertions, the same expected answers, two backings — which is the
only way to be sure the hosted and local servers agree about what a Course
requires. Prior art: the engine's edition fixtures.

**`PlanStore`** gets the same treatment, with the concurrency rules as its
centrepiece: a write based on a current `rev` is accepted; a write based on a
stale one is rejected rather than merged; a rejected write leaves the stored
Plan byte-identical. That last assertion is the one that matters, because the
failure being prevented is silent loss.

**The Worker's fetch handler** is tested as a plain function from `Request`
to `Response`, which the web-standard transport makes possible without
running a server. This covers the hosted-only paths: an unauthenticated
request is refused, a token for one student cannot read another's Plan,
a rate-limited student is refused before any tool runs, and a malformed body
produces a JSON-RPC error rather than a stack trace. Token verification is
exercised here rather than as its own seam.

Row-level security is asserted directly against the database, not through
the application. A policy test that passes only because the application
happened to filter correctly is not testing the policy.

The published connector URL is asserted against the implemented route, so
the documentation cannot drift from the service again. The current failure —
a live page advertising a host that does not exist — went unnoticed precisely
because nothing compared the two.

## Out of Scope

Anonymous or catalog-only access. The decision is that the connector is
gated; a degraded signed-out mode is a second product surface to maintain
and was explicitly not wanted.

Accepting a simulated Plan from the assistant. Simulation returns a
candidate; adopting one is an act in the planner and is specified separately.

Migrating Plans that exist only in a browser today. Sign-in already pushes
them under the existing sync, and the one-time behaviour for a student with
both a local and a remote Plan is unchanged by this work.

Real-time propagation. The planner and the connector reconcile on read, not
over a live channel.

Publishing the local server to npm. It stays a workspace package; the hosted
connector is the supported route.

The interim correction to `/connect/`. That page is wrong in production right
now, and fixing its copy should not wait for this spec to be built — it is a
few minutes of work and should ship on its own.

## Further Notes

The measurements driving the hosting decision were taken on this catalog and
should be re-taken if it grows: 64 MB heap, 138 MB RSS, 158 ms parse, against
a 128 MB isolate ceiling. The split artifacts are what bring it under, and
they exist today.

The sharpest risk in this spec is not OAuth and not the Worker. It is that
four tools can write to a Plan the student is also editing. Everything about
`rev` exists to make that failure loud instead of silent, and the test that
matters most is the one asserting a rejected write changed nothing.

A second risk worth naming: the consent guard on removing a required Course
was designed for a local file. Hosting it means a remote model can reach a
student's real Plan, and the guard is the last thing standing between a
misread sentence and a dropped requirement. It is tightened here rather than
carried over unchanged, and it should be reviewed as a security boundary
rather than as a UX affordance.
