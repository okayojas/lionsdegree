/** Post-onboarding schedule import, term-aware: term labels in the
 * spreadsheet decide what happens — terms before today are marked completed,
 * current/future terms are scheduled into the matching plan terms, and
 * undated courses are shown for the student to decide. */
import { useRef, useState } from "react";
import {
  currentTermKey, extractSchedule, fileToText, termKey,
  type ScheduleEntry, type TermRef,
} from "../data/importSchedule";
import { ApCreditPicker, CourseSearchPicker } from "./CreditPickers";
import { usePlanner } from "../store";
import { Dialog } from "./Dialog";

type Disposition = "completed" | "schedule" | "skip";

interface Row {
  code: string;
  term: TermRef | null;
  disposition: Disposition;
  targetSem: number; // plan term index for "schedule"
}

/** Match "Fall 2027" style plan labels to a TermRef; fall back to nearest end. */
function targetSemFor(term: TermRef | null, labels: string[]): number {
  if (!term) return 0;
  const ix = labels.findIndex((l) => l.toLowerCase().includes(`${term.season.toLowerCase()} ${term.year}`));
  if (ix >= 0) return ix;
  // Not an exact label — clamp chronologically using any parseable labels.
  const parsed = labels.map((l) => {
    const m = /(fall|spring|summer)\s+(20\d{2})/i.exec(l);
    return m ? termKey({ season: m[1][0].toUpperCase() === "F" ? "Fall" : m[1][0].toUpperCase() === "S" && m[1].toLowerCase().startsWith("sp") ? "Spring" : "Summer", year: parseInt(m[2], 10) }) : null;
  });
  const key = termKey(term);
  for (let i = 0; i < parsed.length; i++) if (parsed[i] !== null && key <= parsed[i]!) return i;
  return labels.length - 1;
}

