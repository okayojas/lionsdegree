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

/** One AP exam a student says they took, and the score once they have
 * given it. No score, no credit: an exam is worth nothing until the score
 * says what. */
export interface ApChoice {
  exam: string;
  score: number | null;
}

/** What one exam and score come to, in Penn State's table. */
export interface ApOutcome {
  exam: string;
  score: number | null;
  /** The Courses it counts as. Empty where it earns none. */
  courses: string[];
  /** What to tell the student, in a sentence. */
  says: string;
}

const andList = (xs: string[]): string =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** What a list of AP exams and scores is worth: for each, the Courses it
 * counts as and a sentence saying so.
 *
 * PURE, and the table is handed in: the awards are the Edition's own
 * (`ap_credits.json`), and they change between bulletins. A Course two
 * exams both count for is listed under the first that gave it. */
export function apOutcomes(choices: readonly ApChoice[], table: readonly ApExam[]): ApOutcome[] {
  const given = new Set<string>();
  return choices.map(({ exam, score }) => {
    const row = table.find((x) => x.exam === exam);
    if (!row) return { exam, score, courses: [], says: "This exam is not in this bulletin's AP table." };
    if (score === null) return { exam, score, courses: [], says: "Choose your score." };
    const award = apAwardFor(row, score);
    if (!award || (!award.courses.length && !award.credits)) {
      return { exam, score, courses: [], says: `A ${score} earns no course credit at Penn State.` };
    }
    if (!award.courses.length) {
      return {
        exam, score, courses: [],
        says: `A ${score} earns ${award.credits} general credits, which count towards your total but not for a particular course.`,
      };
    }
    const courses = award.courses.filter((code) => !given.has(code));
    award.courses.forEach((code) => given.add(code));
    return { exam, score, courses, says: `Counts as ${andList(award.courses)}.` };
  });
}

/** The AP exams a student has taken, chosen from a list (setup, step 5).
 *
 * CHOSEN, NOT TYPED, AND NO "ADD" BUTTON. Pick an exam from the list and it
 * becomes a row; pick the score on the row and the Courses it counts for
 * are credited at once (the caller ticks them in the list of classes
 * below). The old picker made the student press a button after choosing,
 * and what it added appeared as a chip somewhere else, so it was easy to
 * choose an exam and credit nothing.
 *
 * Controlled: the caller holds the choices, because it has to forget them
 * when the Edition changes (the awards are the Edition's). */
export function ApExamList({
  choices,
  onChange,
}: {
  choices: ApChoice[];
  /** The choices as they now stand, and what each comes to. */
  onChange: (choices: ApChoice[], outcomes: ApOutcome[]) => void;
}) {
  const [table, setTable] = useState<ApExam[]>([]);
  useEffect(() => { void loadApCredits().then(setTable); }, []);

  const outcomes = apOutcomes(choices, table);
  const set = (next: ApChoice[]) => onChange(next, apOutcomes(next, table));
  const left = table.filter((x) => !choices.some((c) => c.exam === x.exam));

  return (
    <div className="ap-exams">
      <label className="ap-add">
        <span>{choices.length ? "Add another AP exam" : "AP exam"}</span>
        <select
          value=""
          disabled={!table.length}
          onChange={(e) => { if (e.target.value) set([...choices, { exam: e.target.value, score: null }]); }}
        >
          <option value="">{table.length ? "Choose an exam…" : "Loading the AP table…"}</option>
          {left.map((x) => <option key={x.exam} value={x.exam}>{x.exam}</option>)}
        </select>
      </label>
      {outcomes.length > 0 && (
        <ul className="ap-list">
          {outcomes.map((o, i) => (
            <li key={o.exam}>
              <b>AP {o.exam}</b>
              <select
                aria-label={`Your score on AP ${o.exam}`}
                value={o.score ?? ""}
                onChange={(e) => set(choices.map((c, j) => (j === i ? { ...c, score: e.target.value ? Number(e.target.value) : null } : c)))}
              >
                <option value="">Score…</option>
                {[5, 4, 3, 2, 1].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <span className="ap-says" role="status">{o.says}</span>
              <button type="button" aria-label={`Remove AP ${o.exam}`} onClick={() => set(choices.filter((_, j) => j !== i))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
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
