# 4. A student may keep a what-if that removes a Course or a Program

Date: 2026-11-15

## Status

**Mechanism superseded by ADR 0006 (#69).** A what-if is a copy now and keeping one is a swap,
so nothing is replayed and the `byTheStudent` flag described below no longer exists. The
decision this ADR records, that a student's own click may keep a what-if that takes a Course
or a Program out, stands.

Accepted. **The decision itself is the owner's and its record is the
comment on issue #59**; what is here is why the rule it replaces existed,
the mechanism that implements it, and what the choice costs — the parts a
reader of the code six months from now needs and the issue does not
carry. Narrows nothing about the connector's consent gate; see "What does
not change".

## Context

`remove_course` and `remove_program` demand two things of a caller: the
flag `user_explicitly_asked`, and `student_words` — the student's own
sentence, echoed back into the answer. The gate exists because a MODEL
can assert that a student asked for something when they did not, and the
echo is what makes a fabricated claim findable in the transcript beside
the dropped requirement (DECISIONS.md 5.0, S4).

#56 put a what-if beside the student's plan as a tab. Keeping one replays
its changes through the ordinary mutation path, so a what-if containing
`remove_course` hit that gate — and a button is not a quote. The tab
refused. The result was a planner that refused, from one tab, an action
it permits on the next tab along:

- `removeItem` and `removeProgramNow` in the planner's own store take no
  consent argument at all. A student drops a Course with one click and a
  confirm, which is the path S4 itself names as the safe one.
- The same student, having asked their assistant to show them the same
  removal as a what-if, could look at it and never take it.

That asymmetry was inherited, not decided. It arrived because the tab was
built on the connector's mutation path and the gate came with it.

#59 made it blocking rather than cosmetic: with the `+`, the student can
author a what-if themselves, so a student-authored removal would have hit
the identical wall the moment the ticket shipped.

## Decision

**A student clicking "keep this one" in their own planner may keep a
what-if containing `remove_course` or `remove_program`. No quote, no
typed sentence.**

Mechanically this is one optional field on `ToolContext`,
`byTheStudent`, set in exactly one place — `keepCandidate` in
`apps/web/src/data/candidateRun.ts`, in the browser — and read in exactly
two, the consent branches of `remove_course` and `remove_program`. It is
not an argument, so nothing arriving over the wire can set it, and
`candidates.test.ts` fails if any file in `packages/mcp/src` ever assigns
it.

A removal made this way reports `on_the_strength_of: "the student kept a
what-if containing this removal, in their own planner"`, because the
alternative — `String(args.student_words ?? "")`, an empty string —
reads in a transcript as a removal justified by nothing said at all.

## What does not change

- **The connector's gate.** Over the wire `remove_course` and
  `remove_program` still require `user_explicitly_asked` AND
  `student_words`, still reject model narration ("the user asked me to"),
  and still echo the quote. No hosted test about consent changed.
- **The warning.** `needsConsent` is still computed by `runChanges` and
  still shown on the tab BEFORE the student chooses. Removing the refusal
  is not removing the warning: the rail stopped refusing and started
  telling, and `save_candidate` tells the assistant the same thing in
  `keeping_it_removes`.
- **Reversibility.** `restore_course`, Menu → Removed items and plan
  history all still work, which is most of why this is affordable.

## Consequences

**Bought.** The two paths agree. A refusal a student can route around by
clicking a different tab teaches them that refusals here are noise, and a
refusal nobody trusts is worse than no refusal. A whole class of what-if
— every one that drops something — stops being a dead end discovered at
the last step.

**Given up.** A student can now remove a required Course in two clicks
from a tab rather than from the card. That was already two clicks on the
card, so what is actually given up is the extra friction the tab had by
accident, and the audit trail is better than the card's: the removal
names the what-if it came from.

**Not chosen.** Tightening both paths instead — making the planner's own
`removeItem` demand a typed sentence. It would make the two agree, and it
would make the planner demand a quote from the only person in the system
who cannot fabricate one, on an action that is reversible. The gate is
aimed at a model; aiming it at the student would be theatre.
