# 6. A what-if is an independent copy of the Plan

Date: 2026-11-16

## Status

Accepted (#69). **The decision is the owner's**, made in conversation on 2026-11-16 and recorded
in the spec. It reverses the storage decision of #56 and supersedes the MECHANISM of ADR 0004;
ADR 0004's decision itself (a student's own click may keep a what-if that takes a Course or a
Program out of the degree) stands.

## Context

#56 put what-ifs (Candidates) beside the student's Plan as tabs, and stored each one as a named
LIST OF CHANGES: tool calls, replayed against the Plan as it stood every time the tab was opened.
The reasoning was sound on its own terms. A stored document would go stale against a Plan that
had moved, and keeping it would install a decision made against a plan the student no longer
had, which the compare-and-swap of ADR 0003 exists to refuse. A list of changes cannot go stale:
it is recomputed, and a change that has stopped being possible says so.

What that design cost showed up in use:

- **A what-if could hold only what could be replayed.** Declaring or dropping a Program, adding a
  summer, attaching a master's degree, marking a Course complete and anything on the detail card
  were refused inside one ("isn't something a what-if can hold"). "What if I did this major
  instead" is the question students most want to ask of a what-if, and the one it could not take.
- **It was never independent.** Editing the Plan redrew every what-if, and a what-if whose change
  no longer applied drew nothing at all.
- **A Program link from the Sample plans page** (#67, #68) had nowhere safe to land for a student
  who already had a Plan, so it was silently ignored.

The owner's instruction: a what-if should make a new tab holding an exact copy of the Plan, in
which anything can be changed, and "once that new tab is made, they operate independently of one
another."

## Decision

**A Candidate is a named copy of a Plan's contents**: everything the Plan holds except its
identity, its Revision and the what-ifs beside it. It is made by copying, edited like any plan,
and never re-run against anything.

- **One stored document, as before.** The Plan's contents are at the top and each what-if's are
  inside `candidates`. What-ifs still must not become rows in `plans` (that table is read
  newest-first with a limit of one), and they still ride the one sync and the one
  compare-and-swap.
- **The planner shows and edits the plan IN VIEW.** With a tab open, the store's `plan` is that
  what-if's copy under the stored document's identity and Revision, and the Plan's own contents
  are set aside. Every write goes through one function that folds the view back into the stored
  document. There is one editing path and no list of things a what-if cannot hold.
- **Keeping is a swap.** The what-if becomes the Plan, and the Plan it replaces becomes a what-if
  in its place, named "My plan before …". Nothing is destroyed by one click, the number of
  what-ifs does not change, and keeping the replaced one puts everything back.
- **An assistant's what-if is applied once.** `save_candidate` still takes a name and a list of
  changes. The connector runs them in its sandbox and stores the plan they leave. One change that
  cannot be made refuses the whole save.
- **What-ifs already saved as change lists are converted when the Plan loads**, by replaying each
  once against the Plan as it stands. One whose changes no longer apply is kept as a copy of the
  Plan under its own name, and the student is told. The conversion is saved on the device at
  the SAME Revision and is not pushed: it is not an edit, and two devices converting the same
  document would otherwise each claim to have edited it. It reaches the account with the
  student's next edit. Where the catalog will not load, nothing is converted and nothing is
  dropped; the rail says how many are waiting.
- **A stored what-if carries its version** (`v: 2`). One without it is from before this change.
- **An action that waits commits only to the plan it started from.** Anything that reads the
  plan in view, waits on the network and then saves works on a copy, and saves only if that
  plan is still the one in view. Without this the fold puts its result into whichever tab was
  open when it finished.

## Consequences

- **A what-if can go stale, and that is now what it is for.** It is a picture of a plan the
  student could have, taken when they made it. If they edit their Plan afterwards, the what-if
  does not follow. The tab says how it differs from the Plan as both now stand (Programs,
  credits, Terms, where it ends), worked out when it is drawn and stored nowhere.
- **The consent bypass is gone.** ADR 0004 let the planner replay a kept what-if's removals past
  the connector's consent gate with a flag (`byTheStudent`). Keeping calls nothing in the
  connector now, so the flag is deleted, and with it the one thing a hosted request could ever
  have been made to set. A model removing a required Course still needs the student's words. A
  model may put a removal in a what-if, where it removes nothing from anyone's degree.
- **Keeping no longer warns about what it removes.** The warning existed because keeping
  destroyed the Plan it replaced. It does not any more. If the swap is ever dropped, keeping
  needs a confirmation.
- **The stored document is bigger.** Measured: the seeded test Plan is 6.6 KB of JSON, and the
  same document with four what-ifs is 33.3 KB. The row limit is 1 MB. Plan history keeps 15
  versions of the whole document on the device, which is the larger cost (about 500 KB at the
  limit) and is best-effort by design.
- **The in-app advisor still does not write while a what-if is open.** Its tools would write the
  plan in view while the model believes it is changing the degree. What it reads then is the
  what-if's copy, and it is told so. Its undo snapshots and restores the STORED document, not
  the plan in view: restoring a view would install a what-if as the Plan.
- **Two tabs open on one Plan in two browsers** behave as any two edits do: the second write is
  refused by the Revision check and the student reloads. A what-if adds no new case.

## What does not change

ADR 0001 (a Plan is read against the Edition it was made in: a what-if is a copy, so it carries
the same pin). ADR 0003 (every write names the Revision it was computed from). The connector's
consent gate for `remove_course` and `remove_program` on the student's Plan.
