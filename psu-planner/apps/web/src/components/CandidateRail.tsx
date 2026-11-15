/** The rail: the student's own Plan and the what-ifs beside it.
 *
 * WHY THIS EXISTS (#56). A student could ask "what if I added a summer,
 * moved CHEM 110 earlier and finished in seven terms?" and get an answer
 * they could not LOOK at — a flowchart in a different visual language from
 * the chart they already know how to read. Clicking a tab here draws that
 * what-if with the planner's own chart, because it is the planner's own
 * chart. Nothing draws a degree plan twice.
 *
 * ON THE LEFT, because the side panel is already on the right with a
 * load-bearing resizer between it and the chart, and because a list you
 * pick from belongs on the side a left-to-right reader scans first.
 *
 * THE REAL PLAN IS THE FIRST TAB AND SAYS SO. The failure worth ruling out
 * is a student editing what they believe is their plan while a what-if is
 * open: a tab that cannot be edited must not look like one that can.
 *
 * NOT RENDERED AT ALL WITH NO WHAT-IFS. A rail holding one tab is not a
 * comparison, and taking width off the chart to show it would be a cost
 * with nothing bought.
 *
 * Buttons, not an ARIA tablist. A tab in a tablist may not contain
 * focusable children, and each of these carries its own Keep and Close —
 * so they are ordinary buttons, named by what and which, with
 * `aria-pressed` saying which one is showing. That is the same shape the
 * toolbar's view toggle already uses, and it keeps every control reachable
 * by Tab rather than behind arrow keys.
 */
import { useState } from "react";
import { usePlanner } from "../store";
import { PHONE_QUERY, useMediaQuery } from "../hooks/useMediaQuery";

export function CandidateRail({ onToast }: { onToast: (msg: string) => void }) {
  const {
    plan, candidateId, candidateBusy, candidateRefusal, candidateView,
    showCandidate, keepCandidate, deleteCandidate,
  } = usePlanner();
  const phone = useMediaQuery(PHONE_QUERY);
  // ON A PHONE THE RAIL IS NOT A RAIL. At 412px the planner has no 200px
  // to give away, so it starts as one control that opens the list — and
  // nothing may push the chart off the screen (#23).
  const [open, setOpen] = useState(false);

  const candidates = plan?.candidates ?? [];
  if (!plan || candidates.length === 0) return null;

  const expanded = !phone || open;
  const pick = (id: string | null) => {
    void showCandidate(id);
    if (phone) setOpen(false);
  };

  return (
    <nav className={`rail${expanded ? "" : " collapsed"}`} aria-label="Your plan and your what-ifs">
      {phone && (
        <button
          type="button"
          className="rail-toggle"
          aria-expanded={open}
          aria-controls="rail-list"
          onClick={() => setOpen(!open)}
        >
          {candidateId
            ? `Showing a what-if (${candidates.length})`
            : `Your plan · ${candidates.length} what-${candidates.length === 1 ? "if" : "ifs"}`}
        </button>
      )}
      <ul id="rail-list" className="rail-list" hidden={!expanded}>
        <li className={`rail-item mine${candidateId === null ? " on" : ""}`}>
          <button
            type="button"
            className="rail-pick"
            aria-pressed={candidateId === null}
            aria-label="Show your own plan"
            onClick={() => pick(null)}
          >
            <span className="rail-kind">Your plan</span>
            <span className="rail-name">The one that is saved</span>
          </button>
        </li>
        {candidates.map((c) => {
          const on = candidateId === c.id;
          /* WHY KEEPING CAN BE REFUSED BEFORE IT IS TRIED. Taking a required
             Course or a whole Program out of a degree needs the student to
             ask for it in their own words; a button on a what-if is not
             that. Saying so on the tab is the difference between an option
             and a dead end they find at the last step. */
          const blocked = on ? (candidateView?.needsConsent ?? []) : [];
          return (
            <li key={c.id} className={`rail-item${on ? " on" : ""}`}>
              <button
                type="button"
                className="rail-pick"
                aria-pressed={on}
                aria-label={`Show the what-if "${c.name}"`}
                onClick={() => pick(c.id)}
              >
                <span className="rail-kind">What-if</span>
                <span className="rail-name">{c.name}</span>
                <span className="rail-meta">
                  {c.changes.length} change{c.changes.length === 1 ? "" : "s"}
                  {on && candidateBusy ? " · working it out…" : ""}
                  {on && candidateRefusal ? " · can't be worked out" : ""}
                </span>
              </button>
              {on && candidateRefusal && (
                /* SAID ON THE TAB, AND NOTHING IS DRAWN. A what-if whose
                   change has stopped being possible must not be rendered as
                   a partial plan — the words are the connector's own, so a
                   student reads the same sentence here as their assistant
                   would have read. */
                <p className="rail-problem" role="status">
                  {candidateRefusal.position ? `${candidateRefusal.position}: ` : ""}
                  {candidateRefusal.reason} {candidateRefusal.nothingChanged}
                </p>
              )}
              {on && blocked.length > 0 && (
                <p className="rail-problem" role="status">
                  Keeping this would take {blocked.join(", ")} out of your degree, which a what-if
                  tab cannot do. Remove it from the course itself if that is what you want.
                </p>
              )}
              <div className="rail-acts">
                {on && (
                  <button
                    type="button"
                    disabled={!candidateView || blocked.length > 0}
                    aria-label={`Keep "${c.name}" as your plan`}
                    onClick={async () => onToast(await keepCandidate(c.id))}
                  >
                    Keep this one
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Delete the what-if "${c.name}"`}
                  onClick={() => {
                    deleteCandidate(c.id);
                    onToast(`Deleted the what-if "${c.name}". Your plan is untouched.`);
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
