/** Onboarding wizard: pick program(s) -> campus plan -> check off every
 * course from the major's track you've already taken (works for
 * major-switchers) -> AP / transfer / other credit -> generate. */
import { useEffect, useMemo, useRef, useState } from "react";
import { generatePlan, type ProgramTemplate, type ReqSection } from "@psu-planner/engine";
import { currentEdition, loadCoverage, loadEditions, loadProgram, loadProgramsIndex, loadSubject } from "../data/catalogClient";
import type { ProgramIndexEntry } from "../data/catalogClient";
import { extractCodesFromFile, extractCodesFromText } from "../data/importSchedule";
import { ApCreditPicker, CourseSearchPicker } from "./CreditPickers";
import { LegalModal } from "./LegalModal";
import { usePlanner } from "../store";

/** Next semester by calendar: Jan–Jul -> Fall same year; Aug–Dec -> Spring next year. */
function defaultStartTerm(): { term: "Fall" | "Spring"; year: number } {
  const now = new Date();
  const m = now.getMonth(); // 0-based
  return m <= 6 ? { term: "Fall", year: now.getFullYear() } : { term: "Spring", year: now.getFullYear() + 1 };
}

interface PipelineProgram {
  slug: string;
  name: string;
  type: string;
  requirementSections: ReqSection[];
  suggestedPlans: {
    campusLabel: string;
    semesters: ProgramTemplate["semesters"];
  }[];
}

