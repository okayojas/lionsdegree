/** Accessible equivalent of the flowchart canvas: semantic lists, real
 * buttons, text status labels, and keyboard-operable controls.
 *
 * The canvas is pointer-only by construction -- absolutely positioned cards
 * with prerequisite edges drawn between them -- so this is not a convenience
 * view, it is the whole of the product for anyone not using a mouse.
 * Everything the canvas can DO has to be doable here, and everything it
 * conveys has to be conveyed in WORDS: a student who cannot see the red edge
 * needs to be told the order is violated.
 *
 * Vocabulary: a scheduled period is a Term, never a "semester" -- a summer is
 * a Term and is not a semester, and this view can hold one (CONTEXT.md). A
 * Term the student means to leave empty is a Gap Term, which is an
 * intentional emptiness and distinct from a Term that merely has nothing in
 * it yet; the copy has to keep those apart or the two read identically. */
import { useEffect, useRef } from "react";
import { cardStatus, credOf, type PlanItem } from "@psu-planner/engine";
import { usePlanner } from "../store";

const STATUS_TEXT: Record<string, string> = {
  ok: "prerequisites satisfied",
  warn: "depends on courses outside the plan — verify",
  bad: "PREREQUISITE ORDER VIOLATION",
  none: "",
};

export function PlanListView({ onOpenItem }: { onOpenItem: (it: PlanItem) => void }) {
  const { plan, catalog, items, sched, mutatePlan, addSemester, deleteSemester, restoreSemester } = usePlanner();

  /** Which move control was last activated, so focus can be put back on it.
   *
   * Moving a course re-renders it under a DIFFERENT Term heading, so React
   * unmounts the button that was pressed and focus falls to <body>. A
   * keyboard user then has to tab from the top of the page again for every
   * single Term they want to shift a course, which makes the feature
   * technically present and practically unusable. */
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (!refocus.current) return;
    const want = refocus.current;
    refocus.current = null;
    const el = document.querySelector<HTMLElement>(`[data-move="${CSS.escape(want)}"]`);
    if (el && !(el as HTMLButtonElement).disabled) {
      el.focus();
      return;
    }
    // The course landed on the last Term, so the control that was pressed is
    // now disabled. Fall back to the OTHER move button -- `[data-move]`, not
    // the first button in the row, which is Details and would silently move a
    // keyboard user off the controls they were working with.
    el?.parentElement?.querySelector<HTMLElement>("[data-move]:not([disabled])")?.focus();
  });

  if (!plan) return null;

  const last = plan.terms.length - 1;
  const move = (it: PlanItem, delta: number) => {
    const target = Math.max(0, Math.min(last, it.sem + delta));
    if (target === it.sem) return;
    refocus.current = `${it.id}:${delta}`;
    mutatePlan((p) => { p.moves[it.id] = target; });
  };

  /** Which Term an item is listed under.
   *
   * CLAMPED, because `buildItems` does not clamp: it returns whatever is in
   * `plan.moves` verbatim. A move left pointing past the end -- by an
   * optimize that shortened the plan, or by a chat or MCP tool -- gives an
   * item a `sem` matching no Term, and bucketing on equality alone made it
   * vanish from this view entirely while the canvas still drew it. Losing a
   * course silently is the one outcome worth ruling out. */
  const termOf = (it: PlanItem) => Math.max(0, Math.min(last, it.sem));

  return (
    <div className="listview" role="region" aria-label="Degree plan, list view">
      {plan.terms.map((term, ti) => {
        const termItems = items.filter((it) => termOf(it) === ti);
        const credits = termItems.reduce((s, it) => s + credOf(it, catalog), 0);
        return (
          <section key={ti} aria-labelledby={`term-h-${ti}`}>
            <h2 id={`term-h-${ti}`}>
              {term.label}
              {/* A Gap Term renders with its own styling on the canvas. Here it
                  has to be words, and words that say INTENTIONAL -- otherwise
                  it reads the same as a Term nothing has been put in yet. */}
              {term.gap ? (
                <span className="lv-credits"> — gap term, intentionally left empty</span>
              ) : (
                <span className="lv-credits"> — {credits.toFixed(1).replace(/\.0$/, "")} credits</span>
              )}
            </h2>
            <ul>
              {termItems.map((it) => {
                const c = it.code ? catalog[it.code] : undefined;
                const unverified = it.kind === "course" && !c;
                const completed = it.kind === "course" && it.code ? !!plan.completed[it.code] : false;
                const overridden = it.kind === "course" && it.code ? !!plan.prereqOverrides?.[it.code] : false;
                // Completed wins: once a course is behind the student, whether
                // its prerequisites are met in the current layout is noise.
                const status = it.kind === "slot" ? ""
                  : completed ? "completed"
                  : unverified ? "not in catalog — verify with adviser"
                  : overridden ? "prerequisite override — adviser-confirmed"
                  : STATUS_TEXT[cardStatus(catalog, it, sched)];
                const label = it.code ?? it.slotLabel ?? "slot";
                return (
                  <li key={it.id}>
                    <div className="lv-main">
                      {it.kind === "slot" ? (
                        <>
                          <b>Open slot: {it.slotLabel ?? it.slot}</b> ({it.credits ?? "?"} credits)
                        </>
                      ) : (
                        <>
                          {/* Monospace is for course codes and nothing else, so the
                              code is its own element rather than styling the whole row. */}
                          <b className="lv-code">{c?.display ?? it.code}</b> — {c?.title ?? ""} ({c?.credits ?? "? credits"})
                          {(it.alternatives?.length ?? 0) > 0 && <span> · alternative: {it.alternatives!.join(", ")}</span>}
                        </>
                      )}
                      {status && (
                        <span className={`lv-status${status.includes("VIOLATION") ? " bad" : ""}${completed ? " done" : ""}`}>
                          {" · "}{status}
                        </span>
                      )}
                    </div>
                    <div className="lv-actions">
                      {/* Details carries everything the canvas shows on a card that
                          is too long for a row: the prerequisite leaves and which
                          course each one refers to, concurrency, and the override. */}
                      <button onClick={() => onOpenItem(it)} aria-label={`Details for ${label}`}>Details</button>
                      <button
                        data-move={`${it.id}:-1`}
                        onClick={() => move(it, -1)}
                        disabled={it.sem === 0}
                        aria-label={`Move ${label} one term earlier`}
                      >
                        ← earlier
                      </button>
                      <button
                        data-move={`${it.id}:1`}
                        onClick={() => move(it, +1)}
                        disabled={it.sem >= last}
                        aria-label={`Move ${label} one term later`}
                      >
                        later →
                      </button>
                    </div>
                  </li>
                );
              })}
              {termItems.length === 0 && (
                <li className="lv-empty">
                  {term.gap ? "Gap term — intentionally left empty." : "Nothing in this term yet."}
                </li>
              )}
            </ul>
            {/* Skipping is a Plan operation the canvas offers on every column
                header. Without it here, "everything in the Plan is reachable"
                is only true of what the Plan SAYS, not of what can be done. */}
            <div className="lv-term-actions">
              {term.gap ? (
                <button onClick={() => void restoreSemester(ti)} aria-label={`Use ${term.label} instead of leaving it empty`}>
                  Use this term
                </button>
              ) : (
                <button onClick={() => void deleteSemester(ti)} aria-label={`Skip ${term.label} — a co-op, leave or gap year`}>
                  Skip this term
                </button>
              )}
            </div>
          </section>
        );
      })}
      <div className="lv-term-actions">
        <button onClick={() => addSemester()} aria-label="Add another term to the end of the plan">
          Add a term
        </button>
      </div>
    </div>
  );
}
