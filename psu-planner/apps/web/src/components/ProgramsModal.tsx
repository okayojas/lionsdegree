/** Declare a Program, or drop one, on a Plan the student already has.
 *
 * Before this screen existed the only way to change which Programs a Plan was
 * for was "Start over", which deletes the Plan: two years of completed
 * Courses, every Course the student added, every Slot they filled and every
 * Constraint they set. A student who declares a minor in October was being
 * asked to pay for it with all of that.
 *
 * CHANGING one for another is one step (#69): pick the one to replace and
 * its replacement, read what would leave and what would come, and decide.
 * It used to be "add the program you are switching to first", then drop.
 *
 * Dropping is a two-step conversation rather than a confirm box. The blast
 * radius is bigger than removing one Course — it can take Courses, filled
 * Slots and whole requirements with it — so the student reads what WOULD
 * happen, named item by item, and only then decides.
 */
import { useEffect, useMemo, useState } from "react";
import type { ChangeProgramResult, RemoveProgramPreview } from "@psu-planner/engine";
import { loadProgramsIndex, type ProgramIndexEntry } from "../data/catalogClient";
import { usePlanner } from "../store";
import { Dialog } from "./Dialog";

export function ProgramsModal({ onClose, onToast, changing: startChanging = null }: {
  onClose: () => void;
  onToast: (msg: string) => void;
  /** Open already choosing a replacement for this Program. */
  changing?: string | null;
}) {
  const plan = usePlanner((s) => s.plan);
  const [index, setIndex] = useState<ProgramIndexEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The withdrawal the student is being shown, before it happens. */
  const [pending, setPending] = useState<RemoveProgramPreview | null>(null);
  /** The Program being replaced, while its replacement is chosen. */
  const [changing, setChanging] = useState<string | null>(startChanging);
  /** The change the student is being shown, before it happens. */
  const [pendingChange, setPendingChange] = useState<ChangeProgramResult | null>(null);

  useEffect(() => {
    loadProgramsIndex()
      .then(setIndex)
      .catch(() => setError("Could not load the program list — is the catalog data deployed?"));
  }, []);

  const nameOf = (slug: string) => index?.find((p) => p.slug === slug)?.name ?? slug;

  const matches = useMemo(() => {
    if (!index || !plan) return [];
    const q = query.toLowerCase().trim();
    const pool = index.filter((p) => !plan.programs.includes(p.slug));
    // Replacing a major, the first thing offered is another major; with
    // nothing typed and nothing being replaced, minors, which is what a
    // student most often adds.
    const kind = changing ? index.find((p) => p.slug === changing)?.type ?? "major" : "minor";
    if (!q) return pool.filter((p) => p.type === kind).slice(0, 15);
    return pool.filter((p) => p.name.toLowerCase().includes(q) || p.slug.includes(q)).slice(0, 25);
  }, [index, plan, query, changing]);

  if (!plan) return null;

  const add = async (p: ProgramIndexEntry) => {
    setBusy(p.slug);
    setError(null);
    try {
      const msg = await usePlanner.getState().addProgramNow(p.slug);
      onToast(msg);
      onClose();
    } catch {
      setError(`Could not add ${p.name}. Your plan is unchanged.`);
    } finally {
      setBusy(null);
    }
  };

  const askToChange = async (to: ProgramIndexEntry) => {
    if (!changing) return;
    setBusy(to.slug);
    setError(null);
    try {
      const preview = await usePlanner.getState().previewChangeProgram(changing, to.slug);
      if (!preview) setError(`Could not load ${to.name}, so nothing was changed.`);
      else setPendingChange(preview);
    } catch {
      setError("Could not work out what that change would do, so nothing was changed.");
    } finally {
      setBusy(null);
    }
  };

  const confirmChange = async (change: ChangeProgramResult) => {
    setBusy(change.to);
    try {
      const msg = await usePlanner.getState().changeProgramNow(change.from, change.to);
      onToast(msg);
      onClose();
    } catch {
      setError("Could not make that change. Your plan is unchanged.");
    } finally {
      setBusy(null);
    }
  };

  const askToDrop = async (slug: string) => {
    setBusy(slug);
    setError(null);
    try {
      setPending(await usePlanner.getState().previewDropProgram(slug));
    } catch {
      setError("Could not work out what dropping that would do, so nothing was changed.");
    } finally {
      setBusy(null);
    }
  };

  const confirmDrop = async (slug: string) => {
    setBusy(slug);
    try {
      const msg = await usePlanner.getState().removeProgramNow(slug);
      onToast(msg);
      onClose();
    } catch {
      setError("Could not drop that program. Your plan is unchanged.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog label="Your programs" onClose={onClose}>
      <h2>Your programs</h2>
      <p className="desc">
        Add a major, minor or certificate to this plan, or drop one. Courses you have completed,
        courses you added yourself, slots you have filled and the rules you set all stay — the new
        requirements fold into the terms you already have.
      </p>

      {pendingChange ? (
        <div className="status warn" role="status">
          <h3 style={{ margin: "0 0 6px" }}>Change {nameOf(pendingChange.from)} to {nameOf(pendingChange.to)}?</h3>
          {pendingChange.refusal ? (
            <p className="desc">{pendingChange.refusal}</p>
          ) : (
            <>
              <p className="desc">
                Courses you have completed and courses you added yourself stay. Nothing has
                been changed yet.
              </p>
              {(pendingChange.removed?.coursesRemoved.length ?? 0) > 0 && (
                <p className="desc">
                  <b>Leaves your plan:</b> {pendingChange.removed!.coursesRemoved.join(", ")}
                  {pendingChange.removed!.creditsRemoved > 0 ? ` (${pendingChange.removed!.creditsRemoved} credits)` : ""}
                </p>
              )}
              {(pendingChange.added?.coursesAdded.length ?? 0) > 0 && (
                <p className="desc">
                  <b>Comes in:</b> {pendingChange.added!.coursesAdded.join(", ")}
                </p>
              )}
              {(pendingChange.removed?.coursesKept.length ?? 0) > 0 && (
                <p className="desc">
                  <b>Stays, because {nameOf(pendingChange.to)} needs it too:</b>{" "}
                  {pendingChange.removed!.coursesKept.join(", ")}
                </p>
              )}
              {(pendingChange.removed?.filledSlotsCleared.length ?? 0) > 0 && (
                <p className="desc">
                  <b>Slots you had already chosen a course for:</b>{" "}
                  {pendingChange.removed!.filledSlotsCleared.map((s) => `${s.label} → ${s.code}`).join(", ")}
                </p>
              )}
              {(pendingChange.removed?.unfilled.length ?? 0) > 0 && (
                <>
                  <p className="desc"><b>Left unfilled in your other programs:</b></p>
                  <ul className="desc">
                    {pendingChange.removed!.unfilled.map((u, i) => (
                      <li key={`${u.program}-${u.requirement}-${i}`}>
                        {u.requirement} ({u.program}) — {u.because}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
          <div className="row">
            {!pendingChange.refusal && (
              <button disabled={busy === pendingChange.to} onClick={() => void confirmChange(pendingChange)}>
                {busy === pendingChange.to ? "Changing…" : `Yes, change to ${nameOf(pendingChange.to)}`}
              </button>
            )}
            <button onClick={() => setPendingChange(null)}>Keep {nameOf(pendingChange.from)}</button>
          </div>
        </div>
      ) : pending ? (
        <div className="status warn" role="status">
          <h3 style={{ margin: "0 0 6px" }}>Drop {nameOf(pending.program)}?</h3>
          {pending.refusal ? (
            <p className="desc">{pending.refusal}</p>
          ) : (
            <>
              <p className="desc">{pending.note}</p>
              {pending.coursesRemoved.length > 0 && (
                <p className="desc">
                  <b>Leaves your plan:</b> {pending.coursesRemoved.join(", ")}
                  {pending.creditsRemoved > 0 ? ` (${pending.creditsRemoved} credits)` : ""}
                </p>
              )}
              {pending.coursesKept.length > 0 && (
                <p className="desc">
                  <b>Stays, because another program needs it:</b> {pending.coursesKept.join(", ")}
                </p>
              )}
              {pending.filledSlotsCleared.length > 0 && (
                <p className="desc">
                  <b>Slots you had already chosen a course for:</b>{" "}
                  {pending.filledSlotsCleared.map((s) => `${s.label} → ${s.code}`).join(", ")}
                </p>
              )}
              {pending.unfilled.length > 0 && (
                <>
                  <p className="desc"><b>Left unfilled:</b></p>
                  <ul className="desc">
                    {pending.unfilled.map((u, i) => (
                      <li key={`${u.program}-${u.requirement}-${i}`}>
                        {u.requirement} ({u.program}) — {u.because}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {pending.remainingChecked.length === 0 && (
                <p className="desc">
                  We could not read your other programs' requirements, so this list may be
                  incomplete. Check with your adviser before you drop it.
                </p>
              )}
            </>
          )}
          <div className="row">
            {!pending.refusal && (
              <button
                disabled={busy === pending.program}
                onClick={() => void confirmDrop(pending.program)}
              >
                {busy === pending.program ? "Dropping…" : `Yes, drop ${nameOf(pending.program)}`}
              </button>
            )}
            <button onClick={() => setPending(null)}>Keep it</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginTop: 10 }}>
            {plan.programs.map((slug) => (
              <div key={slug} className="row" style={{ alignItems: "center", marginTop: 8 }}>
                <span style={{ flex: 1 }}><b>{nameOf(slug)}</b></span>
                <button
                  disabled={!!busy}
                  aria-pressed={changing === slug}
                  aria-label={`Change ${nameOf(slug)} for another program`}
                  onClick={() => { setChanging(changing === slug ? null : slug); setQuery(""); }}
                >
                  {changing === slug ? "Changing…" : "Change"}
                </button>
                <button
                  disabled={busy === slug || plan.programs.length === 1}
                  title={plan.programs.length === 1 ? "A plan needs a program: use Change to switch to another" : "See what dropping this would do"}
                  onClick={() => void askToDrop(slug)}
                >
                  {busy === slug ? "Checking…" : "Drop"}
                </button>
              </div>
            ))}
          </div>

          <p className="desc" style={{ marginTop: 16 }}>
            <b>{changing ? `Change ${nameOf(changing)} to…` : "Add another program"}</b>
            {changing && (
              <>
                {" "}
                <button type="button" onClick={() => setChanging(null)}>Cancel</button>
              </>
            )}
          </p>
          <input
            placeholder="Search majors, minors and certificates"
            aria-label={changing ? `Search for the program to change ${nameOf(changing)} to` : "Search programs to add"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: "100%" }}
          />
          {!index && !error && <p className="desc">Loading programs…</p>}
          <div style={{ maxHeight: "34vh", overflow: "auto", marginTop: 6 }}>
            {matches.map((p) => (
              <div key={p.slug} className="row" style={{ alignItems: "center", marginTop: 8 }}>
                <span style={{ flex: 1 }}>
                  {p.name}
                  <span style={{ color: "var(--muted)", display: "block", fontSize: 12 }}>
                    {p.type}{p.college ? ` · ${p.college}` : ""}
                  </span>
                </span>
                {changing ? (
                  <button
                    disabled={!!busy}
                    aria-label={`Change to ${p.name}`}
                    onClick={() => void askToChange(p)}
                  >
                    {busy === p.slug ? "Checking…" : "Change to this"}
                  </button>
                ) : (
                  <button disabled={!!busy} onClick={() => void add(p)}>
                    {busy === p.slug ? "Adding…" : "Add"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {error && <p style={{ color: "var(--red)" }}>{error}</p>}
      <div className="row"><button onClick={onClose}>Close</button></div>
    </Dialog>
  );
}
