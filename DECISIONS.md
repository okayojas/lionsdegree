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
| Sync conflicts | Last-write-wins per plan doc, loser kept as restorable snapshot | CRDT rejected as overkill: one user, whole-doc unit, rare conflicts. |
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
  near-black; the warm off-white ties the two themes together. ONE violet accent — **deep violet
  `#6b3fa0` in light, soft lavender `#bfa9ea` in dark** (user pref, 2026-07-27; was transit-blue
  `#37568c`); the green route (`--route-b`) stays as the complementary second line; status desaturated.
- **Font:** self-hosted **Space Grotesk Variable** (`@fontsource-variable/space-grotesk`, imported in
  main.tsx, bundled same-origin under CSP `font-src 'self'`) as the one UI face; mono still codes-only.
- **One unifying font.** Single sans (`--font-sans`) for ALL UI text and wayfinding labels (labels are
  uppercase + letter-spaced in that same sans, not a second face). Monospace reserved STRICTLY for
  course codes (`.card .code`, `.sr-code`) — the one deliberate, consistent exception. This is the fix
  for the incoherence complaint. (Distinctive display type still wants a self-hosted face later; CSP
  blocks web-font fetch, so treatment carries it for now.)
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
  LWW conflict policy with local backup before adopting a remote plan.
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
