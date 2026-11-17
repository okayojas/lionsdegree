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
import { useEffect, useState } from "react";
import { usePlanner } from "../store";
import { PHONE_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { CANDIDATE_NAME_MAX, candidatesOf, contentsOf } from "@psu-planner/engine";
import { loadProgramsIndex } from "../data/catalogClient";
import { differenceFrom, shapeOf } from "../data/whatIfDifference";

export function CandidateRail({ onToast }: { onToast: (msg: string) => void }) {
  const {
    plan, catalog, candidateId, home,
    showCandidate, keepCandidate, deleteCandidate, newCandidate, renameCandidate,
  } = usePlanner();
  /** What each Program is called, for the line that says how a what-if
   * differs. A slug until the names arrive, never a blank. */
  const [programNames, setProgramNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void loadProgramsIndex()
      .then((index) => { if (live) setProgramNames(Object.fromEntries(index.map((e) => [e.slug, e.name]))); })
      .catch(() => { /* the slugs stand in */ });
    return () => { live = false; };
  }, []);
  const phone = useMediaQuery(PHONE_QUERY);
  // ON A PHONE THE RAIL IS NOT A RAIL. At 412px the planner has no 200px
  // to give away, so it starts as one control that opens the list — and
  // nothing may push the chart off the screen (#23).
  const [open, setOpen] = useState(false);
  /** Which what-if is being renamed, and what has been typed so far. */
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);

  // Copies only. One stored the old way is converted when the Plan loads
  // (store.ts); until then it is not something a tab could show.
  const candidates = candidatesOf(plan);
  if (!plan) return null;

  /* HOW EACH ONE DIFFERS FROM THE PLAN, worked out here and now from the two
     as they are. The Plan's own contents are `home` while a what-if is in
     view, and the plan in view otherwise; the open what-if's are the plan
     in view, which is ahead of the copy on the list by whatever has been
     edited since it was opened. */
  const nameOf = (slug: string): string => programNames[slug] ?? slug;
  const mine = shapeOf(home ?? contentsOf(plan), catalog);
  const differs = (id: string, stored: Parameters<typeof shapeOf>[0]): string =>
    differenceFrom(mine, shapeOf(id === candidateId ? contentsOf(plan) : stored, catalog), nameOf);

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
                <span className="rail-meta">{differs(c.id, c.plan)}</span>
              </button>
              {on && (
                /* SAID IN WORDS, because the chart under a what-if looks
                   exactly like the student's plan. The one outcome worth
                   ruling out is an edit they believe is going to their
                   degree. */
                <p className="rail-editing" role="status">
                  Editing this what-if. Your plan is untouched.
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
                    maxLength={CANDIDATE_NAME_MAX}
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