export function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const { plan, items, applyImport } = usePlanner();

  const [rows, setRows] = useState<Row[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const labels = plan?.terms.map((t) => t.label) ?? [];
  const alreadyCompleted = new Set(Object.keys(plan?.completed ?? {}).filter((c) => plan!.completed[c]));
  const inPlan = new Set(items.filter((i) => i.kind === "course").map((i) => i.code!));
  const nowKey = currentTermKey();

  const ingest = (entries: ScheduleEntry[]) => {
    if (!entries.length) { setError("No course codes found — check the file/text."); return; }
    setError(null);
    const known = new Set(rows.map((r) => r.code));
    const next: Row[] = entries
      .filter((e) => !known.has(e.code) && !alreadyCompleted.has(e.code))
      .map((e) => {
        const past = e.term ? termKey(e.term) < nowKey : null;
        const disposition: Disposition =
          past === true ? "completed"
          : past === false ? (inPlan.has(e.code) ? "skip" : "schedule")
          : "completed"; // undated — default, user can flip
        return { code: e.code, term: e.term, disposition, targetSem: targetSemFor(e.term, labels) };
      });
    setRows((cur) => [...cur, ...next]);
  };

  const apply = async () => {
    const completed = rows.filter((r) => r.disposition === "completed").map((r) => r.code);
    const scheduled = rows
      .filter((r) => r.disposition === "schedule")
      .map((r) => ({ code: r.code, sem: r.targetSem }));
    // One store call: mark completed (mapping onto existing cards), fold in the
    // scheduled courses, and re-optimize so the flowchart adapts instead of
    // stacking everything in the last term.
    await applyImport(completed, scheduled);
    onDone(
      [
        completed.length ? `${completed.length} marked completed` : "",
        scheduled.length ? `${scheduled.length} added and re-optimized into your plan` : "",
      ].filter(Boolean).join(", ") || "Nothing imported",
    );
    onClose();
  };

  const setDisposition = (code: string, d: Disposition) =>
    setRows(rows.map((r) => (r.code === code ? { ...r, disposition: d } : r)));

  const groups: { title: string; note: string; filter: (r: Row) => boolean }[] = [
    { title: "Past terms → completed", note: "From term labels before today.", filter: (r) => r.disposition === "completed" && r.term !== null },
    { title: "Current & future terms → scheduled", note: "Placed into the matching term on your flowchart.", filter: (r) => r.disposition === "schedule" },
    { title: "No date found — choose", note: "Defaulting to completed; click to change.", filter: (r) => r.term === null && r.disposition !== "schedule" },
    { title: "Skipped", note: "Already on your flowchart or excluded by you.", filter: (r) => r.disposition === "skip" },
  ];

  const actionable = rows.filter((r) => r.disposition !== "skip").length;

  return (
    <Dialog label="Import your schedule" onClose={onClose} style={{ maxWidth: 720 }}>
        <h2>Import your schedule</h2>
        <p className="desc">
          Upload a spreadsheet or paste text. Term labels (e.g. "Fall 2025") decide what happens:
          past terms are marked completed, upcoming terms are scheduled onto your flowchart.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv,.tsv,.txt"
          style={{ display: "none" }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try { ingest(extractSchedule(await fileToText(f))); }
            catch { setError("Could not read that file."); }
            e.target.value = "";
          }}
        />
        <div className="row">
          <button onClick={() => fileRef.current?.click()}>Upload spreadsheet</button>
        </div>
        <textarea
          rows={3}
          style={{ width: "100%", marginTop: 10 }}
          placeholder="…or paste your schedule text here"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
        />
        {pasteText.trim() && (
          <button style={{ marginTop: 6 }} onClick={() => { ingest(extractSchedule(pasteText)); setPasteText(""); }}>
            Extract from pasted text
          </button>
        )}
        {error && <p style={{ color: "var(--red)", fontSize: 12.5 }}>{error}</p>}

        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>AP credit or individual courses</div>
          <ApCreditPicker onAdd={(codes) => ingest(codes.map((code) => ({ code, term: null })))} />
          <div style={{ marginTop: 8 }}>
            <CourseSearchPicker onAdd={(code) => ingest([{ code, term: null }])} placeholder="Search a course you've taken…" />
          </div>
        </div>

        {groups.map(({ title, note, filter }) => {
          const g = rows.filter(filter);
          if (!g.length) return null;
          return (
            <div key={title} style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{title} <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 11.5 }}>· {note}</span></div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {g.map((r) => (
                  <span key={r.code} style={{ display: "inline-flex", gap: 4, alignItems: "center", border: "1px solid var(--line)", borderRadius: 8, padding: "4px 8px", fontSize: 12, background: r.disposition === "skip" ? "var(--surface-2)" : "var(--surface)" }}>
                    <b>{r.code}</b>
                    {r.term && <span style={{ color: "var(--muted)" }}>{r.term.season} {r.term.year}</span>}
                    {r.disposition === "schedule" && (
                      <select
                        value={r.targetSem}
                        onChange={(e) => setRows(rows.map((x) => (x.code === r.code ? { ...x, targetSem: Number(e.target.value) } : x)))}
                        style={{ fontSize: 11, padding: "1px 4px" }}
                      >
                        {labels.map((l, i) => <option key={i} value={i}>{l}</option>)}
                      </select>
                    )}
                    {r.disposition !== "completed" && <button style={{ fontSize: 10.5, padding: "1px 6px" }} onClick={() => setDisposition(r.code, "completed")}>done✓</button>}
                    {r.disposition !== "schedule" && <button style={{ fontSize: 10.5, padding: "1px 6px" }} onClick={() => setDisposition(r.code, "schedule")}>schedule</button>}
                    {r.disposition !== "skip" && <button style={{ fontSize: 10.5, padding: "1px 6px" }} onClick={() => setDisposition(r.code, "skip")}>✕</button>}
                  </span>
                ))}
              </div>
            </div>
          );
        })}

        <div className="row">
          <button className="primary" disabled={!actionable} onClick={() => void apply()}>
            Apply import ({actionable} courses)
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
    </Dialog>
  );
}
