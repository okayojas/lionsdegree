# Penn State IUG (Integrated Undergraduate-Graduate) Programs — Research Report

_Deep-research output, 2026-07-19. 20 primary sources fetched, 98 claims extracted, 25 verified by
3-vote adversarial panels: 23 confirmed, 2 refuted. This is a RESEARCH DOCUMENT for planning the
LionsDegree IUG feature — NOT ingested app data (iron rule 1: app data comes only from
deterministic parses of source bytes; this doc tells the scraper where those bytes live)._

## University-wide rules (GCAC-210, verified 3-0)

Source: <https://gradschool.psu.edu/graduate-education-policies/gcac/gcac-200/gcac-210-integrated-undergraduate-graduate-degree-programs/>
(current revision approved 2022-05-04, effective Fall 2022)

- **Definition**: an IUG "combines a Penn State baccalaureate degree with a master's degree as a
  continuous program of study" (~5 years total).
- **Admission timing**: must have completed **entrance to major**, **≥60 credits**, and be admitted
  **no later than the end of the second week of the semester preceding the semester of expected
  undergraduate conferral**. Transfer students: ≥15 Penn State credits.
- **Double-counting cap**: up to **40% of the master's credits, max 15 credits**, may count toward
  BOTH degrees. At least **50% of double-counted courses must be 500/800-level**. Independent study
  (596/896) may NOT double-count; an undergraduate thesis/capstone cannot also satisfy graduate
  requirements (7.1).
  - ⚠ The pre-2020 cap was 12 credits; Harrisburg's process page still shows the stale 12-credit
    university-wide figure (refuted 0-3). Individual programs DO legitimately impose stricter
    12-credit caps (Smeal MBA/MAcc, ESM, Harrisburg EE all cap at 12).
- **GPA**: GCAC-210 sets **no university-wide GPA** — thresholds are program-specific
  (e.g. 3.4 Harrisburg EE, 3.5 Harrisburg MBA, 3.0/3.25 Criminal Justice).

## Two IUG types (verified 3-0)

1. **Program IUG** — a Graduate Council-approved pairing of a specific undergrad major with a
   specific master's (everything in the catalog below).
2. **Schreyer IUG (GSAD-204)** — a Schreyer Honors College Scholar may integrate **ANY Penn State
   bachelor's with ANY Penn State master's** as an individual pathway, by special exception from
   the Dean of the Fox Graduate School, with an approved plan of study per GCAC-210 rules.
   Source: <https://gradschool.psu.edu/graduate-education-policies/gsad/gsad-204-schreyer-honors-college-integrated-undergraduate-graduate-degree-programs/>
   **Planner-relevant: a Schreyer ESC+AIE student isn't limited to the tagged list below.**

## The authoritative index (verified; scraper target)

<https://bulletins.psu.edu/graduate-professional-programs/> — filter checkbox `filter_7`
("Integrated Undergraduate-Graduate Degree Programs"). **Exactly 41 graduate programs carry the
tag** (live HTML, July 2026). The `#filter=.filter_7` URL fragment is client-side JS — a scraper
must select `filter_7`-classed tiles from the static HTML, then visit each program's own bulletin
page for the IUG details (there is NO uniform "IUG tab" convention across program pages — refuted 0-3).

## Deep-verified programs (per-program details confirmed 3-0)

| Program (IUG) | Pairs with | Grad degree | College / campus | Entry | Double-count |
|---|---|---|---|---|---|
| **Accounting "Integrated MAcc"** | B.S. Accounting | M.Acc. (STEM-designated) | Smeal, UP | apply spring of 2nd year, GCAC-210 timing | 12 cr, ≥50% at 500/800 |
| **B.S. Science + M.B.A.** | Science B.S. (Eberly) — specifically the Science major | M.B.A. | Smeal × Eberly, UP | entrance to major + 60cr; regular MBA admission; no stated GPA | 12 cr, ≥50% at 500/800 |
| **Engineering Science ("ESC IUG")** | B.S. Engineering Science | M.S. Engineering Science & Mechanics | Engineering (ESM), UP | apply 5th/6th semester, ≥60 cr | 12 cr, ≥50% at 500/800; no 596/thesis |
| **Business Administration (Capital)** | six Harrisburg B.S. majors: Accounting, Finance, Info Systems, Management, Marketing, Project & Supply Chain Mgmt | M.B.A. | PSU Harrisburg | **3.5 GPA**, entrance to major + 60 cr | 12 cr at 500/800 |
| **Criminal Justice** | B.S. Criminal Justice | M.A. | PSU Harrisburg | **3.0 overall / 3.25 major GPA**, 60 cr | 12 cr |
| **Electrical Engineering (Capital)** | B.S. EE (Harrisburg) | M.S. EE (5 yrs) | PSU Harrisburg | **3.4 cumulative + 3.4 in specified MATH/PHYS/EE**, apply after 5th before end of 6th semester, ≥81 cr | 12 cr, ≥50% at 500/800; no thesis/independent study |

## Other confirmed IUG-tagged programs (index-confirmed; per-program details not yet deep-verified)

