/** Where can this course legally go?
 *
 * The question a student asks by dragging a course somewhere its
 * prerequisites are not met. The planner already tells them it broke; this is
 * what lets it also offer the fix.
 *
 * NOT the same question `repairPrereqOrdering` answers. That one runs at
 * generation time over a bulletin's own suggested plan and moves the
 * PREREQUISITE earlier — correct there, because the bulletin got the ordering
 * wrong and the prerequisite genuinely belongs sooner. Here the student has
 * just placed this course deliberately, and its prerequisites have
 * prerequisites of their own; pulling MATH 140 back to term 0 to satisfy a
 * dragged MATH 141 would trade one violation for another. So the dependent
 * moves, not its dependencies.
 *
 * No second scheduler: the whole computation is "ask `checkCourse` the same
 * question it already answers, once per candidate term, and take the first
 * yes". The engine stays the single authority on what satisfies what.
 */
import { checkCourse } from "./evaluate.js";
import { SAT, UNSAT, type Catalog, type PlanDoc, type Schedule } from "./types.js";

export interface LegalTerm {
  /** 0-based index of the earliest term where the course's prereqs hold. */
  term: number;
  /** In-plan prerequisite codes that were blocking it where it sits now.
   * The student is about to be told their course moves; they are owed the
   * reason, and the reason is a course code they recognise. */
  blockedBy: string[];
  /** Courses already in the plan that DEPEND on this one and would fall out
   * of order once it moves later. Usually empty.
   *
   * "Nothing else moves" is true of this fix and still misleading when this
   * is non-empty: nothing moves, and something breaks. A fix that trades one
   * violation for another has to say so before it is accepted, not after. */
  breaks: string[];
}

/**
 * The earliest term at or after `from` where `code`'s enforced prerequisites
 * are satisfied, or `null` if it is already fine or nowhere in the plan works.
 *
 * `null` for "already legal" and `null` for "impossible" are deliberately the
 * same answer: in both cases there is no move to offer. A caller that needs to
 * tell them apart can ask `checkCourse` directly.
 *
 * Pass `plan` to skip Gap Terms. A Gap Term is an intentional emptiness — a
 * co-op, a leave — and quietly dropping a course into one cancels a decision
 * the student made on purpose.
 */
export function earliestLegalTerm(
  catalog: Catalog,
  code: string,
  from: number,
  sched: Schedule,
  termCount: number,
  plan?: PlanDoc,
): LegalTerm | null {
  if (!catalog[code]) return null;

  const here = checkCourse(catalog, code, from, sched);
  if (here.value === SAT) return null;

  // The overall value is NOT the test. Most real prerequisites are or-groups
  // with alternatives the plan does not contain -- "MATH 140 or 140B or 140E
  // or 140H" -- and an absent alternative reads UNK, which drags the whole
  // group to UNK even when the one branch the student actually planned is
  // violated. `repairPrereqOrdering` makes the same distinction for the same
  // reason. What is broken, and what the student sees as a red edge, is an
  // IN-PLAN prerequisite sitting too late.
  const blockedBy = [
    ...new Set(
      here.leaves
        .filter((l): l is Extract<typeof l, { kind: "inplan" }> => l.kind === "inplan" && l.v === UNSAT)
        .map((l) => l.code),
    ),
  ];
  // Nothing in the plan is blocking it: the uncertainty is external (a
  // transfer, a placement test). Moving a course the planner merely cannot
  // verify would be acting on ignorance -- iron rule 2 says unreadable must
  // never be treated as broken.
  if (!blockedBy.length) return null;

  for (let t = from + 1; t < termCount; t++) {
    if (plan?.terms[t]?.gap) continue;
    // Legal by the same measure: no in-plan prerequisite left sitting too
    // late. Requiring full SAT here would reject every or-group course,
    // since the external alternatives stay UNK wherever it is placed.
    const there = checkCourse(catalog, code, t, sched);
    const stillBlocked = there.leaves.some((l) => l.kind === "inplan" && l.v === UNSAT);
    if (!stillBlocked) return { term: t, blockedBy, breaks: dependentsBrokenBy(catalog, code, t, sched) };
  }
  return null;
}

/**
 * Which in-plan courses depend on `code` and would be out of order if it sat
 * at `term`.
 *
 * Asked by re-checking each dependent against a schedule in which `code` has
 * already moved, rather than by reasoning about the graph: the engine stays
 * the single authority on what satisfies what, and a second opinion here
 * would be a second opinion to keep in step.
 */
function dependentsBrokenBy(catalog: Catalog, code: string, term: number, sched: Schedule): string[] {
  const moved: Schedule = { ...sched };
  const self = sched[code];
  if (!self?.item) return [];
  // `sem` on the ENTRY is what checkCourse reads; `item.sem` is carried for
  // callers that want the plan item. Both are updated, because overriding
  // only the item left the evaluation looking at the old position and the
  // breakage set silently empty.
  moved[code] = { ...self, sem: term, item: { ...self.item, sem: term } };

  const broken: string[] = [];
  for (const other of Object.keys(sched)) {
    if (other === code) continue;
    const entry = sched[other];
    if (!entry?.item || entry.sem < 0) continue;
    const before = checkCourse(catalog, other, entry.sem, sched);
    const after = checkCourse(catalog, other, entry.sem, moved);
    // Only newly broken ones. A course already out of order is not something
    // this move did, and blaming it here would make the warning noise.
    const wasOk = !before.leaves.some((l) => l.kind === "inplan" && l.v === UNSAT && l.code === code);
    const nowBad = after.leaves.some((l) => l.kind === "inplan" && l.v === UNSAT && l.code === code);
    if (wasOk && nowBad) broken.push(other);
  }
  return [...new Set(broken)].sort();
}
