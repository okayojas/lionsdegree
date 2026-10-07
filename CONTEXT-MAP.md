# Context Map

LionsDegree has two contexts. They share no code and communicate only through a
published artifact: a Catalog for one bulletin Edition.

## Contexts

- [Catalog Pipeline](./psu-catalog-pipeline/CONTEXT.md): ingests Penn State's
  published bulletin and department sources into a Catalog
- [Planner](./psu-planner/CONTEXT.md): builds, schedules, and audits a student's
  Plan against a Catalog

## Relationships

- **Catalog Pipeline → Planner**: the pipeline emits one Catalog per Edition;
  the planner consumes it as read-only data. There is no live call between them.
  The Catalog is the only boundary artifact, and it is the contract.
- **Direction is one-way.** The planner never writes to a Catalog and never
  corrects one. Where a Catalog is wrong or incomplete, the planner's job is to
  say so to the student, not to patch it.
- **Authority at render time belongs to the Catalog the Plan is pinned to.**
  Judgements the pipeline records about its own confidence feed review work;
  they do not travel into a Plan as permanent facts.

Decisions that govern the boundary itself (Edition policy, Registry shape, what
the Catalog is obliged to carry) belong in the root [`docs/adr/`](./docs/adr/),
not in either context's own.
