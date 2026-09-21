/** Prereq-ordering repair for freshly generated plans.
 * The bulletin's suggested plans sometimes violate their own enforced
 * prerequisites (AIE schedules STAT 401 alongside A-I 305, which requires it
 * as a prior course). The departments' official flowcharts fix this by moving
 * the prerequisite earlier (advising.engr.psu.edu AIE chart: STAT 401 -> sem 3)
 * — this pass reproduces that repair generically: any in-plan enforced
 * prerequisite scheduled at-or-after its dependent moves to the dependent's
 * previous semester. Iterates to a fixpoint so cascades resolve. */
import { checkCourse } from "./evaluate.js";
import { buildItems, buildSchedule } from "./schedule.js";
import { SAT, UNSAT, type Catalog, type PlanDoc } from "./types.js";

export interface RepairMove {
  code: string;
  from: number;
  to: number;
}

export function repairPrereqOrdering(plan: PlanDoc, catalog: Catalog, maxIterations = 5): RepairMove[] {
  const moves: RepairMove[] = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    const items = buildItems(plan, catalog);
    const sched = buildSchedule(plan, items, catalog);
    let movedThisPass = false;

    for (const it of items) {
      if (it.kind !== "course" || !it.code) continue;
      const chk = checkCourse(catalog, it.code, it.sem, sched);
      // Repair whenever the course isn't cleanly satisfied and an in-plan
      // prerequisite sits too late. Or-groups often read UNK (external
      // alternatives), but the violated in-plan leaf still draws a red edge —
      // moving it earlier upgrades the whole course to SAT.
      if (chk.value === SAT) continue;
      for (const leaf of chk.leaves) {
        if (leaf.kind !== "inplan" || leaf.v !== UNSAT) continue;
        const prereqItem = sched[leaf.code]?.item;
        if (!prereqItem?.code || prereqItem.sem < 0) continue;
        const target = it.sem - 1;
        if (target < 0 || prereqItem.sem <= target) continue;
        // Only template courses relocate by moving their spec between terms;
        // user-added courses move via their `sem` field.
        const src = plan.terms[prereqItem.sem];
        const idx = src?.items.findIndex((s) => "code" in s && s.code === prereqItem.code) ?? -1;
        if (idx >= 0) {
          const [spec] = src.items.splice(idx, 1);
          plan.terms[target].items.push(spec);
        } else {
          const added = plan.added.find((a) => a.code === prereqItem.code);
          if (!added) continue;
          added.sem = target;
        }
        delete plan.moves[prereqItem.id];
        moves.push({ code: prereqItem.code, from: prereqItem.sem, to: target });
        movedThisPass = true;
      }
    }
    if (!movedThisPass) break;
  }
  return moves;
}
