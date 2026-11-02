/** Carrying everything that names a Course when it is swapped (#54).
 *
 * THE BUG. A student swaps ECON 102 for the ECON 104 their Program
 * lists as an alternative. The card changes. The `not-in spring`
 * Constraint they had set still names ECON 102 — a Course no longer in
 * their Plan — so it applies to nothing, silently, and the optimiser is
 * free to put ECON 104 in exactly the term they said they could not do.
 * A preference they stated is gone and nobody told them.
 *
 * Completion has the same shape: a Course marked passed by code, then
 * swapped, leaves the flag pointing at something absent.
 *
 * BOTH SURFACES HAD IT. The planner carried `moves` across and nothing
 * else; the connector mirrored the planner deliberately rather than
 * inventing a fix in one place. So this is one function and they both
 * call it.
 *
 * WHY CARRY RATHER THAN DROP. A Constraint is a statement about the
 * student's week — "I cannot do a lab that term" — not about a course
 * number. Swapping which course fills the slot does not make them
 * free on Tuesday afternoon. Dropping it would silently discard a
 * preference; refusing the swap while one exists would make a
 * reasonable change impossible for the students most likely to need
 * it. Carrying it is the reading that matches what they meant, and the
 * caller says it happened so the student can disagree.
 */
import type { PlanDoc } from "./types.js";

export interface SwapCarry {
  /** Constraints whose subject moved to the new code. */
  constraints: { type: string; termIndex: number }[];
  /** True when the outgoing Course was marked completed and the flag
   * followed. */
  completed: boolean;
  /** True when a manual move followed. */
  moved: boolean;
}

/** Point everything that named `oldCode` at `newCode`, in place.
 *
 * Only the references — the card itself is the caller's to rewrite,
 * because what makes a swap legal (the Template's own list of
 * alternatives) is checked there. */
export function carryCourseRefs(plan: PlanDoc, oldCode: string, newCode: string): SwapCarry {
  const carried: SwapCarry = { constraints: [], completed: false, moved: false };

  if (plan.constraints?.length) {
    plan.constraints = plan.constraints.map((c) => {
      if (c.code !== oldCode) return c;
      carried.constraints.push({ type: c.type, termIndex: c.termIndex });
      return { ...c, code: newCode };
    });
  }

  if (plan.completed?.[oldCode]) {
    delete plan.completed[oldCode];
    plan.completed[newCode] = true;
    carried.completed = true;
  }

  // Item ids are the Course code for a Template-placed card, which is
  // why a move keyed by the old code has to follow it. A move keyed by
  // something else — an added course, a filled Slot — was never about
  // this card.
  if (plan.moves && oldCode in plan.moves) {
    plan.moves[newCode] = plan.moves[oldCode];
    delete plan.moves[oldCode];
    carried.moved = true;
  }

  return carried;
}

/** What to tell a student about it, or null when nothing followed.
 *
 * SAID OUT LOUD, because a Constraint moving is a decision made on
 * their behalf about what they meant. Silence here would be the
 * version of this bug where the preference survives and they still do
 * not know where it went. */
export function describeCarry(carry: SwapCarry, oldCode: string, newCode: string): string | null {
  const parts: string[] = [];
  if (carry.constraints.length) {
    parts.push(
      `the scheduling ${carry.constraints.length === 1 ? "constraint" : "constraints"} you set on ` +
        `${oldCode} now ${carry.constraints.length === 1 ? "applies" : "apply"} to ${newCode}`,
    );
  }
  if (carry.completed) parts.push(`${newCode} is marked as already taken, as ${oldCode} was`);
  if (!parts.length) return null;
  return `Carried over: ${parts.join("; ")}.`;
}
