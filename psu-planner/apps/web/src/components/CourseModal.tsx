/** Course / slot detail modal — port of the demo's openModal "does it fit"
 * analysis (L510+), driven by checkCourse leaves. Slot view suggests fills
 * from the program's requirement rules (FE/TE lists, patterns) or gen-ed
 * tags over the full catalog. */
import { useEffect, useMemo, useState } from "react";
import {
  GENED_BUCKETS, SAT, SUMMER_MAX_CREDITS, UNK, auditGenEd, checkCourse, codeMatchesPool,
  countableCourses, majorDeptPrefixes, parseTermLabel, rankGenEdPicks, resolveSlotPool, searchCatalog,
  type Catalog, type Course, type PlanItem, type ReqSection,
} from "@psu-planner/engine";
import { loadFullCatalog, loadProgramBySlug } from "../data/catalogClient";
import { usePlanner } from "../store";

const GENED_KEYS = new Set(GENED_BUCKETS.map((b) => b.key));

interface Suggestion { course: Course; bonuses: string[] }

function SlotSuggestions({ item, onFill }: { item: PlanItem; onFill: (code: string) => void }) {
  const { plan, items } = usePlanner();
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const full: Catalog = await loadFullCatalog();
      const inPlan = new Set(items.filter((i) => i.kind === "course").map((i) => i.code as string));
      const completed = new Set(Object.keys(plan?.completed ?? {}));
      const usable = (c: Course) =>
        !inPlan.has(c.code) && !completed.has(c.code) && c.level === "undergraduate";

      let picks: Suggestion[] = [];
      if (item.slot && GENED_KEYS.has(item.slot) && plan) {
        // Category-aware gen-ed picks: filtered to the slot's framework bucket,
        // own-department courses excluded (bulletin restriction), and courses
        // that also knock out an unmet US/IL overlay ranked to the top.
        const prefixes = majorDeptPrefixes(plan);
        const audit = auditGenEd(countableCourses(plan), full, prefixes);
        const bucket = GENED_BUCKETS.find((b) => b.key === item.slot)!;
        picks = rankGenEdPicks(full, item.slot, {
          majorPrefixes: prefixes,
          needUS: audit.us.remaining,
          needIL: audit.il.remaining,
          exclude: new Set([...inPlan, ...completed]),
          preferHonors: !!plan.honors,
        }).filter((p) => usable(p.course)).map((p) => ({ course: p.course, bonuses: p.bonuses }));
        const overlay = audit.il.remaining || audit.us.remaining
          ? " Courses topped with “also fulfills IL/US” cover two requirements at once — the efficient pick."
          : "";
        setNote(`${bucket.label} — qualifying courses:${overlay}`);
      } else if (item.slot === "GE") {
        // Legacy plans generated before category refinement.
        picks = Object.values(full).filter((c) => c.genEd.length > 0 && usable(c)).map((course) => ({ course, bonuses: [] }));
        setNote("Courses carrying any General Education attribute:");
      } else {
        // Elective slot: resolve the matching requirement rule for its program.
        const prog = item.slotProgram
          ? await loadProgramBySlug<{ requirementSections: ReqSection[] }>(item.slotProgram)
          : null;
        const pool = prog && item.slotLabel ? resolveSlotPool(item.slotLabel, prog.requirementSections) : null;
        if (pool && (pool.courses.size || pool.patterns.length)) {
          picks = Object.values(full).filter((c) => codeMatchesPool(c.code, pool) && usable(c)).map((course) => ({ course, bonuses: [] }));
          setNote(`From this requirement's approved list (${pool.courses.size || "pattern-based"} options):`);
        } else {
          picks = searchCatalog(full, item.slotLabel ?? "elective", 40).map((k) => full[k]).filter(usable).map((course) => ({ course, bonuses: [] }));
          setNote(`No published list for “${item.slotLabel ?? "this requirement"}” — talk to your adviser about what counts. You can still add a course once you've confirmed it:`);
        }
      }
      // Dedupe by code; gen-ed picks keep their double-count ranking, others
      // sort by course number.
      const seen = new Set<string>();
      picks = picks.filter((p) => (seen.has(p.course.code) ? false : (seen.add(p.course.code), true)));
      if (!(item.slot && GENED_KEYS.has(item.slot))) {
        picks.sort((a, b) => a.course.subject.localeCompare(b.course.subject) || a.course.number.localeCompare(b.course.number, undefined, { numeric: true }));
      }
      if (alive) setSuggestions(picks.slice(0, 60));
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  if (!suggestions) return <p className="desc">Loading suggestions from the catalog…</p>;
  if (!suggestions.length) return <p className="desc">No matching courses found — use the toolbar search to pick one manually.</p>;
  return (
    <>
      <p className="desc">{note}</p>
      <div style={{ maxHeight: "40vh", overflow: "auto" }}>
        {suggestions.map(({ course: s, bonuses }) => (
          <button
            key={s.code}
            style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 6 }}
            onClick={() => onFill(s.code)}
          >
            <b>{s.display}</b> · {s.credits}{s.genEd.length ? ` · ${s.genEd.join("/")}` : ""}
            {bonuses.map((b) => (
              <span key={b} style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 8, fontSize: 11, background: "var(--primary)", color: "var(--primary-fg)" }}>{b}</span>
            ))}
            {" — "}{s.title}
          </button>
        ))}
      </div>
    </>
  );
}

