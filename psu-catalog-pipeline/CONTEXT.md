# Catalog Pipeline

Turns Penn State's published sources into a Catalog the planner can read. Its
governing obligation is that everything in a Catalog is traceable to source
bytes, and that anything it could not read says so rather than guessing.

## Language

### The artifact

**Catalog**:
The complete published description of one Edition: every Course, Program,
Requirement Rule, and Registry Entry.
_Avoid_: dataset, dump, index

**Edition**:
One academic year's bulletin, the version a student's degree requirements are
governed by. A student is bound to the Edition in force when they entered their
major, not the newest one.
_Avoid_: year, version, catalog year

**Subject**:
A course prefix and the courses under it.
_Avoid_: department, discipline — a department may own several Subjects, and
the two are not interchangeable.

**Program**:
A credential a student can earn: a major, minor, or certificate. Distinct per
campus, because the same credential at two campuses is two Programs with
different requirements.

### Requirements

**Requirement Section**:
One titled block of a Program's requirements.

**Requirement Rule**:
A single obligation within a Section: take this Course, or choose among these,
or earn this many credits from some set of courses.

**Adviser-Defined Requirement**:
A Requirement Rule whose satisfying set is settled by a conversation with an
adviser and is published nowhere. The absence of a list is the requirement's
actual content, not a gap in our data.
_Avoid_: unparsed, missing, unknown — all three imply we failed to find
something that exists.

**Registry**:
Our record of satisfying course lists that the bulletin names but does not
contain, each carried with the source it was read from and when.
_Avoid_: overrides — the word implies we are overruling the bulletin, when we
are completing it from the source it points at.

**Registry Entry**:
One such list, scoped to a Program, an Edition, and a Campus Scope.

**Campus Scope**:
Which campuses a Registry Entry speaks for. A list published by University Park
does not silently speak for a branch campus; where a campus publishes its own,
that one is its own Entry.

### Confidence

**Unverified**:
A Catalog reference we could not resolve to a real Course. Recorded so it can be
shown as doubtful, never dropped and never treated as satisfied.

**Dangling Reference**:
A course code the bulletin itself cites that does not exist, usually a stale
code the university has not corrected.

**Coverage**:
A one-way relation stating that passing one Course makes another redundant.
Directional by nature: the reverse is a separate claim and usually false.
_Avoid_: equivalence, substitution — both suggest symmetry.

**Needs Review**:
Something read from source but not trusted enough to publish unexamined. A
human confirms it or it does not enter the Catalog.
