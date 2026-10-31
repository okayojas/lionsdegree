# Planner

Builds a student's Plan from one or more Programs and schedules it so every
prerequisite is respected. Its governing obligation is that an uncertain answer
is shown as uncertain, never resolved into a confident wrong one.

## Language

### The plan

**Plan**:
A student's own semester-by-semester schedule. Pinned to one Edition at
creation, and governed by that Edition for its life.
_Avoid_: schedule, degree audit — a schedule is one view of a Plan, and an
audit is one judgement about it.

**Term**:
One scheduled period in a Plan: a fall, a spring, or an opted-in summer.
_Avoid_: semester — a summer is a Term and is not a semester.

This is not a house word the interface has to teach. LionPATH's own glossary
defines Term as "a period of study in an academic year (e.g., spring, summer,
fall)" — summer included, by Penn State's registrar — so it is the word the
student already enrolled through.

Two places legitimately keep "semester", and both are **quotation**, not copy:
- the advisor's tool descriptions, which quote how the request arrives ("I'm
  taking a semester off") so the model can recognise it — an input to match,
  never output to echo;
- policy text rendered verbatim, e.g. GCAC-210 on IUG admission. A student
  checking a citation against the Graduate Bulletin must find the same words.

`apps/web/test/vocabulary.test.ts` enforces this, including the exceptions.
The one thing it does NOT rename is `plan.semesters` in saved plan files and
in the catalog's suggested plans: that is a serialized shape, no student ever
sees it, and renaming it would break every plan already saved.

**Gap Term**:
A Term the student intends to leave empty, for a co-op, leave, or gap year. An
intentional emptiness, distinct from a Term that merely has nothing in it yet.

**Template**:
The order and pacing a Program's own published plan suggests. A starting shape,
not an obligation: we keep its ordering and discard its spacing.

**Origin**:
Which Program's Template an item came from, and where it sat there. What makes
a double major's shared requirements countable once rather than twice.

**Constraint**:
A rule the student imposes on their own Plan, such as refusing a Term for a
Course. Survives rescheduling, which is what separates it from a manual move.

**Capstone**:
The culminating course or sequence a Program ends with. Identified by what it
is called, not merely by where it falls.

### What fills a term

**Course**:
A specific catalog course placed in a Term.

**Slot**:
A placeholder for a requirement the student has not yet chosen a Course for. It
has credits and a requirement behind it, but no course yet. Gen eds and
electives are both Slots.
_Avoid_: elective, placeholder, open requirement — the first names only one
kind, the second says nothing about why it exists, and the third is a synonym
we rejected.

**Pool**:
The set of Courses that may fill a Slot, together with where that knowledge came
from and how far it can be trusted. Provenance is part of the Pool, not metadata
about it, because the five sources differ enormously in reliability and the
student has to be told which one they are looking at.

A Pool is one of six kinds:

- **Listed**: the bulletin names the courses outright. Authoritative.
- **Patterned**: derived from the subjects and course levels the requirement
  describes. Only as good as our reading of that description.
- **General Education**: any course carrying a given Gen Ed designation.
- **Registry**: a list from a Registry Entry, carrying its source and date.
- **Adviser**: no list exists anywhere, because the requirement is settled by a
  conversation. A kind of Pool in its own right, never an empty one — an empty
  list would tell the student no course qualifies, which is false.
- **Unreadable**: a list exists but we failed to read it. Distinct from
  Adviser, which is the absence of a list rather than a failure to find one.
  The two look similar to a student and must not be confused in counting:
  Adviser requirements are excluded from coverage because they have no answer
  by design, Unreadable ones are work still to do.

**Suggestion**:
A Course offered to the student for a particular Slot, ranked by how well it
fits their Plan. Never a claim that the course runs in that Term: we cannot see
course offerings and say so.
_Avoid_: recommendation — we rank options against a Plan, we do not advise.

### Judgements

**Satisfied**:
A requirement a Plan demonstrably meets.

**Unknown**:
A requirement we cannot judge either way, usually because the prerequisite text
defeated reading. Distinct from unmet, and never collapsed into satisfied.

**Revision**:
Which version of a Plan this is. Advances on every edit, including edits no
server has seen. It says where a copy IS, never what it was working from —
which is why agreement needs a second number, below.
_Avoid_: version — a Plan has no versions a student would name.

**Agreement**:
The Revision a device last knew the server was holding for a Plan. What a
write names, and what the server must still be at for the write to land. A
write naming a Revision the server has moved past is **Refused**: nothing is
merged and nothing is overwritten.

**Refused**:
A write that did not happen because the Plan had changed somewhere else. The
student is told and keeps their copy; it is not an error, and it is not a
silent loss. See ADR 0003.

**Violation**:
A Course scheduled before something it enforces as a prerequisite.
