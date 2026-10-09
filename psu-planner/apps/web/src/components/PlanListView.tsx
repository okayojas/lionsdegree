/** Accessible equivalent of the flowchart canvas: semantic lists, real
 * buttons, text status labels, and keyboard-operable move controls.
 *
 * The canvas is pointer-only by construction -- absolutely positioned cards
 * with prerequisite edges drawn between them -- so this is not a convenience
 * view, it is the whole of the product for anyone not using a mouse.
 * Everything the canvas conveys has to be reachable here, and conveyed in
 * WORDS: a student who cannot see the red edge needs to be told the order is
 * violated. */
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
  const { plan, catalog, items, sched, mutatePlan } = usePlanner();

  /** Which move control was last activated, so focus can be put back on it.
   *
   * Moving a course re-renders it under a DIFFERENT term heading, so React
   * unmounts the button that was pressed and focus falls to <body>. A
   * keyboard user then has to tab from the top of the page again for every
   * single semester they want to shift a course, which makes the feature
   * technically present and practically unusable. */
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (!refocus.current) return;
    const sel = `[data-move="${CSS.escape(refocus.current)}"]`;
    const el = document.querySelector<HTMLElement>(sel);
    refocus.current = null;
    // A course moved to the last term has its "later" button disabled, so
    // fall back to the sibling control rather than focusing something inert.
    if (el && !(el as HTMLButtonElement).disabled) el.focus();
    else el?.parentElement?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  });

  if (!plan) return null;

  const move = (it: PlanItem, delta: number) => {
    const target = Math.max(0, Math.min(plan.terms.length - 1, it.sem + delta));
    if (target === it.sem) return;
    refocus.current = `${it.id}:${delta}`;
    mutatePlan((p) => { p.moves[it.id] = target; });
  };

  return (
    <div className="listview" role="region" aria-label="Degree plan, list view">
      {plan.terms.map((term, ti) => {
        const termItems = items.filter((it) => it.sem === ti);
        const credits = termItems.reduce((s, it) => s + credOf(it, catalog), 0);
        return (
          <section key={ti} aria-labelledby={`term-h-${ti}`}>
            <h2 id={`term-h-${ti}`}>
              {term.label}
              {/* A gap term renders with its own styling on the canvas. Here it
                  has to be words, or the term just looks empty for no reason. */}
              {term.gap ? (
                <span className="lv-credits"> — skipped semester (gap)</span>
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
                const name = it.code ?? it.slotLabel ?? "slot";
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
                      <button onClick={() => onOpenItem(it)} aria-label={`Details for ${name}`}>Details</button>
                      <button
                        data-move={`${it.id}:-1`}
                        onClick={() => move(it, -1)}
                        disabled={it.sem === 0}
                        aria-label={`Move ${name} one semester earlier`}
                      >
                        ← earlier
                      </button>
                      <button
                        data-move={`${it.id}:1`}
                        onClick={() => move(it, +1)}
                        disabled={it.sem >= plan.terms.length - 1}
                        aria-label={`Move ${name} one semester later`}
                      >
                        later →
                      </button>
                    </div>
                  </li>
                );
              })}
              {termItems.length === 0 && (
                <li className="lv-empty">{term.gap ? "Skipped semester — no courses." : "No courses this semester."}</li>
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
