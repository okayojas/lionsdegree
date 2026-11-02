/** Putting back what a prior-credit claim took away (#53).
 *
 * IN THE ENGINE, not in the connector, because BOTH surfaces have to
 * do it the same way. The connector learned to stash exactly what each
 * claim cleared — the cards, their Origin, Slot fills, manual moves —
 * so withdrawing the claim restores the real requirement where the
 * student's Program had placed it. The planner did not read that
 * record: un-ticking the same Course in the browser fell back to a
 * blind re-add, the optimiser put the Course wherever it fitted, and
 * Origin was lost — so a requirement two Programs share stopped
 * counting once.
 *
 * One student action, two outcomes depending on which surface they
 * used, and the worse one in the UI. That is the divergence #39 was
 * written to avoid, so the fix is one function both call rather than
 * the connector giving up its better behaviour.
 */
import type { ClearedByPriorCredit, PlanDoc, PlanItemSpec } from "./types.js";
export interface UnrecordResult {
  /** Codes no longer recorded as taken. */
  noLongerRecorded: string[];
  /** Course codes put back into the Terms. */
  restored: string[];
  /** Codes we had no note for, so the Course itself was put back instead. */
  restoredBlind: string[];
}

/** Un-record `codes` and put back whatever recording them took away. */
export function unrecordPriorCredit(plan: PlanDoc, codes: readonly string[]): UnrecordResult {
  const result: UnrecordResult = { noLongerRecorded: [], restored: [], restoredBlind: [] };

  for (const code of codes) {
    delete plan.completed[code];
    result.noLongerRecorded.push(code);

    const note = plan.clearedByPriorCredit?.[code];
    if (!note) {
      // NO NOTE MEANS SOMEBODY ELSE RECORDED IT — the planner's own
      // checkbox, or a spreadsheet import, both of which predate this
      // tool. We cannot know which card it cleared, and the student is
      // now short a Course they have not taken, so it goes back on the
      // chart the way the planner's own un-mark does it. Without this the
      // Course would be neither passed nor scheduled, which is a
      // requirement quietly deleted.
      const scheduled = plan.terms.some((t) => t.items.some((i) => "code" in i && i.code === code));
      if (!scheduled && !plan.added.some((a) => a.code === code)) {
        plan.added.push({ code, sem: 0 });
        result.restoredBlind.push(code);
      }
      continue;
    }

    for (const { term, spec } of note.items) {
      if (present(plan, spec)) continue;
      // Clamped rather than dropped: the Plan may have fewer Terms than it
      // had when this was recorded (an optimize since then), and a card
      // restored into a term that no longer exists is a card the student
      // never sees again. The optimizer re-flows it from here anyway.
      if (!plan.terms.length) plan.terms.push({ label: "", items: [] });
      const at = Math.min(term, plan.terms.length - 1);
      plan.terms[at].items.push(structuredClone(spec));
      if ("code" in spec) result.restored.push(spec.code);
    }
    for (const entry of note.added) {
      if (!plan.added.some((a) => a.code === entry.code)) {
        plan.added.push({ ...entry });
        result.restored.push(entry.code);
      }
    }
    for (const [slotId, fill] of Object.entries(note.slotFills)) {
      // Only if the Slot is still unanswered. The student may have filled
      // it with something else since, and overwriting that choice would be
      // this tool deciding which Course satisfies their requirement.
      if (!(slotId in plan.slotFills)) plan.slotFills[slotId] = fill;
    }
    for (const [id, term] of Object.entries(note.moves)) {
      // A move made SINCE wins: it is the student's more recent word about
      // where that card goes.
      if (!(id in plan.moves)) plan.moves[id] = term;
    }

    delete plan.clearedByPriorCredit![code];
  }

  return result;
}

function present(plan: PlanDoc, spec: PlanItemSpec): boolean {
  return plan.terms.some((t) =>
    t.items.some((i) =>
      "code" in spec ? "code" in i && i.code === spec.code : "slot" in i && i.id === spec.id,
    ),
  );
}
