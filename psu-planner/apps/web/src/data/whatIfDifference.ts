/** How a what-if differs from the Plan, in one line for its tab (#69).
 *
 * A what-if is a whole copy of the Plan, so "3 changes" no longer describes
 * it. What a student comparing tabs wants is what each one comes to:
 * which Programs, how many credits, how many Terms, and when it ends.
 *
 * Worked out when the tab is drawn, from the two plans as they are. Nothing
 * is stored: a stored summary would be a second thing to keep true.
 */
import { buildItems, progress, type Catalog, type PlanContents, type PlanDoc } from "@psu-planner/engine";

/** What a plan comes to. */
export interface PlanShape {
  programs: string[];
  /** Total credits, or `null` where the catalog on hand does not have every
   * Course the plan names: a total that left some out would be a smaller
   * number offered as the answer. */
  credits: number | null;
  /** Terms of classes: not the ones the student has marked to skip. */
  terms: number;
  /** The Terms marked to skip, by name. */
  skipped: string[];
  /** The last Term it uses, "Spring 2030". */
  lastTerm: string | null;
}

/** The Terms a plan puts something in, by position.
 *
 * BY PLACEMENT, which is `moves` over where the document lists a thing:
 * a Course dragged to an earlier Term is in that Term, whatever `terms`
 * still says. Read off `terms` alone, a what-if whose last Term had been
 * emptied by dragging still "ended" there, and an empty Term added at
 * the end counted as a Term of classes. Needs no catalog. */
function termsInUse(plan: PlanContents): Set<number> {
  const removed = plan.removed ?? {};
  const at = (id: string, listed: number): number => (id in plan.moves ? plan.moves[id]! : listed);
  const used = new Set<number>();
  plan.terms.forEach((term, i) => {
    for (const it of term.items) {
      const id = "slot" in it ? it.id : it.code;
      if (!removed[id]) used.add(at(id, i));
    }
  });
  for (const a of plan.added) used.add(at(`add-${a.code}`, a.sem));
  return used;
}

/** Every Course code a plan names. */
function codesIn(plan: PlanContents): string[] {
  return [
    ...plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : []))),
    ...plan.added.map((a) => a.code),
    ...Object.values(plan.slotFills),
    ...Object.keys(plan.completed),
  ];
}

export function shapeOf(contents: PlanContents, catalog: Catalog): PlanShape {
  const doc = { ...contents, id: "", rev: 0, updatedAt: "" } as PlanDoc;
  const inUse = termsInUse(contents);
  const used = doc.terms.filter((t, i) => !t.gap && inUse.has(i));
  const known = codesIn(contents).every((code) => catalog[code]);
  return {
    programs: [...doc.programs],
    credits: known ? progress(doc, buildItems(doc, catalog), catalog).total : null,
    terms: used.length,
    skipped: doc.terms.filter((t) => t.gap).map((t) => t.label),
    lastTerm: used[used.length - 1]?.label ?? null,
  };
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The line a what-if's tab carries: how it differs from the Plan.
 *
 * `nameOf` turns a Program's slug into what the student calls it. */
export function differenceFrom(mine: PlanShape, whatIf: PlanShape, nameOf: (slug: string) => string): string {
  const parts: string[] = [];
  const added = whatIf.programs.filter((p) => !mine.programs.includes(p)).map(nameOf);
  const dropped = mine.programs.filter((p) => !whatIf.programs.includes(p)).map(nameOf);
  if (added.length && dropped.length) parts.push(`${added.join(" and ")} instead of ${dropped.join(" and ")}`);
  else if (added.length) parts.push(`adds ${added.join(" and ")}`);
  else if (dropped.length) parts.push(`without ${dropped.join(" and ")}`);

  if (mine.credits !== null && whatIf.credits !== null && mine.credits !== whatIf.credits) {
    const by = Math.abs(whatIf.credits - mine.credits);
    parts.push(`${count(by, "credit", "credits")} ${whatIf.credits > mine.credits ? "more" : "fewer"}`);
  }
  // A SKIPPED TERM IS SAID AS ONE. Counted only as "1 term fewer", a term
  // off reads as finishing a term sooner, which is the opposite of what
  // the student did.
  const skips = whatIf.skipped.filter((label) => !mine.skipped.includes(label));
  const unskips = mine.skipped.filter((label) => !whatIf.skipped.includes(label));
  if (skips.length) parts.push(`skips ${skips.join(" and ")}`);
  if (unskips.length) parts.push(`uses ${unskips.join(" and ")}`);
  if (mine.terms !== whatIf.terms) {
    const by = Math.abs(whatIf.terms - mine.terms);
    parts.push(`${count(by, "term", "terms")} of classes ${whatIf.terms > mine.terms ? "more" : "fewer"}`);
  }
  if (whatIf.lastTerm && whatIf.lastTerm !== mine.lastTerm) parts.push(`ends ${whatIf.lastTerm}`);

  return parts.length ? parts.join(" · ") : "The same as your plan, so far";
}
