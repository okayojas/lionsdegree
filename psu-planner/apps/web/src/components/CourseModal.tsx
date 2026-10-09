/** Course / slot detail modal — port of the demo's openModal "does it fit"
 * analysis (L510+), driven by checkCourse leaves. Slot view suggests fills
 * from the program's requirement rules (FE/TE lists, patterns) or gen-ed
 * tags over the full catalog. */
import { useEffect, useMemo, useState } from "react";
import {
  GENED_BUCKETS, SAT, SUMMER_MAX_CREDITS, UNK, auditGenEd, checkCourse,
  countableCourses, majorDeptPrefixes, parseTermLabel, rankSlotPicks, resolveSlotPool,
  type Catalog, type PlanItem, type Pool, type ReqSection, type SlotSuggestions as SlotSuggestionsResult,
} from "@psu-planner/engine";
import { loadFullCatalog, loadProgramBySlug } from "../data/catalogClient";
import { usePlanner } from "../store";

const GENED_KEYS = new Set(GENED_BUCKETS.map((b) => b.key));

const BRANCH_CAMPUSES = new Set([
  "abington", "altoona", "behrend", "berks", "brandywine", "capital", "dubois", "fayette",
  "greater-allegheny", "harrisburg", "hazleton", "lehigh-valley", "mont-alto", "new-kensington",
  "schuylkill", "scranton", "shenango", "wilkes-barre", "york", "beaver", "great-valley",
]);
function campusOf(slug?: string): string {
  const first = slug?.split("-")[0];
  const two = slug?.split("-").slice(0, 2).join("-");
  if (two && BRANCH_CAMPUSES.has(two)) return two;
  if (first && BRANCH_CAMPUSES.has(first)) return first;
  return "university-park";
}

/** ONE path for every Slot.
 *
 * Gen-ed Slots and elective Slots used to branch here into separate rankings,
 * which meant two different ideas of what a good suggestion is and a blank
 * card whenever the elective branch found no list. The engine now answers
 * both from the Slot's Pool. */
function SlotSuggestions({ item, onFill }: { item: PlanItem; onFill: (code: string) => void }) {
  const { plan, items } = usePlanner();
  const [result, setResult] = useState<SlotSuggestionsResult | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const full: Catalog = await loadFullCatalog();
      if (!plan) return;
      const inPlan = new Set(items.filter((i) => i.kind === "course").map((i) => i.code as string));
      const completed = new Set(Object.keys(plan.completed ?? {}));
      const prefixes = majorDeptPrefixes(plan);
      const audit = auditGenEd(countableCourses(plan), full, prefixes);

      // A gen-ed Slot carries its domain on the item; an elective Slot names a
      // requirement in its program, which the engine resolves to a Pool.
      let pool: Pool | null = null;
      if (item.slot && GENED_KEYS.has(item.slot)) {
        pool = { kind: "genEd", domain: item.slot };
      } else if (item.slot === "GE") {
        // Plans generated before gen-ed categories were refined.
        pool = { kind: "genEd", domain: "GE" };
      } else if (item.slotProgram && item.slotLabel) {
        const prog = await loadProgramBySlug<{ requirementSections: ReqSection[] }>(item.slotProgram);
        pool = prog ? resolveSlotPool(item.slotLabel, prog.requirementSections) : null;
      }

      const ranked = rankSlotPicks(full, pool, {
        exclude: new Set([...inPlan, ...completed]),
        majorPrefixes: prefixes,
        needUS: audit.us.remaining,
        needIL: audit.il.remaining,
        preferHonors: !!plan.honors,
        sched: usePlanner.getState().sched,
        termIndex: item.sem,
        limit: 60,
        // Program slugs are campus-prefixed at the branches ("abington-…")
        // and college-prefixed at University Park, so the first segment
        // identifies the campus well enough to notice a mismatch.
        campus: campusOf(item.slotProgram),
      });
      if (alive) setResult(ranked);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  if (!result) return <p className="desc">Loading suggestions from the catalog…</p>;

  return (
    <>
      <p className="desc">{result.poolNote}</p>
      {result.picks.length > 0 && (
        <>
          <p className="desc slot-offerings">{result.offeringsNote}</p>
          <div className="slot-picks">
            {result.picks.map(({ course: s, ready, bonuses }) => (
              <button
                key={s.code}
                className="slot-pick"
                onClick={() => onFill(s.code)}
                aria-label={[
                  `${s.display}, ${s.title}, ${s.credits}`,
                  ready ? "prerequisites met" : null,
                  ...bonuses,
                ].filter(Boolean).join(". ")}
              >
                <span className="code" aria-hidden="true">{s.display}</span>
                <span className="slot-pick-title" aria-hidden="true">{s.title}</span>
                <span className="slot-pick-meta" aria-hidden="true">
                  {s.credits}
                  {/* Rendered from `ready`, never from position in the list:
                      styling whichever chip came first turned "also fulfills
                      IL" green on a course the student cannot yet take. */}
                  {ready && <span className="slot-pick-chip is-ready">prerequisites met</span>}
                  {bonuses.map((b) => (
                    <span key={b} className="slot-pick-chip">{b}</span>
                  ))}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {result.provenance.readFrom && (
        <p className="desc slot-provenance">
          Read from{" "}
          <a href={result.provenance.readFrom.url} target="_blank" rel="noreferrer noopener">
            the department's list
          </a>{" "}
          on {result.provenance.readFrom.fetchedAt}.{" "}
          {result.provenance.humanChecked
            ? "Checked by a person against that page."
            : "Parsed automatically — confirm anything surprising."}
        </p>
      )}
      {result.provenance.campusCaveat && (
        <p className="desc slot-caveat" role="note">{result.provenance.campusCaveat}</p>
      )}
      {result.picks.length === 0 && (
        <p className="desc">
          {result.searchHint ? (
            <>
              Nothing to list here, but the requirement names a topic. Search the catalog for{" "}
              <b>{result.searchHint}</b>, then add a course once your adviser confirms it counts.
            </>
          ) : (
            <>Use the toolbar search to add a course once you've confirmed it counts.</>
          )}
        </p>
      )}
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