By college, from the 41 tagged entries:
- **Engineering**: Architectural Engineering (+ Engineering Science & Mechanics above)
- **EMS**: Energy and Mineral Engineering, Geosciences, Meteorology and Atmospheric Science
- **Education**: Curriculum and Instruction, Educational Theory and Policy
- **Arts & Architecture**: Architecture, Landscape Architecture, Music
- **HHD**: Hospitality Management
- **IST**: Information Systems
- **Ag Sciences**: BioRenewable Systems
- **Harrisburg (Capital)**: Civil Engineering, Computer Science, Mechanical Engineering
  (+ Business Administration, Criminal Justice, Electrical Engineering above)
- **World Campus**: Criminal Justice Policy and Administration (index-tagged)
- (Liberal Arts and Bellisario are represented among the 41 per verifiers, but specific program
  names from those colleges were not individually confirmed — see open questions.)

## Caveats (from the verification pass)

1. `gradschool.psu.edu/prospective-students/how-to-apply/integrated-programs/` is now 404 — cite
   the GCAC-210 policy page instead.
2. Any 12-credit "university-wide" cap you see is stale (pre-2020) or program-specific.
3. No Behrend/Erie or Abington programs carry the bulletin IUG tag — but department-marketed
   "accelerated/fast-track" pathways outside the Graduate Council designation exist (Behrend
   advertises "fast-track master's"; Great Valley an Accounting IUG page) and would not appear in
   the filter_7 index.
4. Only ~20 of the 41 tagged programs were deep-verified on their own pages; the rest need a
   per-program pass (paired majors, GPA, windows, caps).
5. Delivery-mode tags on index tiles describe the graduate program, not necessarily the IUG path.
6. Verified against the live 2026 bulletin — re-check each bulletin cycle (Smeal's 2024 residential
   MBA restructuring did NOT kill the B.S./M.B.A. IUG).

## The three structured IUGs — graduate courses (built into the app 2026-07-19)

Scraped deterministically by `scripts/scrapeIug.ts` → `data/out/<edition>/iug/{slug}.json`
(requirement tables via the existing `parseRequirementTables`; no LLM). Master's course lists as
verified from the graduate bulletin:

### Smeal Integrated MAcc — B.S. Accounting + M.Acc. (33 cr master's)
Required (18cr): ACCTG 432, ACCTG 495 (internship), BA 817, ACCTG 804, ACCTG 805, ACCTG 881.
Culminating (3cr): ACCTG 573. Electives: 12cr (adviser-selected).
Double-count ≤12cr; eligible list includes ACCTG 804 & 881 (grad) plus 400-level ACCTG
(403W/404/405/406/410/411/417/422/432/450/471/472/473/481).

### Smeal B.S. Science + M.B.A. (35 cr M.B.A. — track 0; the page also carries an 81-cr D.B.A. block, ignored)
Core (35cr): BA 512, BA 533, BA 800, BA 801, BA 802, BA 804, BA 805, BA 810, BA 811, BA 815,
BA 817, BA 821, BA 830, BA 831, BA 832, BA 835, BA 836, BA 880. Culminating: BA 571.
Double-count ≤12cr; eligible: BA 512, BA 800, BA 801, BA 811, BA 815, BA 831.

### ESM — B.S. Engineering Science + M.S. ESM (~31-32 cr, thesis or non-thesis)
Required: EMCH 524A (Math Methods, 3cr); ESC 514 / EMCH 514 (seminar, 2cr); a category menu
(Mechanics / Materials / Engineering Science, 3cr each — parsed as unstructured on the bulletin
page). Electives 12cr. Culminating: thesis (ESC/EMCH 600/610, 6cr) OR scholarly paper
(ESC/EMCH 596, 3cr). Double-count ≤12cr; eligible: EMCH 400, EMCH 407, EMCH 524A, ESC 404,
ESC 419, ESC 501, ESC 551.
⚠ ESM's page uses "pick from category" menus rather than a concrete required-course list, so the
scraped grad requirements are thinner than MAcc/MBA — an honest data-quality limit of that page,
not the engine. The double-count + attach mechanics work identically.

## Implications for LionsDegree

- **Scrape target**: the pipeline can deterministically enumerate IUGs from the bulletin index
  (static HTML, `filter_7` class) + each program page's IUG text — same CourseLeaf infrastructure
  we already parse. That satisfies iron rule 1.
- **Planner mechanics already exist**: IUG double-counting is the same consumed-once double-count
  arithmetic as the gen-ed engine; the 60-credit/entrance-to-major application gate is an audit
  rule like Schreyer windows; 500-level courses would enter the catalog from the graduate bulletin.
- **Schreyer angle**: GSAD-204 means for Scholars (like the primary user) ANY master's can attach —
  an "IUG mode" shouldn't hard-restrict to the 41 tagged programs when `plan.honors` is set.

## Open questions

1. Per-program details for the remaining ~20 tagged programs.
2. Non-tagged accelerated pathways at Behrend/Great Valley/Abington — include or ignore?
3. Which specific Liberal Arts / Bellisario programs carry the tag.
4. How to represent the Schreyer individual IUG in the planner UI.
