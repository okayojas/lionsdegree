# LionsDegree — Decisions & Incident Log

A running record of deliberate design decisions (with rationale) and things that went wrong
(with root causes and fixes). Ordered roughly chronologically within each section.
Companion to `README.md`; project memory lives with the AI assistant's notes.

---

## 1. Product & architecture decisions

| Decision | Choice | Rationale / rejected alternatives |
|---|---|---|
| Platform | Web app + installable PWA | One codebase for desktop + phones; app-store wrappers (TWA $25 / Capacitor $99+review) deferred until users ask. Native rewrite never needed. |
| AI tiers | Free = rate-limited `gpt-5-mini` via our proxy; paid = `gpt-5` + web search | User has an OpenAI key (not Anthropic). Rejected: fine-tuning a small model (teaches style, not facts — would hallucinate prereqs); self-hosted GPU (~$150-400/mo idle > API costs); in-browser WebLLM (2-3GB download, excludes phones, weak tool-calling) kept as a possible later free path. |
| RAG strategy | Tool-based retrieval over local catalog (search/details/audit/chain tools), no embeddings in v1 | Deterministic, offline-capable, no hallucinated course data. Embeddings (`text-embedding-3-small`) optional later for semantic elective search. |
| Accounts | Local-first (localStorage/IndexedDB), optional sign-in later (Supabase, Google + Microsoft OAuth) to sync | Zero-friction first use; PSU students all have Microsoft accounts. Required accounts rejected (adoption friction). |
| Sync conflicts | Compare-and-swap on `rev`: a write names the revision it last saw and lands only if the server is still there; otherwise refused and surfaced (ADR 0003) | Was last-write-wins. Two tabs editing one Plan destroyed each other's work silently, which is the one failure this project cannot have. CRDT still rejected as overkill: one user, whole-doc unit, rare conflicts — refusing is enough. |
| Chat architecture | Client-owned tool loop; server = stateless streaming proxy | Plan is local-first, so tools execute in the browser against local state. Server injects system prompt + tool defs (client can't override), holds the API key, rate-limits. Server-authoritative rejected: would mirror plan state per message and break anonymous use. |
| Flowchart renderer | Port the demo's custom column-snapped SVG renderer | React Flow rejected: its free-form graph model fights column snapping, credit headers, and eval-derived edges. Demo math was proven; ported to Pointer Events for touch. |
| Hosting model | Static CDN (Cloudflare Pages) + stateless Worker + Supabase | Catalog is read-only between semester scrapes = perfect static case. Kubernetes rejected: it's compute orchestration, not storage; $50-200+/mo + ops burden for zero benefit. |
| Scraper cadence | Last week of August + first week of January | Matches semester starts (user decision). Raw HTML disk-cached so re-parses never re-fetch. |
| Name | LionsDegree | User decision. "Nittany Lion(s)" is PSU-licensed; bare "Lions" is lower risk but do a USPTO check before buying the domain. Keep "not affiliated with Penn State" disclaimers prominent. |
| Credit cap for optimization | 19 credits/semester | PSU full-time tuition covers up to 19; above that costs extra (user requirement). |

## 2. Data-pipeline incidents (what broke, why, and the fix)

### 2.1 The demo's prereq parser silently dropped requirements
- **Symptom:** regression tests against the original demo catalogs showed ASTs missing courses.
- **Causes:** square brackets not treated as parens (`EE 200`: "[CMPEN 270 or ...]"), and label
  phrases ("One of: (…)" in `CAS 472`) consuming the whole expression.
- **Fix:** brackets = parens; label-phrase-before-group skipped; unconsumed trailing tokens joined
  with implicit AND so leftovers degrade to UNK ("verify manually"), **never to falsely-satisfied**.
  Deviations documented in `prereq.ts` headers. Rule established: *conservative degradation only*.

### 2.2 Embedded "Enforced Concurrent" labels mid-prereq-string
- **Symptom:** `CMPSC 121` prereq parsed as garbage; red edge on the bulletin's own suggested plan.
- **Cause:** 197 courses embed a mode switch mid-sentence: "MATH 110 **or Enforced Concurrent at
  Enrollment:** MATH 140". One string, two enrollment modes.
- **Fix:** new `concurrent` AST node wrapping per-segment subtrees; mixed-string splitter
  (`parseMixedPrereqText`). Raw text always preserved for display.

### 2.3 Program slug collisions across campuses
- **Symptom:** 756 programs discovered, only 602 files — `accounting-bs` exists at 5+ campuses and
  they overwrote each other.
- **Fix:** slugs are college/campus-prefixed (`abington-accounting-bs`).

### 2.4 ESC 410: the bulletin contradicts itself (dangling course references)
- **Symptom:** flowchart showed "ESC 410", which doesn't exist (real course: ESC 410H).
- **Root cause:** the bulletin page itself contains the stale code. CourseLeaf's own renderer
  signals this: broken references render **unlinked with an empty title cell** — a signal we
  initially ingested as trustworthy data.
- **Scale:** 470 distinct dangling codes, 1,723 references across all programs, in classes:
  suffix typos (ESC 410→410H, 96 refs), generic family refs (CAS 100→100A/B/C, 216 refs),
  parser false positives ("THE 400", "OPTION 4" — case-insensitive regex matching prose),
  wildcards ("BIOL 4XX"), genuinely discontinued courses (LA 283 et al.).
- **Fix:** referential-integrity validator (`validate/integrity.ts`): unique suffix variants
  resolve in place (with `resolvedFrom` provenance); families expand into `alternatives`;
  the rest are flagged `unverified` (amber "verify with adviser" cards — never confident ones).
  Code-token regexes made uppercase-only; wildcards rejected as course codes.
- **Follow-up (ESC 411):** the same staleness lives inside *prereq strings* ("ESC 410" in
  ESC 411's enforced text), so AST leaves get the same resolution pass (`resolveCourseAsts`).
- **Follow-up (stale client flags):** `unverified` was baked into saved plans; once the catalog
  gained the course, old plans still showed amber. Rule: **the live catalog is the render-time
  authority**; pipeline flags feed the review queue only.
- **Follow-up (#19): "uppercase-only" was applied to one of two code paths.** 120 rows across 90
  programs still listed sentences as courses. A requirement row containing brackets is tried as a
  boolean expression (`CHEM 210 & (CHEM 213 or CHEM 213W)`) by the **prerequisite** tokenizer,
  which is case-insensitive by design — prereq prose really does write "chem 210". Run over an
  ordinary sentence it harvests words: `Select 15 credits from College-approved list (at least 3
  credits must be at the 400-level)` yielded `SELECT 15`, `LEAST 3`, `THE 400`, which is why the
  phantoms appear in groups. Fixed by requiring every code a boolean row produces to appear
  **capitalised in the source text**, rather than by adding a stopword list — a word list is wrong
  the first time a subject looks like a word (`ART`, `BA`, `LER` are all real), and the first
  attempt at one missed four of the twenty-eight codes it was written for.
- **Two rules this incident is the evidence for.** (1) *A rejected row must fall through, never be
  deleted.* In several programs the harvested sentence is its section's only trace of the
  requirement, so dropping the row would drop the rule; rejection sends it to the comment
  classifier, which keeps the prose for review (iron rule 2). (2) *Unreadable beats confidently
  wrong.* Two sections in `agricultural-sciences-agribusiness-management-minor` went from readable
  to unreadable here — `Select 6 credits from any 400-level ABGM courses (excluding, unless
  approved by the AGBM program, AGBM 496)` had produced a pool whose only course was AGBM 496, the
  one course that sentence **excludes**. A coverage metric getting worse because the data got more
  honest is the one case where raising a ratchet is right.
- **Follow-up (#19 review): the integrity pass skipped course *pools*.** `selectCredits.from.kind
  === "courses"` was the one code-bearing shape that never ran `resolveCode`, so a bulletin writing
  `WMNST 301` where the catalog has `WMNST 301N` left a pool entry matching no takeable course —
  563 of them. Pools get the same resolution as everything else, with one difference: an expansion
  contributes **every** variant (holding any of them satisfies the requirement), and the result is
  deduped, because a Pool is a set. Unresolvable entries fell 563 → 415.

### 2.5 LLM transcription fabricated elective-list data (the most important lesson)
- **Symptom:** ESM Foundational/Technical Elective lists in the app contained ~48 courses not on
  the department page — including MATSE 444/448, which **don't exist at Penn State at all**.
- **Root cause:** the list was ingested via an LLM page-summarization tool. Where the (PDF-derived,
  truncated) source read "MATSE 400, 402, 443", the model "helpfully" continued the pattern to 28
  courses. 46 of 48 fabrications were *real* courses just not on the list — invisible to
  referential-integrity checking.
- **Fix + rule:** rebuilt from a deterministic parse of the raw HTML. **No LLM output is ever
  written into the dataset.** LLMs may *flag* rows for review (needs_review queue); extraction is
  always from source bytes.

### 2.6 Hyphenated subject slugs silently skipped
- **Symptom:** all A-I (Artificial Intelligence) courses missing from the catalog; AIE track had
  no connections.
- **Cause:** subject-discovery regex `[a-z_0-9]+` didn't allow `-`; `a-i` and `c-s` were never scraped.
- **Fix:** regex includes hyphens; A-I stored as `AI 100` with alias `A-I 100` (demo's alias
  mechanism handles both spellings everywhere).

### 2.7 Bulletin suggested plans violate their own enforced prerequisites
- **Symptom:** fresh AIE plan showed a red edge: STAT 401 scheduled in the same semester as
  A-I 305, which enforces it as a *prior* course.
- **Confirmation:** the department's own advising flowchart (advising.engr.psu.edu) puts STAT 401
  a semester earlier — departments quietly correct the bulletin.
- **Fix:** generation-time repair pass (`repair.ts`) moves in-plan enforced prereqs earlier until
  stable, with a visible "we adjusted this" note. Triggers on anything short of cleanly-satisfied
  (or-groups with external alternatives read UNK, not UNSAT). Validated against all 28 official
  engineering flowchart PDFs (parsed spatially with word coordinates; EMET excluded — no columns).

### 2.8 AP credit data is behind a JS wall
- **Problem:** PSU's AP page loads per-exam data via Next.js server actions; no HTML tables, no
  client CMS tokens, Wayback snapshots have the same architecture.
- **Fix:** headless browser clicks every exam card and captures the server-action responses —
  clean CMS JSON parsed deterministically (rule 2.5 respected: browser automation is fine, LLM
  transcription is not). Course names arrive as prose ("Chemistry 110") and map to prefixes via
  the scraped subject index. Faithful quirks preserved: Computer Science A awards only general
  credits; Biology's "BIOL 011/012" don't exist in current descriptions and render unverified.

## 3. Scheduling-engine decisions

- **Course-based progress, not semesters-completed** (user insight): the onboarding asks *which
  courses* from the track you've taken. The template is walked in full; satisfied entries drop;
  emptied semesters compact away and labels reflow. Handles major-switchers, gap semesters, AP.
- **Cross-program optimization:** a double major shares ONE set of gen-ed/elective slots (max per
  requirement kind, not sum — labels normalized so "Technical Elective (400-level)" merges);
  one program's courses absorb another's elective slots via structured requirement rules
  (each fulfilling course consumed once). Department elective lists not in the bulletin (ESC's
  FE/TE) live in `data/overrides/electives.json` with source URLs.
- **Directional content coverage** (user correction that shaped the design): "MATH 251 covers
  MATH 250" is one-way. Mined from bulletin description sentences — "Students who have passed X
  may not schedule this course for credit" (in Y's description ⇒ X covers Y), "This course is a
  combination of A and B" (⇒ covers A and B). Or-group co-occurrence was rejected as the primary
  signal because it's symmetric. Coverage satisfaction is non-consuming (251 satisfies both 250
  and 252 entries). Symmetric "credit for both" sentences recorded as exclusions, informational only.
- **Schedule optimizer — FLOW-ORDERED PACKING (2026-07-15 rework, two iterations):** the original
  critical-path re-packer (prioritize by longest dependent chain) produced plans that felt "out of
  order" vs the flowchart; a first fix that ANCHORED each course to its absolute template semester
  fixed the order but kept the flowchart's 8-term SPACING (too spread out — a motivated student
  could finish sooner). Final design keeps the flowchart's ORDER but not its spacing: graduate in
  the fewest full-time terms (≤19cr, aim high 14-19), difficulty still rising over time. Every item
  records `origin.{program,templateSem}` (persisted). The optimizer sorts courses by that flow rank
  and distributes them EVENLY across the packed length via a **flow-rank anchor** — the k-th of M
  courses can't be scheduled before term `floor(k·N/M)`, so intro courses land early and 400-level
  ones stay late, spread over every term (no course gaps that fill with an all-elective "ghetto").
  Slots interleave: ~1 gen ed RESERVED per term before courses fill (reservation is what keeps the
  ≤2-GE-gap invariant); electives spread EVENLY over the remaining terms (elShare = remaining/rem
  terms) so they last through the senior terms instead of front-loading and leaving a thin tail —
  a mix in every term (only the first term is prescribed-only). `targetSemesters` spreads the same
  work across exactly N terms (best effort; reports `targetMissed` when the work can't fit N terms
  at the cap — returns the tightest feasible count instead of a ragged over-long plan). Leaf-level
  feasibility + deadlock force-place retained; still the LAST pass; runs at generation and the
  toolbar "Optimize"; manual moves reset. Chosen elective COURSES ride the spine like any course;
  only generic placeholder slots follow the elective spread.
- **Elective placement — MINED CURVE, not even spread (2026-07-17 revision, user insight verified
  against 1,078 suggested plans).** User: front-load the defined core, phase technical electives in
  near the end, before/during the capstone. Measured across every bulletin suggested plan:
  prescribed-course share falls 0.174→0.072 across the plan while elective-placeholder share rises
  0.032→0.238 (7×) — the user's intuition is exactly the bulletin's own shape. Implementation:
  `electiveCurve` mined into flowchart-patterns.json (miner now also samples all templates, not
  just the 28 charts); elective slots laid onto the curve by largest-remainder apportionment
  (term 0 always prescribed-only); the course anchor became CAPACITY-WEIGHTED (each term's course
  room = cap − gen-ed reserve − curve-share of electives, courses laid onto cumulative capacity in
  flow order) so the core front-loads complementarily; while spine courses remain, per-term
  elective take is capped to keep ≥2 courses of room (the mix survives, no all-elective mid-plan
  term); once the spine runs dry, remaining slots SPREAD over the remaining estimated terms rather
  than flooding one (so TEs run alongside the capstone terms). Capstone block placement rewritten
  to be CONTIGUOUS: earliest start where the whole sequence fits consecutively (feasibility is
  monotone in start term), with an honest fallback (place at end, red edge) when a capstone prereq
  lives outside the plan. History of this knob, for the record: senior-only (v1) → even spread
  (v2, over-correction after the elective-ghetto bug) → mined curve (v3, matches the data).
- **Capstone-term consolidation (2026-07-17, same session):** the mined curve alone still trailed
  thin capstone terms (ESC: 410H alone at 6cr, 411 at 2cr — two wasted semesters). User rule: the
  final terms must reach full-time load (14-19) by fitting technical electives THERE. Fix: a
  CONSOLIDATION RESERVE — before curve distribution, enough elective slots to bring each capstone
  term to ~15cr are held back (taken from the template's tail = the TE-flavored ones; the first
  member of a multi-course sequence skips the reserve since it rides a full spine term, e.g.
  1-credit ESC 409); after the contiguous block lands, the reserve BACKFILLS the capstone terms
  last-term-first up to the target; leftovers land in the latest terms with room, never dropped.
  Result: ESC 9→7 terms (all 17-19cr; 411's term = 17cr with 5 TEs), ESC+AIE 12→10 (all 17-19),
  AIE 7 with 489W at 16.5cr among TEs. Pinned by test: every term 14-19, final term carries slots.
- **General flowchart-pattern learning:** the optimizer's priors are not hard-coded from one
  student's spreadsheet — they are mined deterministically from the aggregate of all 28 engineering
  advising flowcharts (`scripts/mineFlowchartPatterns.ts` → `flowchart-patterns.json`): gen-ed
  cadence, the 400-level advanced-work curve (the elective rise), capstone start position + max
  sequence length, credit load. A program WITH an official flowchart anchors to its own template; a
  program WITHOUT one falls back to this general prior (test: a non-engineering major still gets a
  prior-conforming plan — prescribed-dense sem 1, ≤19cr, zero violations). Iron rule 1 respected:
  deterministic stats over already-parsed placements + catalog facts, never LLM output. The engine
  ships built-in defaults so it stays pure/testable; the web app passes the mined file in.
- **Capstone detection + dual-major rule (data-driven):** a capstone is a TITLE match (senior
  design/research/thesis/culminating/project design) on a course in the final template window;
  from that titled seed we grow the connected same-subject prereq component (catches ESC 409 →
  410H → 411 whether the titled member is first or last). Title is REQUIRED — position alone gave
  false positives (a regular 400-level chain like AI 370→341W→410 was wrongly dragged to the end and
  scattered mid-level courses, stretching the plan). The kept sequence lands one-course-per-final-
  semester, each advanced to the first late term where its OWN prereqs are satisfied and there is
  cap room (AIE 489W enforces AI 410 + AI 341W — a naïve last-term anchor put it alongside a prereq
  and drew a red edge; feasibility-aware placement fixes that). Position is the only lever for the
  senior-standing gate, which is UNK free text. Dual major with two capstones: keep the longest
  (tie → most credits), move the
  other's courses to `removed` (restorable) with an adviser-verification toast — the user's rule
  (ESC's 3-semester capstone kept over AIE 489W).
- **Completed courses satisfy prereqs from off the chart** via virtual sem -1 schedule entries;
  marking a course complete removes it from future semesters (time-awareness) with restore paths.
- **Gen Ed: category-aware slots + double-count optimization (2026-07-15).** The 45-credit
  baccalaureate framework is an engine constant sourced from the bulletin (Foundations GWS 9 + GQ 6;
  Knowledge Domains GHW/GN/GA/GH/GS 3 each; Integrative Studies 6 inter-domain; Exploration GN 3 +
  6 flexible) — the scraper doesn't capture the program pages' Gen Ed tab, and this is stable
  university policy like the 19-credit cap. Verified rules encoded: (a) **department restriction** —
  Knowledge Domains + Exploration can't be met "by taking courses in the department or program
  identical to that of the academic major"; Integrative Studies exempt, Foundations unrestricted.
  Applied CONSERVATIVELY: only to user-added/completed courses (keyed off missing `origin`);
  template-placed courses are bulletin-endorsed ("Program requirements that may also satisfy
  General Education requirements") and always count. Major-dept prefixes derived over-strictly
  (subjects with ≥2 template courses at 300+) — over-strictness degrades to an extra card, never a
  falsely-satisfied requirement. (b) **US/IL overlay** — 3cr each, double-counts with gen ed/major/
  electives, but one course can never cover both (Senate 150-00). `auditGenEd` is deterministic
  most-constrained-first assignment (each course fills at most ONE bucket; a 4cr course over-fills
  a 3cr bucket without spilling; inter-domain courses go to Integrative, never single domains).
  `refineGenEdSlots` (runs before every optimize, idempotent) names generic "GE" cards by remaining
  category, DROPS cards whose bucket the major's own courses already cover (ESC: sciences+econ
  cover GN/EXP/GS → 1 card dropped, rest become GA/GH/INTER/INTER), adds cards for uncovered
  buckets, and stamps "pick a course that also carries IL/US" hints on the best slots.
  `rankGenEdPicks` filters suggestions by the slot's category, excludes own-dept courses for
  restricted buckets, and ranks unmet-US/IL carriers first ("also fulfills IL" chips). Chat
  `fill_slot` rejects category mismatches and returns the efficient picks. BA-specific requirements
  and the world-language Exploration option are explicitly out of scope (noted in genEd.ts).

- **Schreyer Honors College (2026-07-16).** Requirements verified from shc.psu.edu (third-party
  pages had stale numbers — 9/14 vs the real 21/14): first-year admits need 21 honors credits in
  years 1-2 (incl. ENGL/CAS 137H→138T "during your first two semesters", C+) then 14 in years 3-4;
  Gateway 2nd-year admits 9 (yr 2) + 14; 3rd-year admits 14; honors thesis for all; 3.40 GPA
  (note-only). `PlanDoc.honors = {admit: 1|2|3}` from an onboarding question. Detection: "Honors"
  attribute or H/M suffix (ENGL 138T caught by attribute). Engine `honors.ts`: `auditHonors` maps
  plan terms → academic years (current year from completed credits ÷30), sums honors credits per
  requirement window; completed honors credits pool into the EARLIEST window first (a Gateway
  junior's prior honors work fills yrs-1-2 before 3-4 — exact for the common cases, never inflates
  the active window). `applyHonorsUpgrades` makes the schedule MEET the requirement: swaps
  prescribed courses for catalog-verified H-twins (MATH 140→140H, CHEM 110→110H — twins exist for
  most of the freshman core) and the RCL pair, originals kept as alternatives (one-click revert).
  **Key incident:** upgrades computed pre-optimize didn't survive packing — the optimizer shifts
  which academic YEAR a course lands in (EMCH honors drifted from yr 2 to yr 3, leaving yrs 1-2 at
  11/21; CAS 138T inherited CAS 100A's template position and drifted to sem 4, violating the
  first-two-semesters rule). Fix: RCL courses get origin PINNED to templateSem 0/1 (+ physical move
  with slot rebalance), the RCL audit checks TIMING not mere presence, and the upgrade pass runs
  AGAIN post-optimize on the final layout (swaps are in-place, so no re-pack). Verified: ESC
  first-year Scholar = 21/21 + 23/14, RCL in sems 1-2, zero violations. **H-twin prereq stand-in:**
  swapping MATH 140→140H must not break MATH 141's edge — buildSchedule/optimizer register H/M
  courses under their base code (when the base exists); directional, base never satisfies honors.
  Honors options on regular sections and grad courses aren't in the catalog — shortfalls say
  "honors options can cover the rest", never silently assumed (iron rule 2). Honors gen eds get a
  ranking bonus in slot suggestions for Scholars (one card, two requirements).

## 4. AI-assistant decisions

- Hard rules in the server-owned system prompt: never state course facts that didn't come from a
  tool; personalize after the objective answer ("what it means for you" + next step); not official
  advising.
- `get_prereq_chain` tool added after a real failure: chain questions caused unbounded
  tool-call loops that blew the message cap (the "messages must be a non-empty array" bug — the
  cap error was also misleading). One tool call now returns the whole recursive tree with
  per-course status. Client trims old turns without splitting assistant/tool groups.
- `optimize_schedule` tool + loop hardening (2026-07-15): "consolidate so I graduate in 6 semesters"
  timed out — with only `move_course`, the model hand-reordered ~50 courses over dozens of
  round-trips and hit the round cap with no final answer (same class of bug as get_prereq_chain).
  Fix: (1) a single deterministic `optimize_schedule` tool that calls the engine optimizer in ONE
  call (optional `semesters` target); system prompt steers all consolidate/condense/graduate-faster
  requests to it. (2) The client loop was ALSO fragile: no per-request timeout (a stalled stream
  hung forever) and, on hitting `MAX_TOOL_ROUNDS`, it exited after the last tool batch with no
  closing model turn → a dead empty bubble read as "timed out." Added an `AbortController` 45s
  timeout and a graceful round-cap message. General rule: a bulk plan mutation belongs in one
  deterministic tool, never a model-driven per-item loop; and the loop must degrade to a message,
  never hang.
- Chat state lives above the tab switcher; the chat tab hides instead of unmounting (switching to
  Requirements previously killed in-flight generation).
- Every AI turn snapshots the plan first → one-click undo. Destructive tools are gated by wording
  and undo rather than confirmation dialogs (flow preservation).

### 2.9 The 25-credit dual-major semester (optimizer/repair interaction)
- **Symptom (user report):** ESC+AIE double major generated a first semester over the 19-credit
  cap (25 in the user's run; 30 in reproduction), and gen eds / technical electives were all
  shoved into pure-elective semesters at the end of the plan.
- **Root causes (three interacting defects):**
  1. The optimizer's feasibility check evaluated the *whole* prereq expression — or-groups with
     external branches ("MATH 140 or placement exam") read UNK, so courses placed *before* their
     in-plan prereqs. The canvas judges red edges per-leaf; the optimizer didn't.
  2. The cap-blind repair pass ran *after* the optimizer and "fixed" those red edges the only way
     it knows — moving prereqs earlier — stacking semester 1 far past the cap. The credit cap
     lived only in one pass, and that pass didn't have the last word.
  3. Course-first greedy packing used slots purely as leftover filler, so a dual major's large
     course supply produced seven course-only semesters followed by an elective ghetto.
- **Fixes:**
  1. Leaf-level feasibility in the optimizer (any in-plan prereq leaf violated OR still unplaced
     ⇒ not placeable) — exactly the red-edge rule, so optimizer output needs no repair.
  2. Pipeline ordering rule: **the cap-aware optimizer is always the last pass**; repair runs only
     on the non-optimized path. (General lesson: an invariant enforced in one pass is no invariant
     at all unless that pass runs last.)
  3. Interleaved packing: each semester reserves ~1 gen ed (while any remain) plus an even share
     of electives before courses fill the rest of the ≤19 budget — matching the bulletin's rhythm.
  4. Completing a course auto-re-optimizes when the chart has no manual arrangement; otherwise a
     toast points at Menu → Optimize rather than silently reshuffling the user's layout.
- **Verified:** ESC+AIE now packs 11 semesters at 18–19 credits, zero violations, 1 GE + 1–2
  electives nearly every semester; pinned by test ("dual-major optimizer invariants").

- **Summer sessions (2026-07-18).** Opt-in, YEAR-keyed (`PlanDoc.summerYears`; Summer 2027 sits
  between Spring 2027 and Fall 2027) so the choice survives re-packs and index shifts; engine
  `terms.ts` owns the Fall→Spring→(Summer)→Fall sequence and label parsing. Summer terms cap at 9
  credits (realistic one-two-courses-per-session load) and are exempt from the full-time floor;
  Schreyer year-mapping is label-aware (a summer closes its academic year). Capstone block occupies
  consecutive REGULAR terms (skips summers). Entry points: course card "Take it in Summer YYYY"
  (creates session + pin constraint + re-optimize), chat `add_summer_session`, and
  `store.addSummerSession` remaps index-keyed state (constraints/moves/added) at insertion.
  **Optimizer redesign forced by this feature** (the estimate-ahead approach kept missing by ±1
  term): nEst = minimal cumulative-capacity walk through the real term sequence (a summer's 9cr
  SHRINKS the calendar — its whole point); perSemTarget = even spread of the total over the
  estimate (uniform density, no packed-19s-then-thin-remainder); capstone block anchors on the
  swept tail and MAKES room by evicting prereq-free slots to earlier terms (room is made, not
  predicted); a final light-term rebalance pulls slots into sub-14 terms (donors may drop to 12 —
  PSU's actual full-time floor; direction-aware so electives aren't dragged forward). Pinned:
  summer between Spring/Fall, ≤9cr, capstone never in summer, calendar never lengthens, every term
  ≥12 with ≥14 average, zero violations.

### 4.1 The AI 100 incident: constraint-blind optimization + fragile undo + amnesia (2026-07-18)
- **Symptom (user report):** "I can't take AI 100 in Fall 2026" → the assistant REMOVED AI 100 plus
  several technical electives to "consolidate"; "revert AI changes" did not restore the plan; asked
  what happened, the assistant DENIED having done it.
- **Root causes, one per failure:**
  1. No constraint mechanism existed — the model improvised with remove_course, and nothing
     stopped bulk removal of required courses.
  2. Undo was a SINGLE snapshot taken at the start of EVERY turn — the innocent follow-up
     question ("what happened?") overwrote the only good snapshot with the wrecked plan.
  3. The chat wire log is in-memory and trimmed; no durable record of the AI's actions existed,
     so the model confabulated a denial with nothing to check itself against.
- **Fixes (each failure gets a structural fix, not a prompt patch):**
  1. **Durable scheduling constraints** — `PlanDoc.constraints` ({code, not-in|not-before|pin,
     termIndex}); the optimizer honors them in the sweep, capstone block, and deadlock guard
     (pins place as user commands even if red; a course blocked everywhere yields an empty-term
     gap, never a violation or a removal). Settable via chat (set/clear_schedule_constraint) AND
     the course modal ("Can't take it this semester" → constraint + re-optimize). Unlike manual
     `moves` (wiped on re-optimize), constraints survive every optimization — that's their point.
  2. **Undo stack + plan history** — chat undo is a stack of pre-turn snapshots pushed ONLY on
     plan-mutating turns (read-only turns can't clobber it), popped turn-by-turn, cap 20. Plus a
     localStorage ring buffer of the last 15 plan states with cause labels (Menu → Plan history →
     restore) — recovery independent of the chat session entirely.
  3. **Persistent action ledger** — every mutating tool call appends {ts, tool, summary, rev
     before/after} to localStorage; `get_action_history` exposes it; system prompt: consult it
     before answering questions about past changes, never contradict it, admit mistakes plainly.
     Chat messages + wire log also persist to localStorage (reload no longer wipes memory).
  4. **remove_course guards (code, not prompt):** required-template courses need
     `user_explicitly_asked: true` (audited in the ledger); max 2 removals per turn; tool errors
     redirect the model to set_schedule_constraint. System prompt hard rule: scheduling conflicts
     are NEVER solved by removal.
- **Pinned by test** (`constraints.test.ts`, "THE INCIDENT"): AI 100 not-in Fall 2026 on ESC+AIE →
  moved later, every course kept, zero violations, term 0 backfilled to a full-time load; plus
  not-before/pin semantics, capstone-block interaction, durability across re-optimizes, and the
  pathological all-blocked case.

- **IUG (Integrated Undergrad-Graduate) v1 — three structured programs (2026-07-19).** After the
  IUG deep-research (docs/iug-programs.md), built the first three: Smeal Integrated MAcc, Smeal
  B.S. Science + M.B.A., ESM's Engineering Science B.S.+M.S. Pipeline `scripts/scrapeIug.ts`
  deterministically parses each graduate bulletin page (reusing `parseRequirementTables`; no LLM,
  iron rule 1) → `iug/{slug}.json` + `iug/index.json`, grouping the page's stacked degree options
  into TRACKS at each "Total Credits" boundary (so the 81-cr D.B.A. sharing the MBA page is never
  ingested — `pickTrack` takes the leanest positive total). Grad courses already ship via the
  existing `courses/grad/` scrape; buildIndex exposes them as `PREFIX:grad` subjects and the web
  `loadSubject` now merges undergrad+grad per prefix (an IUG mixes 400- and 500/800-level in one
  subject). Engine `iug.ts`: `attachIug` folds the master's on as `phase:"grad"` PlanTerms after
  the bachelor's, computing GCAC-210 double-counting (courses already in the UG plan that are on the
  program's eligible list count toward both, ≤ program cap, 500/800 prioritized for the ≥50% rule);
  `detachIug` reverses it; `auditIug` reports credits + the 60-credit/entrance-to-major gate. The
  optimizer PRESERVES grad terms (re-flows only the undergraduate half, re-appends grad, relabels
  through the term sequence) — so all 106 prior tests stayed green and grad work survives re-optimize.
  Surfaced via Menu → "Add a master's degree (IUG)", course-card nothing, and chat
  list_iug_programs/attach_iug/detach_iug (+ audit_requirements block). Limits (documented): ESM's
  bulletin page uses category menus so its grad course list is thin; only 3 of 41 IUGs structured
  (the rest are the "later" the user deferred); Schreyer individual IUGs (any master's) not yet
  modeled. 111/111 engine tests (+5 iug.test.ts: attach/double-count/preserve-on-reoptimize/detach/audit).

### 4.2 "The AI stopped working" — reasoning-model token starvation (2026-07-20)
- **Symptom (user report):** asked the chat to "recommend some robotics courses" → assistant bubble
  said "no response" (empty). Also generally slow.
- **Root cause:** gpt-5-mini is a REASONING model — reasoning tokens count against
  `max_completion_tokens`. The proxy capped it at 2048 with default effort, so once tool results
  filled the context (a real plan's get_plan is large; search_catalog can return 50 courses), the
  model spent the whole budget reasoning/among tool calls and returned finish_reason "length"/empty
  content → the client's `content || "(no response)"` fallback fired. Verified end-to-end: server,
  proxy, OpenAI, catalog load, and searchCatalog were all healthy and fast (search ~46ms); the
  model's own query was sane ("robotics"). The failure was purely the completion budget.
- **Fix:** `reasoning_effort: "minimal"` (right for a tool-driven advising chat — fast, leaves the
  budget for the answer) + `max_completion_tokens` 2048→8000, both env-overridable
  (OPENAI_REASONING_EFFORT, OPENAI_MAX_TOKENS). After: the robotics turn converges in 3 rounds
  (get_plan → search_catalog → answer) with finish_reason "stop" and a full 2800-char reply, even
  with a large dual-major plan loaded.
- **Companion fix:** the chat's `search_catalog`/`get_course_details` tools call `loadFullCatalog`,
  which fetched ~526 subject files SEQUENTIALLY and rebuilt on every call (un-memoized). Made it
  memoized + parallel + resilient to a single failed file (`apps/web/src/data/catalogClient.ts`) —
  removes multi-second stalls that compounded the timeout. General lesson: for reasoning models,
  budget = reasoning + output; cap generously and default effort low for tool-loop chat.

### 4.3 Optimizer minimizes TIME (fewest-semesters re-pack); restore preservation; removal gate (2026-07-20)
- **Symptom (user report):** "when it CAN consolidate my schedule into a schedule that can shave off
  a semester and stay within 19 credits, it doesn't optimize to that." Reproduced on ESC+AIE: the
  optimizer returned 11 semesters where the credit floor (⌈189/19⌉) was 10 and the prereq critical
  path was 8. Early terms sat at 14-16cr while a 15cr trailing term hung off the end.
- **Root cause:** the sweep optimizes for an EVEN, difficulty-rising load, not for the fewest terms.
  `nEst` was computed correctly (⌈credits/cap⌉) but the mined elective curve + capacity anchor
  deliberately under-fill early terms and back-load electives, so the leftovers overflow into an
  extra term. Nothing consolidated it back: the light-term rebalance only moves slots BETWEEN
  existing terms (never deletes one), so a 14/16cr term is "full enough" and the tail survives. Even
  `targetSemesters:N` couldn't force it lower — the target only fed `nEst`, not the curve/floor.
- **Decision (reverses the even-load priority of §3 for the default path):** the ROUNDED-UP credit
  count is the source of truth for term count; minimizing time is the goal. Added a fewest-semesters
  RE-PACK pass at the end of `optimizeSchedule` (`capReserveFloor`): try to pack everything into
  ⌈credits/cap⌉ terms — reserve ~3cr for one gen ed per term (the user's rule), place the defined
  core first (flow order, earliest prereq-feasible term with room), reserve the capstone courses in
  the final terms, then fill remaining room with electives. Accept the tighter layout ONLY if
  everything fits feasibly; else step the target up a term and retry, so deep prereq chains / pins
  self-correct to the true minimum. The swept layout is the fallback — the pass NEVER lengthens a
  plan. Gen-ed-per-term reservation preserved template order + GE cadence + the Schreyer 21/14
  windows (all 111 tests green — the reservation keeps honors credits from front-loading out of
  years 3-4). Summers bail to the swept layout (per-term caps + regular-only capstone complicate the
  reserve). **Known limit:** a from-scratch plan at ≤2cr of slack (e.g. ESC+AIE with 0 completed =
  189cr, 1cr slack) can still miss the absolute floor by one term — greedy packing can't always solve
  a tight bin-pack. Any plan with normal slack (in-progress students) hits the floor: ESC alone 9→8,
  ESC+AIE with ~2yr done → 8 = floor.
- **Restore was broken (same report thread):** removing a course only flagged `plan.removed[code]`
  and kept the spec in `plan.terms`, but the optimizer rebuilds `terms` from scratch and drops
  removed courses — so after ANY re-optimize the spec was gone and Restore just cleared a flag
  pointing at nothing (the course vanished). Fix: `PlanDoc.removedSpecs` stashes the full course spec
  (with `origin`) on removal; `restoreItem` clears the flag, re-inserts the preserved spec if a
  re-optimize already dropped it, and re-optimizes (guarded by empty `moves`) so it flows back into
  place. Verified: remove → optimize (dropped, spec kept) → restore → optimize (present again).
- **Removal gate:** CourseModal's course-remove now detects a required (template `origin`) course and
  shows a degree-necessity warning that points at "Can't take it this semester" (the constraint that
  keeps the course and reschedules it) instead of the light confirm; non-required courses unchanged.

### 4.4 Gap semesters, add-semester, resizable chat, readable chat (2026-07-20)
- **Gap / skip a semester (gap year, co-op, leave):** `PlanTerm.gap` marks an intentional empty term.
  The optimizer packs coursework IGNORING gaps, then splices an empty term back in at each gap's
  calendar position (a uniform shift — prereq order and the ≤19 cap are preserved), so graduation
  moves back by the gapped term and nothing is removed. Gaps survive re-optimize (read from the input
  term's flag, re-emitted at the same index). Chosen over threading gap-awareness through the packer
  (lower regression risk to the tested sweep/re-pack). Store `deleteSemester`/`restoreSemester`
  (mark/clear `gap` + re-optimize); chat `delete_semester`/`restore_semester`; canvas per-term "✕ Skip
  semester" / "Use this semester" controls. Pinned test: gap stays empty at its index, keeps every
  course, adds no violation, plan +1 term, stable across re-optimizes.
- **Auto-delete of empty semesters:** the optimizer's trailing-empty trim already removes incidental
  0-credit terms; it now runs BEFORE gap insertion so deliberate gaps are never trimmed. (Known gap:
  a term left visually empty by a MANUAL drag — a `moves` override, not a structural empty — clears on
  the next optimize, not instantly; the moves-vs-structure split makes instant mid-plan pruning unsafe.)
- **Add a semester:** store `addSemester` appends an empty term (labeled via `termSequence`); the canvas
  reveals a dashed "+ New semester" dropzone past the last term while dragging a card, and dropping a
  card there creates the term and places the card in it. Transient like any manual move (trimmed if left
  empty on re-optimize). Chat `add_semester`.
- **Resizable advisor panel:** a drag handle (`.panel-resizer`) between the plan and the SidePanel sets
  its width (clamped 280px–70vw), persisted to localStorage (`lionsdegree-chat-w`).
- **Side panel can be put away (2026-11-16):** one button collapses the panel to a named strip (a bar
  under the plan on a phone) and brings it back; persisted to localStorage (`lionsdegree-side-panel`,
  device-only, not synced — it is about the screen, not the plan). The panel is HIDDEN, never unmounted,
  so an advisor reply still streaming survives it; the drag handle goes with it. Starts open.
- **Readable chat:** assistant replies now render Markdown via a tiny dependency-free renderer
  (`chat/ChatMarkdown.tsx`, React text nodes only — no dangerouslySetInnerHTML, safe for model output;
  supports headings/bullets/numbered/bold/code/blockquote). The server system prompt gained a
  "Formatting for readability" block grounding the style in scannability research: BLUF (lead with the
  answer), short bullets one idea each, bold the key terms/codes, a `##` heading only for multi-part
  replies, ≤3-line blocks, a single next-step line. User messages stay literal text.

### 5.0 B2C launch hardening (2026-07-26, from the internal B2C launch spec — not published, see 5.4)

Implemented the spec's Phase 0 gate + safe P1/P2 code-local fixes (the parts with no external
dependency). Deferred items and reasons are tracked at the end of this section.

- **S1 (open billable proxy):** `apps/api/src/app.ts` — reflective CORS replaced with an explicit
  origin allowlist (`ALLOWED_ORIGINS`, localhost only when `NODE_ENV=development`); cross-site
  requests refused via `Sec-Fetch-Site`; a config-gated **Supabase HS256 JWT identity gate**
  (`SUPABASE_JWT_SECRET` verifies the Bearer token with Web Crypto, rate-limits on `sub`;
  `REQUIRE_AUTH` makes it fail-closed). Gate is INACTIVE until Supabase auth is wired to the client —
  logged loudly at startup — so today's Supabase-less chat still works (IP-keyed). Verifier
  unit-tested (valid/wrong-secret/tampered/expired/garbage).
- **S2 (rate limiter):** dropped the client-controlled `x-forwarded-for` fallback; KV read now passes
  `{cacheTtl:0}`; keyed per identity (user sub, else Cloudflare IP, else reject); in-memory map
  evicted at 10k (S9); active backend logged at startup. (Full atomicity still wants a Durable Object;
  documented.)
- **S3:** `Content-Length` checked → 413 before parsing; every wire message runtime-validated;
  `tool_calls` filtered to well-formed function calls; client `system` messages stripped.
- **S5/S8/S13:** real CSP (`default-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`) +
  `X-Frame-Options: DENY` set in Hono `secureHeaders`; upstream OpenAI error bodies logged server-side
  and replaced with a generic message; `/v1/health` returns `{ok:true}` only.
- **S4 (model-attested destruction):** `remove_course` now REFUSES to mutate a required (template)
  course and returns `needs_user_confirmation` — the model can no longer self-assert consent from a
  poisoned description; the student removes it via the card's own confirm. Catalog descriptions fenced
  in `<untrusted_catalog_text>` with a system-prompt rule that fenced text is never an instruction.
  Per-turn removal cap 2→1.
- **S7/S10/S12/S14:** root `pnpm.overrides` (postcss/fast-uri/brace-expansion/sharp) + `audit:ci`
  script; bulletin link rendered only if the URL matches `https://(bulletins.)?psu.edu/`;
  `@hono/node-server` → ^2.0.5; `security.txt` gained `Canonical`.
- **Part 6 external links:** `apps/web/src/lib/externalLinks.ts` — construct-only Reddit/RMP search
  URLs, never fetched, never stored; RMP keyed by campus with hand-filled school IDs (no name→ID
  index). Not yet surfaced in the UI (Phase 2 sequencing).
- **Disclaimer:** persistent footer + strengthened onboarding line — "not affiliated with or endorsed
  by Penn State, verify with your adviser."
- **Already-satisfied Phase 0 items:** no `bulletins.psu.edu/search/` dependence in the app (only the
  standalone demo used it); zero XSS sinks; server owns prompt/model; RLS deny-by-default.

**Deferred / blocked (need external accounts, approvals, or multi-week builds — NOT done):**
`OPENAI` monthly spend cap + volume alert (Cloudflare/OpenAI dashboards); Sentry; S6 xlsx swap (would
change `importSchedule.ts` parsing — needs a tested migration, not a blind swap); the full click-to-
confirm chat dialog (U6 diff-preview mechanism); Parts 3 (program recommender: pgvector, embeddings,
offline profiles, gold queries), 4 & 5.1 (seat alerts + schedule builder — **BLOCKED on PSU Developer
Portal approval**; LionPATH is `Disallow: /`), 5.2 (reviews — needs Supabase tables + .edu
verification), 7 (payments — Lemon Squeezy account + webhooks), 8/9 (React Flow + shadcn/design-token
redesign). `.env` key rotation and git-history check are operational tasks for the user.

### 5.1 UI token refresh (2026-07-27, spec Part 9 — "token refresh + polish" scope)

Chose the visual-refresh path over the full shadcn/Tailwind migration or React Flow rebuild (user
picked "token refresh + polish" pre-beta). Kept plain CSS + the hand-rolled canvas; rewrote
`apps/web/src/styles.css` into a three-tier token system: primitive scales → semantic roles
(`--bg/--surface/--border/--text/--primary/--success/--warning/--danger/--focus-ring` + spacing 4px
grid, radii, shadows, type scale) → legacy aliases (`--card/--ink/--muted/--blue/--line/...`) mapped
onto the semantic roles so existing markup kept working with no component churn. Radix-inspired
indigo primary + slate neutrals; course codes/credits now in a mono stack; modern light toolbar
(was heavy PSU-blue). Fonts use the neo-grotesque system stack (Inter first if installed) — no web-font
fetch, which the CSP would block; self-hosted Inter is a later drop-in. **Full dark mode**: tokens
redefined under `@media (prefers-color-scheme: dark)` + `:root[data-theme]` override; theme applied
before paint in `main.tsx` (bundled module, not an inline script — CSP-safe) + a toolbar ☀️/🌙 toggle
persisted to `localStorage` (`lionsdegree-theme`). Fixed hardcoded inline colors that would break dark
mode in AccountMenu/CourseModal/ImportModal. Typecheck + build clean. Deferred (still Part 8/9):
shadcn/Radix components, Lucide icons, Motion, and the React Flow canvas rebuild.

### 5.2 "Transit map" identity, muted edition (2026-07-27, frontend-design + emil-design-eng)

Final visual identity (supersedes §5.1). User feedback drove it: earlier passes were too high-contrast
(stark white / near-black) and typographically incoherent (mono used on eyebrows, headers, tabs, codes
— "all over the place"). Kept the subway/route-map CONCEPT the user liked. Decisions:
- **Muted palette.** LIGHT = warm cream (`--bg #f1ebdf`, cards `#faf5ea`) with warm soft-black ink —
  never stark white. DARK = muted slate-gray (`--bg #262a30`) with warm off-white text — never
  near-black; the warm off-white ties the two themes together. ONE accent taken from the LionsDegree logo — **Beaver Blue
  `#1d417f` in light, a softened Pugh Blue `#8db6d8` in dark**, with the logo's navy `#041f46` as the
  structural tone (#18, 2026-10; superseded the violet `#6b3fa0` / lavender `#bfa9ea`, which in turn
  superseded transit-blue `#37568c`). The green route (`--route-b`) stays as the complementary second
  line; status desaturated. Adopting Penn State's own colours is why the unaffiliated disclaimer
  carries more weight than it otherwise would.
- **Font:** self-hosted **Space Grotesk Variable** and **JetBrains Mono Variable**
  (`@fontsource-variable/*`, imported in `styles.css` beside the tokens that name them, bundled
  same-origin under CSP `font-src 'self'`). Space Grotesk is the one UI face; mono is codes and
  literal machine text (see the amendment below).
- **One unifying font.** Single sans (`--font-sans`) for ALL UI text and wayfinding labels (labels are
  uppercase + letter-spaced in that same sans, not a second face). Monospace reserved STRICTLY for
  course codes (`.card .code`, `.sr-code`) — the one deliberate, consistent exception. This is the fix
  for the incoherence complaint. (Distinctive display type still wants a self-hosted face later; CSP
  blocks web-font fetch, so treatment carries it for now.)
  - **Amended 2026-10-09 (#14).** The rule above is about DECORATION: it exists so a second face
    cannot be used for emphasis or flavour. It does not reach literal machine text. The landing page
    carries an MCP config block and the filenames `claude_desktop_config.json` and `.mcp.json`, and
    setting those in a proportional face would be worse, not more coherent — a reader has to be able
    to tell a literal from prose around it. So: monospace is for **course codes and literal machine
    text** (code blocks, config keys, filenames, CLI flags), and for nothing else. Still no second
    face for emphasis, headings or labels.
  - **Both faces load from `styles.css`, not from an entry point.** `--font-mono` named JetBrains Mono
    for months while nothing shipped it, so the planner — where course codes overwhelmingly appear —
    fell back to Consolas on Windows and SF Mono on a Mac. The faces now sit beside the tokens that
    name them, so any entry that uses a token gets the face backing it. Both bundles are asserted in
    `apps/web/test/build-output.test.ts`; the first version of that test read only the landing
    stylesheet and passed green while the planner shipped no mono at all.
  - **Amended 2026-11-16 (#60, #61).** A third face, **Raleway**, for display type on the pages
    OUTSIDE the planner: their headings and the links in their shared header, at 500 with tight
    tracking. The one-face rule was written to stop a second face being reached for as emphasis
    inside the app, and it still holds there — the planner loads no Raleway and sets nothing in it.
    The owner's landing prototype is set in it and the pages around the landing have to read as the
    same site. Self-hosted like the other two (`@fontsource-variable/raleway`, imported by
    `site.css` only), so the CSP's `font-src 'self'` does not move; `site-surface.test.ts` pins the
    whole policy line so that adding a face can never quietly become allowlisting a font host.
- **The landing page is a document, with a scene to be laid over it (2026-11-16, #60, #64).** A
  change of direction, and the third landing page. The one it replaces was warm dark, one canvas,
  a 3D journey along a real prerequisite chain to a real scheduling conflict
  (`Landing-Page-Canvas-Spec.md`, `docs/landing-3d-journey.md`; both now marked superseded, with
  the two specs before them). It explained the product well and showed the wrong thing: a
  conflict, when what the product is for is the whole of a degree falling into order. The owner
  prototyped that instead (`gravity-landing-test.html`): the courses of one sample Plan as a pile
  that becomes a rectangle, eight Terms of six.
  - **The page is complete with no script.** The prototype hid its hero until a script ran, put
    the page behind a loader, and asked two other hosts for its fonts and its renderer. None of
    that shipped. `/` is four short sections and a footer in the markup. The scene (#65) is to
    replace the sample Plan for the eye and for nothing else, and a visitor it cannot reach
    (scripts off, no WebGL, reduced motion, a screen reader) is given the same Plan as a list.
  - **So the words have to be true without the scene.** The prototype's copy narrated the
    animation: "Keep scrolling and the field gives in to gravity", "Everything falls", "The rest
    fall away", "The whole plan lifts off the page and rushes past you". Text that describes
    motion a reader is not being shown is false for exactly the readers the static page is for.
    Those went. The catalog and plan sections keep the rest of their paragraphs, and the last
    section says what the product does instead. The headline and the line beside it are the
    owner's, unchanged.
  - **The sample Plan is data, checked against the Edition, and it is not a Template.**
    `src/landing/sample-plan.ts`: a Program, 48 Courses in eight Terms, and 48 more for the
    scene to let fall away. Its core is the Program's Template, but a Template has Slots where
    this has named Courses, and fewer than six entries in most Terms, so real Courses were added
    to square it off. It is a heavier load than the Bulletin suggests. The owner asked for one
    perfect rectangle, so that stands, and the caption says what was done: "Drawn for the
    picture, not for anyone's degree: the core is the Bulletin's suggested plan, with real
    courses added so that every term shows six." The disclaimer says it is a sample as well.
    `npm run build` checks every code and the Program against the latest Edition first and
    stops if one is missing (`scripts/sample-plan.mts`; the unit suite runs that script against
    a catalog with a Course taken out and reads the exit code). The figures on the page
    (Courses, Programs, the coverage percentage with its qualifier) are written in by the build
    and recounted from the catalog by the tests.
  - **Nothing on it moves by itself.** The prototype's footer ticker stands still, as a band of
    its four phrases: a line of type that scrolls for ever needs a control to stop it (WCAG
    2.2.2), and the page has no script to give it one. The hero's rise and the sections'
    fade-in are gone for the same reason the loader is.
  - **Type and colour, against the prototype.** Section labels are in the sans, not the mono:
    the type rule above keeps the mono for course codes, which on this page is exactly the 48
    discs of the Plan. Raleway at 500 sets the headings, as on the pages beside it, and two
    display lines in the footer (the band of phrases and the way in, which mirrors the header's
    pill); sentences, the fact cards and the labels are in the sans, where the prototype set
    everything in Raleway. The sign-up blue is on one thing, the roundel of the footer's way
    in; the prototype also used it for the ticker's dots and a glow.
  - **Also not as the prototype has it**, each for a reason:
    - A way in, in the hero ("Start my plan"), which the prototype's hero lacks and #60 asks
      for, and beside it "Already have a plan? Sign in": the old page's menu carried that link
      and a returning student on a new device has no other way back.
    - The third fact card keeps the prototype's heading and gives the coverage figure with its
      qualifier where the prototype had "Straight from Penn State's own text".
    - The footer gains "A prompt for finding your programs" (the old `#discovery` address lands
      on it) and "Security", and loses the row of icon links, which repeated three links
      already in the columns beside it.
    - No "Scroll" cue, no palette drawer, no "© 2026".
    - The preview card (`og:title`, `og.png`) still shows the route map of two landing pages
      ago. New card art is the owner's to make.
  - **What the first paint weighs** is held by a ceiling: document, stylesheet and script,
    20.2 KB gzipped when this landed (ADR 0005 for why the document and stylesheet are counted
    now). The old page's journey chunk, 132.7 KB of Three.js and the code that drove it, is gone
    until the scene brings Three.js back as a chunk of its own.
- **The landing page's scene (2026-11-16, #65).** The field of spheres from the owner's
  prototype, laid over the landing document: `src/landing/scene.ts`, with three.js, as one
  chunk the page asks for after it has painted. Its materials, lights, physics constants,
  entrance and label treatment are the prototype's and are the design; `field-math.ts` holds
  the stage values and the grid, where they can be read against #65 and tested with no canvas.
  - **Two classes decide everything.** `src/gravity.ts` puts `has-scene` on `<html>` at once
    where a scene can run (the sections become a screen each, so the page does not change
    height when the scene arrives) and `scene-live` once it has drawn (the plan section pins,
    and the list goes out of sight but stays in the page). Until the second, the list is where
    it always is: a reader never has neither. The guards: no reduced motion, no save-data, and
    a WebGL context the browser can draw on a GPU, or it does nothing; in software the scene
    measured three frames a second, and that is worse than the page. (The browser is asked to
    refuse a slow context AND what it is drawing with: a headless Chromium with no GPU hands
    over a SwiftShader context even when asked not to.) If the chunk fails, never
    arrives (six seconds), will not start, or the browser later takes the context away, both
    classes come off and the page is exactly the static one.
  - **Sixty steps a second, whatever the screen does.** The prototype advanced once per frame,
    so it ran twice as fast on a 120 Hz display. The constants are unchanged; they are now per
    sixtieth of a second and not per frame. A frame is drawn when a step has been taken, and
    the loop stops altogether once the Plan has flown past the camera and nothing is left on
    screen, until the reader scrolls back (ADR 0002 asked for that of the old journey too).
  - **The stages follow the sections, not the scroll offset alone.** #65 gives progress as
    the scroll distance in screens, which assumes each section is one screen tall. On a phone
    the catalog section is taller, and the Plan would assemble while its cards were still on
    screen. Progress is 1 at the top of the catalog section, 2 at the top of the plan section
    and 3.6 at the top of the last, and linear between; where the sections are as tall as the
    design draws them the two are the same number.
  - **The wheel glides; nothing else does.** The prototype's eased wheel is kept, by the clock
    and not by the frame. It takes vertical wheel events only, and it stops the instant a key
    or a pointer goes down: the browser animates a keyboard scroll and folds any scroll a
    script makes into that animation, so one more frame of glide after End was pressed left
    the page 20 to 60px short of the end (measured). The prototype also glided to in-page
    anchors; this page's only one is the skip link, which jumps.
  - **The scene reports itself, and can be stepped.** `window.__lionsdegreeScene.report()`
    is where every Course is, whether it is showing and where its cell is; the browser suite
    asserts the rectangle from that and not from pixels. `advance(steps)` moves the simulation
    on without waiting for the screen. #60 allowed a read-only hook; this one is not strictly
    read-only, and the reason is that a test which waits for frames passes or fails on how
    fast the machine under it draws. One test does wait, to show the scene moves by itself.
  - **Its tests need a GPU.** They run where the test browser has one (Windows, as
    configured) and skip where it does not, which today includes the CI runner. Making the
    browser accept a software context was tried and most of them time out. What a runner
    without a GPU still checks: the page without the scene, every way the scene can fail to
    arrive, and the scene's arithmetic.
  - **Not carried over from the prototype:** the push away from the pointer (the owner's
    call); the tint at the edges of the page, which changed with the stage and took the muted
    labels near the edges under AA contrast; the loader; the palette drawer. The Term names
    over the rectangle are in the sans at 700, like the page's other labels, where the
    prototype used the mono at 500. A sphere's label is the prototype's: subject in the mono,
    number in the sans.
  - **Two things that are the prototype's and look like rule-breaking.** The sky stage's
    middle tone is `#5DBBF5`, which is also the sign-up blue's hover tone. The rule that keeps
    that blue for the one thing being asked for is about controls; this is the colour of a
    stage in a picture, and #60 names it (petrol, sky, green). And the shadows: the prototype
    asked three.js r160 for a soft shadow map with a blur radius of 12, and r160 ignored the
    radius for that map. This build is on r186, which honours it. The radius is left at its
    default so the shadows are as the prototype drew them, not as it asked for them.
  - **What it weighs:** 134.9 KB gzipped for the chunk (the old journey's was 132.7), under a
    ceiling of its own. The page's first paint went from 20.2 KB to 23.7 KB, which is the
    script that decides and the layout rules; the scene itself is not on that path, and the
    browser suite times the request against the first paint.
  - **Not known:** how it runs on a real phone, in Safari or in Firefox. Everything measured
    is Chromium on one laptop (60 frames a second at 1600 by 900 and at phone size). That is
    #66, and it needs a person holding the devices.
- **Sample plans is a list in a document (2026-11-16, #60, #67).** `/sample-plans/` lists every
  Program in the latest Edition that publishes a suggested plan (a Template), with the campuses
  its plans are for and one action each: "Open in the planner", which is the planner's own
  Program link (`/plan/?programs=…`) and generates nothing until the student says so.
  - **The list is written into the page by the build**, from `templates/index.json` in the
    Edition's catalog, and not fetched into it. With scripts off it is all there, links and
    all; the one script (`src/site/find-program.ts`) only narrows it, and the box it narrows
    with is hidden until that script is running.
  - **The index is the sync's to write.** `scripts/templates.mjs` walks an Edition's
    Program files for suggested plans that have Terms in them and joins what it finds to the
    Edition's own Program index. A plan whose Program the Edition does not have is not listed,
    because its link would open an error. `sync-catalog.mjs` calls it for every Edition it
    syncs, so the next catalog refresh rewrites it; the index is committed with the catalog and
    a test fails if it is stale. It carries a Program's identifier, name and campuses and
    nothing else: no Course, no sentence of the Bulletin's.
    A Program file that cannot be read stops the sync and names the file: the page's claim is
    that it lists them all.
  - **A campus is one of Penn State's, recognised in the Bulletin's label.** The labels are
    sentences ("Chemistry, B.S. at Commonwealth Campuses (For Change-of-Campus students who can
    take CHEM 213 at their Commonwealth Campus)", "Nursing, B.S.N. at Altoona, Erie, and
    Harrisburg Campuses"). The first version cut each at its last " at " and showed the rest,
    which gave students "their Commonwealth Campus)" as a place and "Erie Campus (3-Year
    Accelerated Plan)" as a second campus beside Erie. Now the generator names the campuses it
    finds after the first " at ", once brackets and anything from " with " on are set aside: a
    list of twenty-one campuses, "Commonwealth Campuses" and "All campuses". What that loses,
    knowingly: "(except Altoona)" on two plans. A plan with no place in its label takes the
    campus on its Program's own record, plan by plan (Software Engineering at Behrend has one
    unlabelled plan, Erie's, and one labelled World Campus). Where neither says (three Programs
    today), the page says the Bulletin names none. A place the list does not know is published
    as the Bulletin wrote it and fails a test, so that it is added and not dropped.
  - **What typing finds:** every word typed has to be in some word of the Program's name or
    campuses, in any order, with case, accents, full stops and apostrophes ignored ("comp sci
    erie bs"; "behavioral" finds Biobehavioral Health). One or two letters have to begin a
    word, so that "ba" is the B.A.s and not Abington. #60 asked for the list to be "filterable
    by name"; campuses are matched too, because a Program's name often does not say where it
    is. The rule is one function beside the code that writes the list, and the build and the
    page fold text with the same one.
  - **Which Edition:** the one the site's coverage figures are computed from, read once. The
    page's name for its Edition and the list under it cannot then be two different Editions.
  - **Left as it is, and worth the owner knowing:** the link opens the planner's setup with the
    Program chosen, for someone with no Plan yet. A student who already has a Plan gets that
    Plan and the link's Program is ignored, as it is for every Program link (the Discovery
    prompt's too); changing that is a change to the planner, which #60 rules out. And where a
    Program has plans for several campuses, the planner's own "Campus plan" step is where the
    student picks; the link does not carry a campus.
  - **The header has four links now**, Sample plans first after Planner. They stopped fitting
    on one line with the brand and the action below about 896px, so the header's narrow layout
    starts at 56rem where it started at 48rem; on a phone the gap between links tightens so
    the four are one row at 390px. The landing page's pinned section used to assume a
    two-row header on a phone: it now takes the header's measured height from
    `src/gravity.ts` (`--head-height`).
  - **What it weighs:** 28.2 KB gzipped to first paint (document 13.6, stylesheet 13.6,
    script 1.0), under a ceiling of its own. The document is the heavy part and is meant to
    be; the published index is 55.7 KB uncompressed and the page does not download it.
- **A Program's plan, Term by Term, on the Sample plans page (2026-11-16, #60, #68).** Each
  row has a "See term by term" button that shows the Program's Template under it: the Terms in
  the Bulletin's order, each with its Courses and its Slots.
  - **One small file per Program, fetched when it is chosen.** `templates/<program>.json` in
    the Edition's catalog, written by the catalog sync with the index (`scripts/templates.mjs`,
    which was `template-index.mjs`). Nothing is fetched until a row's button is pressed, then
    that Program's file and no other, once, however the row is opened and closed while it is
    on its way. The largest is 4.4 KB compressed (Information Technology, B.S., 44 plans); the
    middle one is 0.7 KB; an Edition's 383 files are 2.5 MB on
    disk, committed with the catalog like the rest of it. A file with no entry in the index is
    never written, and the directory is emptied before each write so none is left behind.
  - **What a file carries:** the address of the Program's page in the Bulletin, and for each
    of its plans the Bulletin's name for it, its Terms, and in each Term the Course codes, the
    credits and the Bulletin's own label for each choice it leaves open. Not the footnotes or
    their marks (a mark inside a label, "IST 140*# or CMPSC 121", is taken off: it points at a
    note that is not there), not a Course's title, nothing of a description (a test checks
    every label against the opening sentences the catalog does publish). **The plan's name is carried**, which #68's "Course codes, credits and Slot labels
    only" does not list: a Program has up to 44 plans, one per option and campus, and the name
    is the only thing that tells them apart. It is a title, the longest is under 200 characters,
    and the index already publishes the campuses read out of it.
  - **A Slot is a Slot.** The Bulletin's label, in a dashed box, with "Open:" in front of it
    for a screen reader, and no Course in it. The page says so above the Terms. About 1,400
    of the Bulletin's labels name Courses themselves ("STAT 200 or SCM 200 or DS 200"): that is
    the Bulletin listing what it accepts, kept as it wrote it, and the codes inside a label
    are not checked against the catalog (one of them is the Bulletin's own "PYSCH 400").
  - **A remark is a note, and is not copied.** 33 lines in the latest Edition are not a
    Course and not a choice: "Take PECT exams (not required for graduation…)" with a web
    address, "Enter the major before the end of this semester…", and also "Semester Abroad"
    and "Optional Add-on Course". The first version showed them as open choices. They are
    told apart by what a Slot is: a line the Bulletin gives no credits, and the catalog does
    not count as General Education, is a note. A file says only that there is one, the page
    says "A note in the Bulletin, not copied here", and the plan links to the Program's page
    in the Bulletin. Some of those 33 are harmless labels and are withheld with the
    sentences; that is the cautious side of 5.1, and showing them is a one-line change if the
    owner prefers it.
  - **A Course's code is the catalog's.** Where the Bulletin's plan writes "CAS 100" and its
    catalog lists CAS 100A, 100B, 100C and 100S, the catalog's record of the plan already
    names those four (177 lines: CAS 100, ENGL 202, SPAN 215…), and the page shows what the
    record says, as the planner does. "BISC 004" is the catalog's "BISC 4".
  - **Credits are the Bulletin's figures**, nought included ("Elective (if needed)", and
    PSU 8 in seven plans), and so are a Term's total and a plan's: 36 Terms do not add up to
    their own lines in the Bulletin, and are not corrected here.
  - **A code the Edition does not have is not called a Course.** The Bulletin's plans name 33
    codes its own catalog does not list (LA 283 in 130 plans, IST 302, SRA 221…), and six
    alternatives. #68 requires that every Course a Template names exists in the Edition, and
    dropping them would misstate the plan, so they are published as a third kind (`unlisted`,
    `orUnlisted`) and shown with "not in this edition's catalog" beside them. The test runs
    both ways: nothing named as a Course is missing from the Edition, and nothing flagged is
    in it; and it stops at 39 flagged codes (32 today), so a catalog that failed to load
    cannot pass as a Bulletin full of missing Courses.
  - **Never an empty plan.** A file that does not arrive, or is not a Template file for that
    Program (no plan in it, a plan with no Terms, a line that is not a Course, a Slot or a
    flagged code), is refused whole and said in words, with "Try again" and the way into the
    planner still there. A half-read plan looks exactly like a plan. A Term the Bulletin lists
    nothing for (four of them) says that.
  - **A button, made by the script.** With scripts off the page is the list and its links;
    the button is not in the document, for the reason the search box is hidden there. It is a
    disclosure (`aria-expanded`), the plan opens in place under its row with focus left where
    it was, and a Program with several plans gets a "Which plan" chooser, with the chosen
    plan's name in full under it. What happens is said for a screen reader in a live region
    that is in the page before anything is opened; "Try again" hands the focus back to the
    row's button. Seventeen plans have no name in the Bulletin and are "Plan 1", "Plan 2":
    for three Programs that is all that tells their plans apart. No per-Program address: #60
    rules that out for now.
  - **A stylesheet of its own.** The page's rules moved out of the one every page outside the
    planner shares, so the landing page, Connect, About, Privacy and Terms do not download them.
  - **What it weighs:** Sample plans first paint 32.8 KB gzipped (document 15.6, stylesheet
    14.1, script 3.1; it was 28.2), ceiling 39. Landing first paint 23.8 KB, ceiling 28.
- **The pages outside the planner are cream, and say so (2026-11-16, #61).** Connect your AI, Privacy
  and Terms used to wear the old landing page's dark canvas. They now sit on the app's light tokens
  with petrol as the only accent (`site.css`), and each carries `data-theme="light"`: merely dropping
  `dark` would hand them to the system preference, and there is no dark version for it to pick. One
  header for all of them (`src/site/header.ts`): the mark, the planner's wordmark, Planner, Connect
  your AI, Start my plan. No menu button — the legal documents ship no script — so on a narrow screen
  the links take a row of their own instead of collapsing.
  - **About is one of them, and a page (2026-11-16, #62).** About and Contact were the last two
    sections of the landing page: somewhere to scroll to, not somewhere to link to. They are
    `/about/` now, words unchanged, Contact at `/about/#contact`, and the header links to it. The
    feedback form went with them, and took the landing page's only route to the account service
    along. The old addresses still work: `/#about` and `/#contact` are sent on by `src/moved.ts`,
    and with no script the landing footer's own About and Contact links carry those ids, so the
    browser scrolls to the link that goes there.
  - **The discovery prompt lives on Connect your AI, and only there (2026-11-16, #63).** It was
    printed on the landing page; the new landing has no place for it, and the page a student is on
    when they have just connected an assistant is the right one anyway. It sits after the four
    steps and outside them, at `/connect/#discovery`, and the landing page links to it; the old
    `/#discovery` address is sent on the same way `/#about` is. Both copy
    buttons on that page now say what they copy ("Copy link", "Copy prompt"), and are `hidden` in
    the markup until `src/copy.ts` runs: with scripts off the text is there to select and no
    button pretends to copy it.
  - **One list of these pages.** `PAGES` in `src/site/header.ts` is what the header links, what
    the build takes its entry points from, what the planner's precache leaves out, and what the
    sitemap is written from. A page is added there. (The sitemap used to be built from the legal
    documents alone, and had never listed `/connect/`.)
  - **The lion in the mark is paper.** `public/mark-clear.png` is the mark with the cream cut out,
    for use on anything that is not exactly `--bg`. Cutting "only the background" and keeping the
    lion cream is not possible: the lion is negative space, its back runs into the gap between the L
    and the D with no ink between (measured — a flood fill from the picture's edge reaches its
    face). So every cream pixel goes, and on a tinted surface the lion takes that surface's colour,
    exactly as it takes the page's on cream. Edge pixels are unmixed from the cream, not just faded,
    or the mark carries a pale halo. `public/mark.png` stays opaque for anything that needs a
    rectangle. Regenerate with `node scripts/make-mark.mjs`.
- **Signature.** Station-dot nodes (hollow rings), route-line connectors (canvas edge hues), station-
  sign column headers, route progress with a "you are here" marker, and the animated route-drawing
  onboarding hero (major+minor lines converging — `Onboarding.tsx`).
- **Motion** (Emil): easing curves, `scale(.97)` press feedback, origin-aware `@starting-style`
  entrances, reduced-motion safe — tuned calm for the muted mood.
- **Verified** via Playwright screenshots, light + dark onboarding (both correct). styles.css rewritten;
  theme toggle/init from §5.1 retained. NB: §5.1's slate+indigo palette and a prior vivid-cobalt
  "wayfinding" pass were both rolled back before this; this muted edition is the current on-disk state.

### 5.3 Open-source pivot: licensing + repo hygiene (2026-09-21)

Product direction changed: no paid launch. The project is released open source and users bring
their own AI (hosted key or a local model). Part 7 of the B2C spec (payments, free/paid split,
referral credits), the OpenAI spend-cap work, LLC formation, and lawyer review are all moot.
The security hardening from §5.0 stays — it now reads as "what to lock down if you self-host".

- **Apache-2.0** (user's pick over MIT/AGPL): permissive, plus a patent grant and the NOTICE
  mechanism, which matters here because the repo redistributes third-party content.
- **Catalog data SHIPS** (user's call). `apps/web/public/catalog` (632 KB, 1,295 files) stays
  tracked so clone-and-run works with no scrape. It is factual course data, mechanically
  restructured, non-commercial, disclaimed. `NOTICE` states provenance, carves it out of the
  Apache grant, and disclaims affiliation. The 31 Engineering advising flowchart PDFs are NOT
  redistributed; only the 20 KB derived `data/flowcharts/parsed.json` is force-added, which keeps
  `mineFlowchartPatterns` reproducible without them.
- **Automated refresh** (`.github/workflows/refresh-catalog.yml`): cron Aug 25 + Jan 5, matching
  the manual cadence. Opens a **PR rather than pushing** — a partial or malformed scrape degrades
  every generated plan silently, which is exactly iron rule 2. The job runs `pnpm -r test` against
  the freshly synced catalog and only opens the PR if it passes, and the PR body prints
  added/changed/removed counts plus a pointer at `needs_review.jsonl` (a jump there means a
  bulletin markup change broke a parser). The mining step falls back to the committed priors when
  `parsed.json` is absent rather than emitting an empty prior, which would flatten every plan.
- **Untracked `apps/web/dist/`** (1,310 files of build output; Pages builds from source) and
  `scrape.log`. Tracked file count 2,713 → 1,403.
- **Two latent bugs found while doing this:** `catalogs/` — the prereq-parser regression corpus
  that `psu-catalog-pipeline/test/prereq.test.ts` reads — was gitignored, so a fresh clone could
  not run the pipeline tests and the new CI job would have failed on the first run. Now tracked.
  And `Academic Plan - Ojas Khadakban.xlsx`, the author's real course history, was tracked; it is
  untracked and gitignored (still on disk locally as the optimizer reference).
- `.gitattributes` normalizes to LF — the repo is authored on Windows, CI and contributors are not.
- `CONTRIBUTING.md` carries the six iron rules forward as contributor-facing constraints, with the
  incident that produced each. `SECURITY.md` scopes reporting and explicitly puts Penn State's own
  systems out of scope. README rewritten for self-hosters; the private plan-file path is gone.

**Still to do before publishing:** resolved in 5.4. Remaining: the catalog is edition 2025-2026
generated 2026-07-11, so a 2026-2027 refresh is due.

### 5.4 Publishing: fresh root commit, and what does not ship (2026-09-21)

The pre-publication history was a single commit whose tree contained the author's real course
history (`Academic Plan - *.xlsx`), `scrape.log`, and 1,310 files of `dist/` build output.
Gitignoring those and staging a deletion does not remove them from history: `git clone` still
fetches the blobs. With exactly one commit there was nothing worth preserving, so the published
history starts at a fresh root commit rather than a rewritten one. No `filter-repo`, no rebase.

- **The OpenAI key was never committed** — verified: `.env` appears nowhere in history and is
  covered by `apps/api/.gitignore`. The `sk-` regex hits in the old tree are false positives inside
  catalog slugs (`...financial-risk-management...`, `...security-risk-analysis...`). 5.3 implied
  publishing would leak it; it would not. Rotation is hygiene, not a blocker.
- **Not published, and gitignored so they cannot be swept back in:** `STATUS.md` (session handoff —
  personal details, local Windows paths, credential-handoff steps), `LionsDegree-B2C-Launch-Spec.md`
  (business plan with a vulnerability inventory), `Landing-Page-Spec.md` (pre-pivot marketing spec).
  5.0's heading used to cite the launch spec by filename; that reference now names it as internal.
- **Contact details** moved off the author's work email onto the GitHub repo: `security.txt`
  `Contact:` (RFC 9116 permits a URL), both `LegalModal` contacts, and the scraper User-Agent
  strings in `config.ts` / `scrapeApCredits.ts`. `SECURITY.md` already routed to GitHub private
  advisories, so this makes the rest consistent.
- **A second instance of the 5.3 gitignore bug, and the one that mattered.** The rule was a bare
  `data`, which git matches at any depth. It was silently ignoring `apps/web/src/data/` — three
  source files (`catalogClient.ts`, `importSchedule.ts`, `sync.ts`) imported by eight modules — so
  a fresh clone could not typecheck or build, and CI would have failed on its first run. Anchored to
  `/psu-catalog-pipeline/data/`. **General lesson: an unanchored gitignore entry is a repo-wide
  pattern. Verify a clone builds; do not verify the working tree, which always builds.**
- `scripts/smoke.ts` hardcoded a local Windows scratch path; it now takes argv/`SMOKE_DIR`.
- **`Academic Plan Flowchart.html` also withheld.** The origin demo was initially published, then
  pulled: it embeds `DATA.plan`, a real ESci+AIE schedule (Fall 2026 - Spring 2029), which is the
  same personal-records category as the xlsx. The five engine/pipeline files ported from it keep
  their provenance comments with line numbers, so the lineage is still readable without shipping a
  student's plan. Caught only by reading the file rather than trusting its name.

## 5. Security & compliance decisions (2026-07-14)

### 5.1 Course descriptions are Penn State's expression, not our facts

- **The question:** the shipped catalog carried 14,493 course descriptions verbatim, 10.4 MB of
  prose per edition, downloaded by every visitor.
- **What is and is not ours.** Codes, credits, prerequisites and Gen Ed tags are *facts*; under
  *Feist* they carry no copyright, and *Assessment Technologies v. WIREdata* (7th Cir. 2003) says a
  compiler cannot use copyright to sequester the data underneath its compilation. A thousand
  characters of prose describing a course is expression, and clears *Feist*'s "minimal spark" bar
  easily. Penn State is state-related, not federal, so §105 does not apply, and the bulletin footer
  asserts copyright with a named DMCA agent.
- **Truncation does not fix it — measured.** A 400-character cap reproduces the ENTIRE description
  for 6,762 courses (47%); the median is 540 characters and CMPSC 465's is 123. Brevity was never
  what made *Authors Guild v. Google* work: a snippet cannot substitute for a 300-page book, but
  taking all of a 123-character description means the excerpt IS the substitute.
- **Fix: extract, do not excerpt.** `src/derive/keywords.ts` emits topic terms per course. Extracted
  terms are facts *about* the text rather than the text, so they can be shown freely, and a student
  still learns what a course covers. Display is keywords + a short excerpt + a link to the bulletin
  page the text came from — a reference that sends traffic TO Penn State rather than standing in
  for them, which also helps the market-harm factor.
- **Why the extraction is deterministic.** Generating descriptions with a model would violate iron
  rule 1 (2.5) *and* be legally weaker: text produced by a model that read PSU's description is a
  derivative work — paraphrase does not launder copyright — and it reintroduces expression that is
  now unverifiable. "Include all the keywords" constrains what goes in, not what gets invented
  around them, which is the MATSE 444/448 mechanism exactly. A test asserts the output is a SUBSET
  of the source's own words; a generated summary could not pass it.
- **Part-of-speech filtering is load-bearing, not polish.** Without it ~1 keyword in 4 was a stray
  verb ("pertaining", "comprehend", "judged", "intended") on a surface whose whole job is to say
  what a course is about. Tagged per OCCURRENCE: a corpus-wide vote drops "writing" (verbal 86% of
  the time overall, nominal in every English course) and keeps "comprehend" at 51%. Rejected first:
  subject-concentration weighting (over-filtered — CMPSC 465 lost "trees" and "sets") and a
  repeat-or-rare rule (CMPSC 465 got ZERO, because its description is one dense sentence where
  nothing repeats — the signal fails precisely on the shortest, most keyword-dense entries).
  Accepted limit: a gerund in a bare list tags as a verb, so "...graphs, sorting." loses "sorting".
- **Done: the prose no longer ships.** Search scored against the description, but it only ever
  asked one question of it — how often does this term occur, capped at 5. That is a count, and a
  table of counts is a fact about the text rather than the text. The pipeline reads the full
  descriptions at build time and emits postings; `public/catalog` carries none. This is the
  *Authors Guild v. HathiTrust* shape — index the full text, display none of it — and the condition
  is that it genuinely never leaves the build, because shipping bytes and declining to render them
  is still distribution.
- **Measured against the FULL prose**, not the old index: 91.7% overlap@25, 94.4% top-5, 93.0%
  rank-1, zero queries made unfindable. Against the *old shipped index* the numbers look far worse
  (62% top-5) — because that index was itself lossy, a 200-character head plus a DEDUPLICATED word
  bag whose counts were mostly 1 however often a word really appeared. The postings index tracks
  the real text more closely than what it replaced.
- **The strip lives in `sync-catalog.mjs`**, which is the line between the two trees: `data/out` is
  everything parsed (keyword extraction and the index are both built from it), `public/catalog` is
  what we publish. 9.9 MB of prose withheld per edition.
- **What cannot be recovered from the index:** word order, sentences, punctuation, and any count
  above 5. Dropping the description phrase-match bonus (+7) is what buys that last guarantee —
  word order is the one part of an index that edges toward reconstructable — and it cost 2 points
  of agreement.
- **Consequence worth noting:** removing descriptions removed the only *fenced* catalog prose, and
  revealed an unfenced one. An adviser-defined or unreadable requirement's note quotes the
  bulletin's own words, and MCP returned it raw. Now fenced; our own phrasings deliberately are
  not, since marking our words untrusted teaches the model to discount them.


- **Security headers** per OWASP Secure Headers baseline: `_headers` (Cloudflare Pages) sets HSTS
  (2y, preload), CSP (self-only scripts; no third-party origins except Supabase in connect-src;
  frame-ancestors none), nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP. API adds Hono
  secureHeaders middleware. Verify at securityheaders.com post-deploy.
- **xlsx dependency swap:** npm `xlsx@0.18.5` carries two HIGH advisories (SheetJS abandoned npm);
  replaced with the patched official CDN build (0.20.3). `pnpm audit` clean.
- **Supabase over alternatives** for accounts: managed Postgres + OAuth (Google/Microsoft) + RLS
  deny-by-default (`supabase/migrations/0001_plans.sql` — every policy checks auth.uid()).
  Vercel not needed: Cloudflare Pages covers hosting/functions.
- **Sync is config-gated**: no VITE_SUPABASE_* env → account UI hides, app stays fully local.
  Compare-and-swap conflict policy (ADR 0003), with a local backup before
  adopting a remote plan.
- **Legal pages** (privacy/terms/accessibility) live in-app, honest to architecture (local-first,
  no tracking, no chat storage, AI disclosure). Lawyer review before paid launch.
- **Accessibility**: equivalent list view (semantic sections/lists, text statuses, keyboard move
  controls) as the WCAG remedy for the pointer-only canvas; skip link, dialog roles + ESC,
  focus-visible outlines, aria-live chat, prefers-reduced-motion.
- **Deploy deliberately blocked** until the user reviews this security/legal batch.

## 6. Known limitations / debt (deliberately accepted for now)

- Requirement-table rows: ~3% still unstructured (honest raw-text fallback; queued for an OpenAI
  Batch normalization pass with validator cross-checks).
- Accessibility: canvas is pointer-only; keyboard/screen-reader plan view is the top launch
  blocker (WCAG 2.1 AA target). Mobile layout not yet responsive.
- Import term-context carry-forward can mislabel prose lines after a semester block; the preview
  UI is the safety net.
- Rate limiting is in-memory (per-process) in dev; must move to Cloudflare KV at deploy.
- Legal pages (privacy/ToS/accessibility statement) drafted but not yet written; required before
  wide promotion.
- Coverage mining catches ~44 relations; phrasing variants outside the three patterns are missed
  (extend patterns as found — never guess).
