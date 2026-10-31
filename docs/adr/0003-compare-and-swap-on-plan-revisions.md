# 3. Compare-and-swap on Plan revisions

Date: 2026-10-31

## Status

Accepted. Supersedes the last-write-wins row of DECISIONS.md §1.

## Context

A Plan syncs between a student's devices through one row per (user, plan).
Until now the two reconciled by last-write-wins on `updatedAt`: the client
read the remote timestamp, compared it with its own, and wrote if it looked
newer.

Three things were wrong with that, and they compound.

It was a read followed by a write with nothing holding them together. Two
tabs saving at once both passed their own check, and the second erased the
first.

It compared clocks on two devices, which disagree, and disagree silently.

And when it lost, nothing said so. A student's edit vanished and the only
evidence was that their plan looked different later.

The planner is also about to stop being the only writer. The hosted
connector's mutating tools write to this same row (#36), driven by a model
we do not control. A conflict policy honoured by one writer is not a
conflict policy.

## Decision

A write names the Revision it last saw the server holding, and lands only
if the server is still at it. Otherwise it is Refused: no bytes move, and
the student is told.

Mechanically this is a conditional update — the row is matched on
`rev = <the revision we agreed on>` — so the compare and the swap are one
statement that another writer cannot land inside. A trigger additionally
refuses any write that would move `rev` backwards, as a backstop against a
careless client rather than as the mechanism.

Agreement is tracked per Plan on the device, separately from the Plan's own
Revision. This separation is the whole decision. `rev` advances on every
edit, including edits no server has seen — the push is debounced and two
quick edits coalesce into one — so `rev` says where a copy IS, never what
it was working from. A rule written against it alone is monotonicity, not
agreement: measured concretely, two tabs at revision 5, one edits once and
pushes 6, the other edits twice and pushes 7 — and 7 beats 6, so the first
tab's work is gone. That was the first implementation of this ADR and two
reviews caught it.

## Consequences

**Bought.** No edit is destroyed without the student hearing about it. The
rule lives in one place and binds every writer, including ones not written
yet. Clock skew stops mattering.

**Given up.** A refused write is work the student must re-apply; we do not
merge, because merging two versions of a degree plan means inventing a
schedule neither of them chose (iron rule 2). Offline editing across
several devices will refuse more often than last-write-wins did — it will
just say so, which is the trade.

**Not chosen.** CRDTs, still: one user, a whole document as the unit, and
rare conflicts. Refusing is enough and is far easier to reason about when
the thing at stake is whether someone graduates on time.