export function Onboarding() {
  const setPlan = usePlanner((s) => s.setPlan);
  const [index, setIndex] = useState<ProgramIndexEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ProgramIndexEntry[]>([]);
  const [loaded, setLoaded] = useState<PipelineProgram[]>([]);
  const [campusChoice, setCampusChoice] = useState<Record<string, number>>({});
  const [startTerm, setStartTerm] = useState<"Fall" | "Spring">(defaultStartTerm().term);
  const [startYear, setStartYear] = useState(defaultStartTerm().year);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [extraCredits, setExtraCredits] = useState<{ code: string; source: string }[]>([]);
  const [imported, setImported] = useState<string[]>([]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [legal, setLegal] = useState(false);
  /** Schreyer Honors College admit cohort (null = not a Scholar). */
  const [honors, setHonors] = useState<1 | 2 | 3 | null>(null);

  useEffect(() => {
    loadProgramsIndex().then(setIndex).catch(() => setError("Could not load the program index — is the catalog data deployed?"));
  }, []);

  const matches = useMemo(() => {
    if (!index) return [];
    const q = query.toLowerCase().trim();
    const majors = index.filter((p) => p.type === "major" && p.hasPlans);
    const minors = index.filter((p) => p.type === "minor");
    const certs = index.filter((p) => p.type === "certificate");
    const pool = [...majors, ...minors, ...certs];
    if (!q) return majors.slice(0, 30);
    return pool.filter((p) => p.name.toLowerCase().includes(q) || p.slug.includes(q)).slice(0, 30);
  }, [index, query]);

  const togglePick = async (p: ProgramIndexEntry) => {
    setError(null);
    if (picked.some((x) => x.slug === p.slug)) {
      setPicked(picked.filter((x) => x.slug !== p.slug));
      setLoaded(loaded.filter((x) => x.slug !== p.slug));
      return;
    }
    setPicked([...picked, p]);
    try {
      const prog = await loadProgram<PipelineProgram>(
        p.type === "minor" ? "minors" : p.type === "certificate" ? "certificates" : "majors",
        p.slug,
      );
      setLoaded((cur) => [...cur, prog]);
    } catch {
      setError(`Could not load ${p.name}.`);
      setPicked((cur) => cur.filter((x) => x.slug !== p.slug));
    }
  };

  /** The full track: every course in the selected majors' suggested plans,
   * grouped by template semester — the student checks off what they've taken,
   * which works even if those courses came from a different major. */
  const track = useMemo(() => {
    const groups: { label: string; entries: { code: string; alternatives: string[] }[] }[] = [];
    const seen = new Set<string>();
    for (const prog of loaded) {
      const plan = (prog.suggestedPlans ?? [])[campusChoice[prog.slug] ?? 0];
      if (!plan) continue;
      plan.semesters.forEach((sem, si) => {
        const entries: { code: string; alternatives: string[] }[] = [];
        for (const e of sem.entries) {
          if (e.type === "course" && e.code && !seen.has(e.code)) {
            seen.add(e.code);
            entries.push({ code: e.code, alternatives: e.alternatives ?? [] });
          }
        }
        if (!entries.length) return;
        const label = loaded.length > 1 ? `${prog.name.split(",")[0]} · ${sem.label}` : sem.label;
        groups.push({ label: label || `Semester ${si + 1}`, entries });
      });
    }
    return groups;
  }, [loaded, campusChoice]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      // Programs with a plan grid contribute semesters; minors/certificates
      // without one still contribute their requirements (overlap-checked
      // against the majors, shortfall becomes labeled slots).
      const templates: ProgramTemplate[] = loaded.map((p) => {
        const plan = (p.suggestedPlans ?? [])[campusChoice[p.slug] ?? 0];
        return {
          slug: p.slug,
          name: p.name,
          campusLabel: plan?.campusLabel ?? "",
          semesters: plan?.semesters ?? [],
          requirements: p.requirementSections ?? [],
        };
      });
      if (!templates.some((t) => t.semesters.length > 0)) {
        setError("None of the selected programs has a suggested academic plan — pick at least one major.");
        setBusy(false);
        return;
      }
      const allCompleted = [...new Set([...completed, ...extraCredits.map((x) => x.code), ...imported])];
      // Gen-ed tags for the completed set (so a done GHW course consumes a
      // GHW slot) — load just the subjects those codes live in.
      const genEdTags: Record<string, string[]> = {};
      const prefixes = new Set(allCompleted.map((c) => c.split(" ")[0]));
      for (const p of prefixes) {
        for (const c of await loadSubject(p)) {
          if (allCompleted.includes(c.code) && c.genEd.length) genEdTags[c.code] = c.genEd;
        }
      }
      const plan = generatePlan(templates, {
        startTerm: { term: startTerm, year: startYear },
        completedCourses: allCompleted,
        genEdTags,
        coveredBy: await loadCoverage(),
      }, `plan-${Date.now()}`);
      // Pin the bulletin edition this plan was generated against. Requirements
      // are governed by the edition in force when the student entered their
      // major, so the plan carries it rather than tracking whatever is newest
      // (docs/adr/0001-forward-only-catalog-editions.md).
      plan.edition = currentEdition() ?? (await loadEditions()).latest;
      // Schreyer scholars get honors-section upgrades + per-year credit audit
      // (applied by the store's plan pipeline).
      if (honors) plan.honors = { admit: honors };
      await setPlan(plan, { repairOrdering: true, optimize: true });
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="onboard">
      <header className="onboard-hero">
        <div className="eyebrow">Unofficial · Penn State degree planner</div>
        <h1>Chart your degree<br />like a route map.</h1>
        <p className="lede">
          Every prerequisite is a connection, every semester a stop. Pick your major, minor, or certificate and
          LionsDegree plots a valid, optimized path to graduation. Always confirm with your adviser and the{" "}
          <a href="https://bulletins.psu.edu" target="_blank" rel="noreferrer">University Bulletin</a> — this tool
          is <strong>not affiliated with or endorsed by Penn State</strong>.
        </p>
        <svg className="route-hero" viewBox="0 0 680 140" role="img" aria-label="Two course routes converging into one degree plan">
          <path className="route-line rl-a" d="M24 52 H656" />
          <path className="route-line rl-b" d="M24 96 H300 C356 96 356 52 412 52 H656" />
          <circle className="route-stop s1" cx="24" cy="52" r="7" />
          <circle className="route-stop s2" cx="24" cy="96" r="7" />
          <circle className="route-stop s3" cx="200" cy="52" r="7" />
          <circle className="route-stop s4" cx="300" cy="96" r="7" />
          <circle className="route-stop s5" cx="412" cy="52" r="7" />
          <circle className="route-stop s6" cx="600" cy="52" r="7" />
        </svg>
      </header>

      <div className="step">
        <h3>1 · Your major(s) and minor(s)</h3>
        <input
          placeholder="Search majors and minors — e.g. Computer Science"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: "100%" }}
        />
        <div className="prog-list">
          {!index && !error && <div style={{ color: "var(--muted)" }}>Loading programs…</div>}
          {matches.map((p) => (
            <button
              key={p.slug}
              className={`prog-item${picked.some((x) => x.slug === p.slug) ? " picked" : ""}`}
              onClick={() => togglePick(p)}
            >
              {p.name}
              <span className="meta">
                {p.type}{p.college ? ` · ${p.college}` : ""}{p.campuses.length ? ` · ${p.campuses.slice(0, 3).join(", ")}${p.campuses.length > 3 ? "…" : ""}` : ""}
              </span>
            </button>
          ))}
        </div>
        {picked.length > 0 && (
          <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Selected: {picked.map((p) => p.name).join(" + ")}</p>
        )}
      </div>

      {loaded.some((p) => (p.suggestedPlans ?? []).length > 1) && (
        <div className="step">
          <h3>2 · Campus plan</h3>
          {loaded.filter((p) => (p.suggestedPlans ?? []).length > 1).map((p) => (
            <div key={p.slug} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12.5, marginBottom: 4 }}>{p.name}</div>
              <select
                aria-label={`Campus plan for ${p.name}`}
                value={campusChoice[p.slug] ?? 0}
                onChange={(e) => setCampusChoice({ ...campusChoice, [p.slug]: Number(e.target.value) })}
              >
                {p.suggestedPlans.map((sp, i) => (
                  <option key={i} value={i}>{sp.campusLabel || `Plan ${i + 1}`}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      <div className="step">
        <h3>3 · Which of these have you already taken?</h3>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
          <label>Your next semester{" "}
            <select value={startTerm} onChange={(e) => setStartTerm(e.target.value as "Fall" | "Spring")}>
              <option>Fall</option>
              <option>Spring</option>
            </select>
          </label>
          <input
            type="number"
            aria-label="Starting year"
            value={startYear}
            onChange={(e) => setStartYear(Number(e.target.value))}
            style={{ width: 90 }}
          />
        </div>
        {track.length === 0 && <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Pick a major above to see its course track.</p>}
        {track.length > 0 && (
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 8px" }}>
            Check every course you've completed — no matter which major you took it under.
            Anything unchecked stays on your schedule; fully-completed semesters disappear automatically.
          </p>
        )}
        {track.map((group) => {
          // A group is "all checked" when every entry is satisfied by its
          // default code OR any of its same-credit alternatives.
          const entryDone = (e: { code: string; alternatives: string[] }) =>
            completed.has(e.code) || e.alternatives.some((a) => completed.has(a));
          const allChecked = group.entries.every(entryDone);
          const toggle = (code: string, on: boolean) => {
            const next = new Set(completed);
            if (on) next.add(code);
            else next.delete(code);
            setCompleted(next);
          };
          return (
            <div key={group.label} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                {group.label}{" "}
                <button
                  style={{ fontSize: 10.5, padding: "1px 8px" }}
                  onClick={() => {
                    const next = new Set(completed);
                    for (const e of group.entries) {
                      if (allChecked) { next.delete(e.code); e.alternatives.forEach((a) => next.delete(a)); }
                      else if (!entryDone(e)) next.add(e.code);
                    }
                    setCompleted(next);
                  }}
                >
                  {allChecked ? "clear" : "all"}
                </button>
              </div>
              <div className="grid">
                {group.entries.map((e) => (
                  <span key={e.code} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={completed.has(e.code)}
                        onChange={(ev) => toggle(e.code, ev.target.checked)}
                      />
                      {e.code}
                    </label>
                    {e.alternatives.map((alt) => (
                      <label className="check" key={alt} title={`same-credit alternative to ${e.code}`} style={{ borderStyle: "dashed" }}>
                        <input
                          type="checkbox"
                          checked={completed.has(alt)}
                          onChange={(ev) => toggle(alt, ev.target.checked)}
                        />
                        or {alt.replace(/^\S+ /, e.code.split(" ")[0] === alt.split(" ")[0] ? "" : alt.split(" ")[0] + " ")}
                      </label>
                    ))}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="step">
        <h3>4 · AP credit & other courses you've taken</h3>
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 8px" }}>
          These count toward prerequisites, gen eds, and electives automatically.
        </p>
        <ApCreditPicker onAdd={(codes, label) => {
          setExtraCredits((cur) => [...cur, ...codes.filter((c) => !cur.some((x) => x.code === c)).map((code) => ({ code, source: label }))]);
        }} />
        <div style={{ marginTop: 10 }}>
          <CourseSearchPicker onAdd={(code) => {
            setExtraCredits((cur) => (cur.some((x) => x.code === code) ? cur : [...cur, { code, source: "search" }]));
          }} />
        </div>
        {extraCredits.length > 0 && (
          <div className="grid" style={{ marginTop: 8 }}>
            {extraCredits.map((x) => (
              <label className="check" key={x.code} title={`${x.source} — click to remove`} onClick={() => setExtraCredits(extraCredits.filter((y) => y.code !== x.code))}>
                ✓ {x.code} <span style={{ color: "var(--muted)", fontSize: 10.5 }}>({x.source})</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="step">
        <h3>5 · Already have a schedule? (optional)</h3>
        <div className="import-zone">
          Upload your existing plan or transcript export — Excel, CSV, or plain text. Every PSU course
          code found in it is marked as completed.
          <div style={{ marginTop: 10, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,.tsv,.txt"
              style={{ display: "none" }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  const codes = await extractCodesFromFile(f);
                  setImported((cur) => [...new Set([...cur, ...codes])]);
                  if (!codes.length) setError("No course codes found in that file.");
                } catch { setError("Could not read that file."); }
                e.target.value = "";
              }}
            />
            <button onClick={() => fileRef.current?.click()}>Upload spreadsheet</button>
            <button onClick={() => setPasteOpen(!pasteOpen)}>{pasteOpen ? "Hide paste box" : "Paste text instead"}</button>
          </div>
        </div>
        {pasteOpen && (
          <div style={{ marginTop: 10 }}>
            <textarea
              rows={4}
              style={{ width: "100%" }}
              placeholder="Paste your schedule or transcript here…"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <button
              style={{ marginTop: 6 }}
              onClick={() => {
                const codes = extractCodesFromText(pasteText);
                setImported((cur) => [...new Set([...cur, ...codes])]);
                setPasteText("");
                if (!codes.length) setError("No course codes found in the pasted text.");
              }}
            >
              Extract courses from pasted text
            </button>
          </div>
        )}
        {imported.length > 0 && (
          <>
            <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "12px 0 6px" }}>
              {imported.length} completed courses imported — click any that don't belong to remove them:
            </p>
            <div className="grid">
              {imported.map((code) => (
                <label className="check" key={code} onClick={() => setImported(imported.filter((c) => c !== code))} title="Click to remove">
                  ✓ {code}
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="step">
        <h3>6 · Schreyer Honors College (optional)</h3>
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 8px" }}>
          Scholars get honors sections scheduled automatically (MATH 140H, ENGL/CAS 137H–138T, …) so the
          per-year honors-credit requirement is met. Pick when you were admitted:
        </p>
        <div className="grid">
          {([
            [null, "Not in Schreyer"],
            [1, "Admitted as a first-year (21 cr yrs 1–2 + 14 cr yrs 3–4)"],
            [2, "Gateway: second-year admit (9 cr yr 2 + 14 cr yrs 3–4)"],
            [3, "Gateway: third-year admit (14 cr yrs 3–4)"],
          ] as const).map(([val, label]) => (
            <label className="check" key={String(val)} style={honors === val ? { outline: "2px solid var(--blue)" } : undefined}>
              <input
                type="radio"
                name="schreyer"
                checked={honors === val}
                onChange={() => setHonors(val)}
                style={{ marginRight: 6 }}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {error && <p style={{ color: "var(--red)" }}>{error}</p>}
      <button className="primary" disabled={busy || picked.length === 0} onClick={generate} style={{ fontSize: 15, padding: "10px 22px" }}>
        {busy ? "Building your flowchart…" : "Build my flowchart →"}
      </button>
      <p style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 18 }}>
        <button style={{ border: "none", background: "none", padding: 0, textDecoration: "underline", color: "var(--muted)", fontWeight: 400 }} onClick={() => setLegal(true)}>
          Privacy · Terms · Accessibility
        </button>
      </p>
      {legal && <LegalModal onClose={() => setLegal(false)} />}
    </div>
  );
}