export function CourseModal({ item, onClose }: { item: PlanItem; onClose: () => void }) {
  const { plan, catalog, sched, mutatePlan, markCompleted, refreshCatalog, swapAlternative, removeItem } = usePlanner();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const c = item.code ? catalog[item.code] : undefined;
  const chk = useMemo(
    () => (item.kind === "course" && item.code ? checkCourse(catalog, item.code, item.sem, sched) : null),
    [item, catalog, sched],
  );

  if (!plan) return null;

  if (item.kind === "slot") {
    return (
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal" role="dialog" aria-modal="true" aria-label="Open slot details">
          <h2>{item.slot} — open slot</h2>
          <div className="sub">{item.slotLabel ?? "Requirement"} · {item.credits ?? "?"} credits</div>
          <SlotSuggestions
            item={item}
            onFill={(code) => {
              mutatePlan((p) => { p.slotFills[item.id] = code; });
              void refreshCatalog(); // chosen course's subject may not be loaded yet
              onClose();
            }}
          />
          <div className="row">
            <button
              onClick={() => {
                if (confirm("Remove this slot from your plan? It will stop counting toward credits (restorable from the toolbar).")) {
                  removeItem(item.id);
                  onClose();
                }
              }}
            >
              Remove from plan
            </button>
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  const done = !!plan.completed[item.code!];
  const overridden = !!plan.prereqOverrides?.[item.code!];
  const setOverride = (on: boolean) => mutatePlan((p) => {
    p.prereqOverrides = { ...(p.prereqOverrides ?? {}) };
    if (on) p.prereqOverrides[item.code!] = true; else delete p.prereqOverrides[item.code!];
  });
  const stCls = overridden ? "ok" : chk!.value === SAT ? "ok" : chk!.value === UNK ? "warn" : "bad";
  const stTxt = overridden
    ? "✓ Prerequisite override confirmed with your adviser."
    : chk!.value === SAT
      ? "✓ All prerequisites are satisfied by your plan."
      : chk!.value === UNK
        ? "⚠ Depends on requirements outside this plan — verify below."
        : "✗ Prerequisite problem in your plan.";

  const leaves = chk!.leaves;
  const seen = new Set<string>();

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Course details ${item.code ?? ""}`}>
        <h2>{c?.display ?? item.code}</h2>
        <div className="sub">{c?.title} · {c?.credits}</div>
        <div className={`status ${stCls}`}>{stTxt}</div>
        {leaves.length > 0 && (
          <ul style={{ fontSize: 12.5, color: "var(--muted)", paddingLeft: 18 }}>
            {leaves.map((l, i) => {
              const key = l.kind === "phrase" ? l.text : l.code;
              if (seen.has(key)) return null;
              seen.add(key);
              if (l.kind === "phrase") return <li key={i}>“{l.text}” — outside the catalog, verify manually</li>;
              if (l.kind === "external") return <li key={i}>{l.code} — not in your plan (assumed from transfer/AP? verify)</li>;
              if (l.sem < 0) return <li key={i}>{l.code} — already completed ✓</li>;
              return (
                <li key={i}>
                  {l.code} — in your plan, semester {l.sem + 1} {l.v === SAT ? "✓" : l.v === UNK ? "⚠" : "✗ too late"}
                  {l.concurrent ? " (may be concurrent)" : ""}
                </li>
              );
            })}
          </ul>
        )}
        {!done && overridden && (
          <div className="row" style={{ marginTop: 4 }}>
            <button onClick={() => setOverride(false)} title="Clear the adviser prerequisite override for this course">
              Remove prerequisite override
            </button>
          </div>
        )}
        {!done && !overridden && chk!.value !== SAT && (
          <div className="row" style={{ marginTop: 4 }}>
            <button
              onClick={() => {
                if (confirm(`Confirm a prerequisite override for ${item.code}?\n\nOnly do this if you have talked to your adviser and been cleared to take ${item.code} despite the prerequisite flag. The card will show as satisfied; it stays your responsibility to have the override on file.`)) {
                  setOverride(true);
                }
              }}
              title="Mark this course cleared after an adviser-approved prerequisite override"
            >
              I got a prerequisite override from my adviser
            </button>
          </div>
        )}
        {!c && (
          <div className="status warn">
            ⚠ The bulletin references this course but it isn't in the current university course catalog
            (possibly discontinued or renumbered). Verify with your adviser before planning around it.
          </div>
        )}
        {(item.alternatives?.length ?? 0) > 0 && (
          <>
            <p className="desc" style={{ marginTop: 10 }}><b>Also satisfiable by</b> (the bulletin allows either):</p>
            <div className="row">
              {item.alternatives!.map((alt) => (
                <button
                  key={alt}
                  onClick={() => { void swapAlternative(item.code!, alt); onClose(); }}
                  title={catalog[alt]?.title ?? ""}
                >
                  Switch to {catalog[alt]?.display ?? alt}
                </button>
              ))}
            </div>
          </>
        )}
        {c?.enforced && <div className="verbatim"><b>Enforced prerequisite:</b> {c.enforced}</div>}
        {c?.concurrent && <div className="verbatim"><b>Enforced concurrent:</b> {c.concurrent}</div>}
        {(plan.constraints ?? []).some((con) => con.code === item.code) && (
          <div className="status warn" style={{ marginTop: 8 }}>
            Scheduling constraints on this course:{" "}
            {(plan.constraints ?? []).filter((con) => con.code === item.code).map((con) => (
              <span key={`${con.type}-${con.termIndex}`} style={{ marginRight: 8 }}>
                {con.type === "not-in" ? "not in" : con.type === "not-before" ? "no earlier than" : "pinned to"}{" "}
                {plan.terms[con.termIndex]?.label ?? `term ${con.termIndex + 1}`}
                <button
                  style={{ marginLeft: 4, padding: "0 6px" }}
                  title="Remove this constraint"
                  onClick={() => mutatePlan((p) => {
                    p.constraints = (p.constraints ?? []).filter((x) => !(x.code === con.code && x.type === con.type && x.termIndex === con.termIndex));
                  })}
                >
                  ✕
                </button>
              </span>
            ))}
            <span style={{ display: "block", marginTop: 4 }}>Every optimization honors these — the course is scheduled around them.</span>
          </div>
        )}
        <p className="desc">{c?.description}</p>
        <div className="row">
          <button
            className="primary"
            onClick={() => { markCompleted(item.code!, !done); onClose(); }}
            title={done ? "Puts the course back on your chart" : "Removes the course from your future semesters"}
          >
            {done ? "Mark as not completed" : "Completed it ✓ (remove from schedule)"}
          </button>
          {!done && (
            <button
              title={`Adds a durable constraint (never scheduled in ${plan.terms[item.sem]?.label ?? "this term"}) and re-optimizes around it — nothing gets removed`}
              onClick={async () => {
                const code = item.code!;
                const sem = item.sem;
                mutatePlan((p) => {
                  p.constraints = (p.constraints ?? []).filter((x) => !(x.code === code && x.type === "not-in" && x.termIndex === sem));
                  p.constraints.push({ code, type: "not-in", termIndex: sem });
                });
                onClose();
                await usePlanner.getState().optimizeNow();
              }}
            >
              Can't take it this semester
            </button>
          )}
          {!done && (() => {
            // Offer the adjacent summer session: Spring Y -> Summer Y (right
            // after); Fall Y -> Summer Y (right before, valid when Spring Y is
            // on the plan) else Summer Y+1.
            const ref = parseTermLabel(plan.terms[item.sem]?.label ?? "");
            if (!ref || ref.kind === "Summer") return null;
            const year = ref.kind === "Spring" ? ref.year
              : plan.terms.some((t) => t.label === `Spring ${ref.year}`) ? ref.year : ref.year + 1;
            return (
              <button
                title={`Creates a Summer ${year} session (max ${SUMMER_MAX_CREDITS} credits) if needed, pins this course into it, and re-optimizes — summer capacity shortens the rest of the plan`}
                onClick={async () => {
                  const code = item.code!;
                  const s = usePlanner.getState();
                  const idx = s.addSummerSession(year);
                  if (idx < 0) return;
                  s.mutatePlan((p) => {
                    p.constraints = (p.constraints ?? []).filter((x) => !(x.code === code && x.type === "pin"));
                    p.constraints.push({ code, type: "pin", termIndex: idx });
                  });
                  onClose();
                  await s.optimizeNow();
                }}
              >
                Take it in Summer {year}
              </button>
            );
          })()}
          <button
            onClick={() => {
              if (item.added && !item.fromSlot) {
                mutatePlan((p) => {
                  p.added = p.added.filter((a) => "add-" + a.code !== item.id && a.code !== item.code);
                  delete p.moves[item.id];
                });
              } else if (item.fromSlot) {
                mutatePlan((p) => { delete p.slotFills[item.id]; }); // back to an open slot
              } else {
                // A course carried from a program template (has `origin`) is
                // required for the degree — warn plainly and point at the
                // "can't take it this semester" constraint, which keeps the
                // course and just reschedules it. Non-required courses get the
                // light confirm.
                const isRequired = plan.terms.some((t) =>
                  t.items.some((it2) => "code" in it2 && it2.code === item.code && it2.origin));
                const msg = isRequired
                  ? `⚠️ ${item.code} is part of your required degree curriculum. Removing it will leave your plan short of a graduation requirement — it stops counting toward your degree.\n\nIf this is only a timing conflict, cancel and use “Can't take it this semester” instead: that keeps the course and reschedules it.\n\nRemove ${item.code} anyway?`
                  : "Remove this course from your plan? It stops counting toward credits (restorable from the toolbar).";
                if (confirm(msg)) removeItem(item.id);
                else return;
              }
              onClose();
            }}
          >
            {item.fromSlot ? "Empty this slot" : "Remove from plan"}
          </button>
          {c && /^https:\/\/(bulletins\.)?psu\.edu\//.test(c.url ?? "") && (
            <a href={c.url} target="_blank" rel="noreferrer">
              <button>Open in PSU Bulletin ↗</button>
            </a>
          )}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
