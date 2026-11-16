/** The rail: the student's own Plan and the what-ifs beside it.
 *
 * WHY THIS EXISTS (#56). A student could ask "what if I added a summer,
 * moved CHEM 110 earlier and finished in seven terms?" and get an answer
 * they could not LOOK at — a flowchart in a different visual language from
 * the chart they already know how to read. Clicking a tab here draws that
 * what-if with the planner's own chart, because it is the planner's own
 * chart. Nothing draws a degree plan twice.
 *
 * AND WHY IT IS ALWAYS HERE NOW (#59). It used to render nothing until a
 * what-if existed, and the only thing that could make one was a connector
 * tool — so for every student without an AI assistant, which is all of
 * them on a first visit, the feature was invisible. The `+` is the door on
 * the student's side. With no what-ifs it is the ONLY thing here: a rail
 * holding one tab is not a comparison, and the strip stays narrow enough
 * that the chart loses nothing worth noticing.
 *
 * ON THE LEFT, because the side panel is already on the right with a
 * load-bearing resizer between it and the chart, and because a list you
 * pick from belongs on the side a left-to-right reader scans first.
 *
 * THE REAL PLAN IS THE FIRST TAB AND SAYS SO. The failure worth ruling out
 * is a student editing what they believe is their plan while a what-if is
 * open — which matters MORE now that a what-if can be edited, so the open
 * tab says in words that edits are going to the what-if.
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
    showCandidate, keepCandidate, deleteCandidate, newCandidate, renameCandidate,
  } = usePlanner();
  const phone = useMediaQuery(PHONE_QUERY);
  // ON A PHONE THE RAIL IS NOT A RAIL. At 412px the planner has no 200px
  // to give away, so it starts as one control that opens the list — and
  // nothing may push the chart off the screen (#23).
  const [open, setOpen] = useState(false);
  /** Which what-if is being renamed, and what has been typed so far. */
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);

  const candidates = plan?.candidates ?? [];
  if (!plan) return null;

  const none = candidates.length === 0;
  const expanded = none || !phone || open;
  const pick = (id: string | null) => {
    void showCandidate(id);
    if (phone) setOpen(false);
  };

  const makeOne = async () => {
    const said = await newCandidate();
    onToast(said);
    // OPEN, NOT SHUT. Picking a what-if closes the phone list because the
    // choice is made; MAKING one is the opposite. Closing here means the
    // first what-if a student ever makes appears and vanishes in the same
    // frame — before there was one the rail had nothing to collapse into,
    // so the tab they just asked for is the thing that disappears.
    if (phone) setOpen(true);
  };

  return (
    <nav className={`rail${none ? " empty" : ""}${expanded ? "" : " collapsed"}`} aria-label="Your plan and your what-ifs">
      {phone && !none && (
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
        {!none && (
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
        )}
        {candidates.map((c) => {
          const on = candidateId === c.id;
          /* WHAT KEEPING TAKES OUT, SAID BEFORE THEY CHOOSE (#59).
             This used to be a refusal: keeping a what-if that drops a
             required Course or a Program was blocked, because that
             removal wants the student's own words and a button is not a
             quote. The gate is against a MODEL claiming a student asked;
             the student pressing this is the same person making the same
             one-click removal the course card already allows, so the
             planner stops refusing and starts telling. Removing is still
             reversible — Menu → Removed items, and plan history. */
          const removes = on ? (candidateView?.needsConsent ?? []) : [];
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
              {on && candidateView && (
                /* SAID IN WORDS, because a what-if is editable now and the
                   chart under it looks exactly like the student's plan.
                   The one outcome worth ruling out is an edit they believe
                   is going to their degree. */
                <p className="rail-editing" role="status">
                  Editing this what-if. Your plan is untouched.
                </p>
              )}
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
              {on && removes.length > 0 && (
                <p className="rail-problem" role="status">
                  Keeping this takes {removes.join(", ")} out of your degree. You can put a course
                  back from Menu → Removed items.
                </p>
              )}
              {renaming?.id === c.id ? (
                <form
                  className="rail-rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    onToast(renameCandidate(c.id, renaming.text));
                    setRenaming(null);
                  }}
                >
                  {/* A label, not a placeholder: a placeholder disappears
                      the moment there is text in the box, which is exactly
                      when a screen reader reaches it. */}
                  <label htmlFor={`rename-${c.id}`}>Name this what-if</label>
                  <input
                    id={`rename-${c.id}`}
                    type="text"
                    value={renaming.text}
                    maxLength={40}
                    autoFocus
                    onChange={(e) => setRenaming({ id: c.id, text: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }}
                  />
                  <div className="rail-acts">
                    <button type="submit">Save</button>
                    <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
                  </div>
                </form>
              ) : (
                <div className="rail-acts">
                  {on && (
                    <button
                      type="button"
                      disabled={!candidateView}
                      aria-label={`Keep "${c.name}" as your plan`}
                      onClick={async () => onToast(await keepCandidate(c.id))}
                    >
                      Keep this one
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Rename the what-if "${c.name}"`}
                    onClick={() => setRenaming({ id: c.id, text: c.name })}
                  >
                    Rename
                  </button>
                  {/* NO CONFIRMATION. Throwing away a sketch has to be
                      cheap, and nothing in the plan goes with it. */}
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
              )}
            </li>
          );
        })}
        <li className="rail-item new">
          <button
            type="button"
            className="rail-new"
            aria-label="Make a new what-if, starting as your plan"
            onClick={() => void makeOne()}
          >
            + What-if
          </button>
        </li>
      </ul>
    </nav>
  );
}
