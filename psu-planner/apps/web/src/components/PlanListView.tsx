/** Accessible equivalent of the flowchart canvas: semantic lists, real
 * buttons, text status labels, and keyboard-operable move controls. Everything
 * the canvas can do (open details, move between semesters, spot violations)
 * is available here without a pointer. */
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
  if (!plan) return null;

  const move = (it: PlanItem, delta: number) => {
    const target = Math.max(0, Math.min(plan.terms.length - 1, it.sem + delta));
    if (target === it.sem) return;
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
              <span className="lv-credits"> — {credits.toFixed(1).replace(/\.0$/, "")} credits</span>
            </h2>
            <ul>
              {termItems.map((it) => {
                const c = it.code ? catalog[it.code] : undefined;
                const unverified = it.kind === "course" && !c;
                const overridden = it.kind === "course" && it.code ? !!plan.prereqOverrides?.[it.code] : false;
                const status = it.kind === "slot" ? ""
                  : unverified ? "not in catalog — verify with adviser"
                  : overridden ? "prerequisite override — adviser-confirmed"
                  : STATUS_TEXT[cardStatus(catalog, it, sched)];
                return (
                  <li key={it.id}>
                    <div className="lv-main">
                      {it.kind === "slot" ? (
                        <>
                          <b>Open slot: {it.slotLabel ?? it.slot}</b> ({it.credits ?? "?"} credits)
                        </>
                      ) : (
                        <>
                          <b>{c?.display ?? it.code}</b> — {c?.title ?? ""} ({c?.credits ?? "? credits"})
                          {(it.alternatives?.length ?? 0) > 0 && <span> · alternative: {it.alternatives!.join(", ")}</span>}
                        </>
                      )}
                      {status && <span className={`lv-status${status.includes("VIOLATION") ? " bad" : ""}`}> · {status}</span>}
                    </div>
                    <div className="lv-actions">
                      <button onClick={() => onOpenItem(it)} aria-label={`Details for ${it.code ?? it.slotLabel ?? "slot"}`}>Details</button>
                      <button onClick={() => move(it, -1)} disabled={it.sem === 0} aria-label={`Move ${it.code ?? "slot"} one semester earlier`}>← earlier</button>
                      <button onClick={() => move(it, +1)} disabled={it.sem >= plan.terms.length - 1} aria-label={`Move ${it.code ?? "slot"} one semester later`}>later →</button>
                    </div>
                  </li>
                );
              })}
              {termItems.length === 0 && <li className="lv-empty">No courses this semester.</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
