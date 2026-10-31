/** Shared pickers for prior credit: AP exam scores and a full-catalog course
 * search. Both emit course codes that join the "completed" set. */
import { useEffect, useRef, useState } from "react";
import { searchCatalog, type Catalog } from "@psu-planner/engine";
import { loadApCredits, loadSearchCatalog, type ApExam, searchRanking } from "../data/catalogClient";



/** Best award for a score: the highest minScore row not exceeding the score. */
export function apAwardFor(exam: ApExam, score: number) {
  return [...exam.awards].reverse().find((a) => score >= a.minScore) ?? null;
}

export function ApCreditPicker({ onAdd }: { onAdd: (codes: string[], label: string) => void }) {
  const [exams, setExams] = useState<ApExam[]>([]);
  const [examIx, setExamIx] = useState(-1);
  const [score, setScore] = useState(5);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => { void loadApCredits().then(setExams); }, []);

  const add = () => {
    const exam = exams[examIx];
    if (!exam) return;
    const award = apAwardFor(exam, score);
    if (!award || (award.credits === 0 && !award.courses.length)) {
      setNote(`Per Penn State's table, a ${score} on ${exam.exam} earns no course credit.`);
      return;
    }
    if (!award.courses.length) {
      setNote(`A ${score} on ${exam.exam} earns general credits (${award.raw.slice(0, 120)}…) — they count toward your total but not a specific course; add them with your adviser's guidance.`);
      return;
    }
    setNote(null);
    onAdd(award.courses, `AP ${exam.exam} (${score})`);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select aria-label="AP exam" value={examIx} onChange={(e) => { setExamIx(Number(e.target.value)); setNote(null); }}>
          <option value={-1}>AP exam…</option>
          {exams.map((x, i) => <option key={x.exam} value={i}>{x.exam}</option>)}
        </select>
        <select aria-label="AP exam score" value={score} onChange={(e) => setScore(Number(e.target.value))}>
          {[5, 4, 3, 2, 1].map((s) => <option key={s} value={s}>score {s}</option>)}
        </select>
        <button disabled={examIx < 0} onClick={add}>Add AP credit</button>
      </div>
      {examIx >= 0 && exams[examIx] && (
        <p style={{ fontSize: 11.5, color: "var(--muted)", margin: "6px 0 0" }}>
          {apAwardFor(exams[examIx], score)?.raw ?? "No award row for this score."}
        </p>
      )}
      {note && <p style={{ fontSize: 12, color: "var(--amber)", margin: "6px 0 0" }}>{note}</p>}
    </div>
  );
}

export function CourseSearchPicker({ onAdd, placeholder }: { onAdd: (code: string) => void; placeholder?: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const run = (query: string, cat: Catalog | null) => {
    setHits(cat && query.trim() ? searchCatalog(cat, query, 8, searchRanking()) : []);
  };

  return (
    <div>
      <input
        style={{ width: "100%" }}
        placeholder={placeholder ?? "Search any PSU course you've taken — code or title"}
        value={q}
        onFocus={() => { if (!catalog) void loadSearchCatalog().then((c) => { setCatalog(c); run(q, c); }); }}
        onChange={(e) => {
          setQ(e.target.value);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => run(e.target.value, catalog), 140);
        }}
      />
      {hits.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
          {hits.map((code) => {
            const c = catalog![code];
            return (
              <button key={code} style={{ textAlign: "left", fontSize: 12.5 }} onClick={() => { onAdd(code); setQ(""); setHits([]); }}>
                <b>{c.display}</b> · {c.credits}{c.genEd.length ? ` · ${c.genEd.join("/")}` : ""} — {c.title}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
