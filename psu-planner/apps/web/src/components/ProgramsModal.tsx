/** Declare a Program, or drop one, on a Plan the student already has.
 *
 * Before this screen existed the only way to change which Programs a Plan was
 * for was "Start over", which deletes the Plan: two years of completed
 * Courses, every Course the student added, every Slot they filled and every
 * Constraint they set. A student who declares a minor in October was being
 * asked to pay for it with all of that.
 *
 * Dropping is a two-step conversation rather than a confirm box. The blast
 * radius is bigger than removing one Course — it can take Courses, filled
 * Slots and whole requirements with it — so the student reads what WOULD
 * happen, named item by item, and only then decides.
 */
import { useEffect, useMemo, useState } from "react";
import type { RemoveProgramPreview } from "@psu-planner/engine";
import { loadProgramsIndex, type ProgramIndexEntry } from "../data/catalogClient";
import { usePlanner } from "../store";
import { Dialog } from "./Dialog";

export function ProgramsModal({ onClose, onToast }: { onClose: () => void; onToast: (msg: string) => void }) {
  const plan = usePlanner((s) => s.plan);
  const [index, setIndex] = useState<ProgramIndexEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The withdrawal the student is being shown, before it happens. */
  const [pending, setPending] = useState<RemoveProgramPreview | null>(null);

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
    if (!q) return pool.filter((p) => p.type === "minor").slice(0, 15);
    return pool.filter((p) => p.name.toLowerCase().includes(q) || p.slug.includes(q)).slice(0, 25);
  }, [index, plan, query]);

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

      {pending ? (
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
                  disabled={busy === slug || plan.programs.length === 1}
                  title={plan.programs.length === 1 ? "Add the program you are switching to first" : "See what dropping this would do"}
                  onClick={() => void askToDrop(slug)}
                >
                  {busy === slug ? "Checking…" : "Drop"}
                </button>
              </div>
            ))}
          </div>

          <p className="desc" style={{ marginTop: 16 }}><b>Add another program</b></p>
          <input
            placeholder="Search majors, minors and certificates"
            aria-label="Search programs to add"
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
                <button disabled={!!busy} onClick={() => void add(p)}>
                  {busy === p.slug ? "Adding…" : "Add"}
                </button>
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
