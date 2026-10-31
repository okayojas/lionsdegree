import { useEffect, useState } from "react";
import { progress, type Course, type PlanItem } from "@psu-planner/engine";
import { usePlanner, loadSavedPlan, getPlanHistory, type PlanHistoryEntry } from "./store";
import { loadCourse, loadIugIndex, type IugIndexEntry } from "./data/catalogClient";
import { downloadPlan, openPlanFile } from "./data/planFileIO";
import { Onboarding } from "./components/Onboarding";
import { PlanCanvas } from "./components/PlanCanvas";
import { Dialog } from "./components/Dialog";
import { CourseModal } from "./components/CourseModal";
import { SlotFillPicker } from "./components/SlotFillPicker";
import { SearchBox } from "./components/SearchBox";
import { SidePanel } from "./components/SidePanel";
import { ImportModal } from "./components/ImportModal";
import { PlanListView } from "./components/PlanListView";
import { LegalModal } from "./components/LegalModal";
import { AccountMenu } from "./components/AccountMenu";
import { PlanSkeleton } from "./components/PlanSkeleton";
import { chatConfigured } from "./chat/config";

export default function App() {
  const { plan, catalog, items, setPlan, mutatePlan, markCompleted, restoreItem, refreshCatalog, loading, loadError, servedEdition, repairNote, clearRepairNote } = usePlanner();
  const [showRemoved, setShowRemoved] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showLegal, setShowLegal] = useState(false);
  const [historyOpen, setHistoryOpen] = useState<PlanHistoryEntry[] | null>(null);
  const [iugOpen, setIugOpen] = useState<IugIndexEntry[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const s = localStorage.getItem("lionsdegree-theme");
    if (s === "dark" || s === "light") return s;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("lionsdegree-theme", next); } catch { /* ignore */ }
  };
  const [chatWidth, setChatWidth] = useState<number>(
    () => Number(localStorage.getItem("lionsdegree-chat-w")) || 360,
  );
  // Drag the divider between the plan and the advisor panel to resize it.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatWidth;
    let latest = startW;
    const onMove = (ev: PointerEvent) => {
      latest = Math.min(Math.max(280, startW + (startX - ev.clientX)), Math.round(window.innerWidth * 0.7));
      setChatWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      try { localStorage.setItem("lionsdegree-chat-w", String(latest)); } catch { /* ignore */ }
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const [view, setView] = useState<"canvas" | "list">(
    () => (localStorage.getItem("lionsdegree-view") === "list" ? "list" : "canvas"),
  );
  const switchView = (v: "canvas" | "list") => {
    setView(v);
    try { localStorage.setItem("lionsdegree-view", v); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!repairNote) return;
    setToast(repairNote);
    clearRepairNote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairNote]);
  const [booted, setBooted] = useState(false);
  const [openItem, setOpenItem] = useState<PlanItem | null>(null);
  const [pickedCourse, setPickedCourse] = useState<Course | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadSavedPlan();
    (saved ? setPlan(saved) : Promise.resolve()).finally(() => setBooted(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // A skeleton chart, not a centred sentence. The saved plan already knows
  // its terms and how many courses sit in each, so the grid can be on screen
  // immediately -- only the codes, titles and prerequisite arrows wait on the
  // catalog. `loadSavedPlan` rather than `plan` because on a cold start the
  // store has not been populated yet, and that first moment is exactly the
  // one this is for.
  if (!booted || loading) return <PlanSkeleton plan={plan ?? loadSavedPlan()} />;
  // A failed catalog fetch used to leave the spinner up forever. The plan is
  // still safe in local storage, so offer the retry rather than implying the
  // work is gone.
  if (loadError) {
    const saved = loadSavedPlan();
    return (
      <div className="loading" role="alert">
        <p>Couldn't load the course catalog for your plan.</p>
        <p className="muted">{loadError}</p>
        <p className="muted">Your plan is saved — this is a problem reaching the catalog, not with your plan.</p>
        <button type="button" onClick={() => { void setPlan(saved); }}>Try again</button>
      </div>
    );
  }
  if (!plan) return <Onboarding />;

  const { done, total } = progress(plan, items, catalog);
  const openFromSearch = (c: Course) => {
    const existing = items.find((i) => i.kind === "course" && i.code === c.code);
    if (existing) {
      setOpenItem(existing);
      return;
    }
    // Search results come from the search index, whose description is
    // shortened to what matching needs. This card shows a student prose about
    // one course, so read the full text from its subject file first.
    setPickedCourse(c);
    // Upgrading to the full description is a nicety; the card already shows
    // the search-index version. A failed subject fetch must not become an
    // unhandled rejection, so it just leaves the shorter text in place.
    void loadCourse(c.code)
      .then((fullCourse) => {
        if (fullCourse) setPickedCourse((cur) => (cur?.code === c.code ? fullCourse : cur));
      })
      .catch(() => {});
  };

  const addPicked = async (sem: number) => {
    const c = pickedCourse!;
    setPickedCourse(null);
    mutatePlan((p) => { p.added.push({ code: c.code, sem }); });
    await refreshCatalog();
    setToast(`Added ${c.display} to ${plan.terms[sem]?.label ?? "your plan"}.`);
  };

  const fillPickedSlot = async (slotId: string, label: string) => {
    const c = pickedCourse!;
    setPickedCourse(null);
    mutatePlan((p) => { p.slotFills[slotId] = c.code; });
    await refreshCatalog();
    setToast(`Filled your ${label} slot with ${c.display}.`);
  };

  const removedCount = Object.keys(plan.removed ?? {}).length;
  return (
    <div className="app">
      <a href="#main" className="skip-link">Skip to plan</a>
      <div className="toolbar" role="banner">
        {/* Menu first, in the same corner it occupies on the landing page
            and on every static page. It used to sit at the far right of a
            toolbar that wraps, which meant it moved as the window changed
            width -- the one control that should never have to be looked
            for. */}
        <div className="toolbar-menu-wrap">
          <button aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>Menu ▾</button>
          {menuOpen && (
            <div role="menu" className="toolbar-menu" onClick={() => setMenuOpen(false)}>
              <button
                role="menuitem"
                onClick={async () => {
                  if (confirm("Repack your schedule into the fewest terms (max 19 credits each)? Manual card positions reset.")) {
                    setToast(await usePlanner.getState().optimizeNow());
                  }
                }}
              >
                Optimize schedule
              </button>
              <button role="menuitem" onClick={() => setShowImport(true)}>Import courses / AP credit</button>
              <button role="menuitem" onClick={() => downloadPlan(plan)}>Save plan to a file</button>
              <button role="menuitem" onClick={() => void openPlanFile(setPlan, setToast)}>Open a plan file</button>
              <button
                role="menuitem"
                onClick={async () => {
                  const all = await loadIugIndex();
                  const mine = all.filter((e) => e.pairsWith.some((s) => plan.programs.includes(s)));
                  setIugOpen(mine);
                }}
              >
                {plan.iug ? "Master's degree (IUG)" : "Add a master's degree (IUG)"}
              </button>
              <button role="menuitem" onClick={() => setHistoryOpen(getPlanHistory().slice().reverse())}>
                Plan history
              </button>
              <button role="menuitem" disabled={removedCount === 0} onClick={() => setShowRemoved(true)}>
                Removed items ({removedCount})
              </button>
              <button role="menuitem" onClick={() => setShowLegal(true)}>Privacy · Terms · Accessibility</button>
              <button
                role="menuitem"
                onClick={() => {
                  if (confirm("Start over? This deletes your current plan on this device.")) void setPlan(null);
                }}
              >
                Start over
              </button>
            </div>
          )}
        </div>
        <h1><b>Lions</b>Degree</h1>
        <SearchBox onPick={openFromSearch} />
        {view === "canvas" && (
          <div className="legend" aria-hidden="true">
            <span className="lg"><span className="line" /> prerequisite</span>
            <span className="lg"><span className="line dash" /> may be concurrent</span>
            <span className="lg"><span className="line red" /> violated order</span>
          </div>
        )}
        <div className="spacer" />
        <div className="progress" role="status" aria-label="Degree progress">
          <span className="lbl">
            {String(done).replace(/\.0$/, "")} of {String(total).replace(/\.0$/, "")} credits completed
          </span>
          <div className="bar"><div className="fill" style={{ width: total ? `${(done / total) * 100}%` : 0 }} /></div>
        </div>
        <button onClick={() => switchView(view === "canvas" ? "list" : "canvas")} aria-pressed={view === "list"}>
          {view === "canvas" ? "List view" : "Flowchart view"}
        </button>
        <button
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
        <AccountMenu onToast={setToast} />
      </div>
      <div className="main-row" id="main" role="main">
        {view === "canvas" ? <PlanCanvas onOpenItem={setOpenItem} /> : <PlanListView onOpenItem={setOpenItem} />}
        <div
          className="panel-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={chatConfigured ? "Resize advisor panel" : "Resize side panel"}
          onPointerDown={startResize}
        />
        <SidePanel width={chatWidth} />
      </div>
      <footer className="app-disclaimer" role="contentinfo">
        {/* The edition is the first thing an adviser needs to know, because it
            decides which requirements apply at all. It lives beside the
            disclaimer rather than in the toolbar: a student looks here when
            they are checking what the plan is based on, and the toolbar is
            already two rows at desktop width. */}
        {plan.edition && (
          <>
            {servedEdition && servedEdition !== plan.edition ? (
              // The caveat has to live HERE, not only in onboarding. A student
              // who was told at setup that we lack their bulletin reloads the
              // page and the notice is gone, leaving a plan that silently
              // reads against a different one.
              <>
                Your plan is pinned to <strong>{plan.edition}</strong>, which we do not
                publish. Requirements shown are from{" "}
                <strong>{servedEdition}</strong>, the closest we have, so some will
                differ.{" "}
              </>
            ) : (
              <>
                Requirements from the <strong>{plan.edition}</strong> bulletin.{" "}
              </>
            )}
          </>
        )}
        Unofficial planning tool — <strong>not affiliated with or endorsed by Penn State</strong>. Course data
        from the public bulletin; always verify your plan with your academic adviser.
      </footer>
      {openItem && <CourseModal item={openItem} onClose={() => setOpenItem(null)} />}
      {pickedCourse && (
        <Dialog label="Course details" onClose={() => setPickedCourse(null)}>
            <h2>{pickedCourse.display}</h2>
            <div className="sub">{pickedCourse.title} · {pickedCourse.credits}</div>
            {pickedCourse.keywords?.length ? (
              <ul className="kw" aria-label={`What ${pickedCourse.code} covers`}>
                {pickedCourse.keywords.map((k) => <li key={k}>{k}</li>)}
              </ul>
            ) : null}
            {pickedCourse.url && (
              <p className="desc">
                <a href={pickedCourse.url} target="_blank" rel="noopener noreferrer">Full description in the Bulletin</a>
              </p>
            )}
            {pickedCourse.enforced && <div className="verbatim"><b>Enforced prerequisite:</b> {pickedCourse.enforced}</div>}
            {plan.completed[pickedCourse.code] ? (
              <>
                <div className="status ok">✓ You've completed this course. It counts toward prerequisites and progress.</div>
                <div className="row">
                  <button onClick={() => { markCompleted(pickedCourse.code, false); setPickedCourse(null); }}>
                    Mark as not completed (put back on chart)
                  </button>
                  <button onClick={() => setPickedCourse(null)}>Close</button>
                </div>
              </>
            ) : (
              <>
                <SlotFillPicker course={pickedCourse} onFill={(slotId, label) => void fillPickedSlot(slotId, label)} />
                <p className="desc" style={{ marginTop: 12 }}><b>Or add as an extra course — which term?</b></p>
                <div className="row">
                  {plan.terms.map((t, i) => (
                    <button key={i} onClick={() => void addPicked(i)}>{t.label}</button>
                  ))}
                </div>
                <div className="row"><button onClick={() => setPickedCourse(null)}>Cancel</button></div>
              </>
            )}
        </Dialog>
      )}
      {showRemoved && (
        <Dialog label="Removed from your plan" onClose={() => setShowRemoved(false)}>
            <h2>Removed from your plan</h2>
            <p className="desc">These don't count toward your credits. Restore anything you removed by mistake.</p>
            {Object.keys(plan.removed ?? {}).map((id) => {
              const c = catalog[id];
              return (
                <div key={id} className="row" style={{ alignItems: "center", marginTop: 8 }}>
                  <span style={{ flex: 1 }}>
                    <b>{c?.display ?? id}</b>{c ? ` — ${c.title}` : ""}
                  </span>
                  <button onClick={() => { restoreItem(id); if (Object.keys(plan.removed ?? {}).length <= 1) setShowRemoved(false); }}>
                    Restore
                  </button>
                </div>
              );
            })}
            <div className="row"><button onClick={() => setShowRemoved(false)}>Close</button></div>
        </Dialog>
      )}
      {iugOpen && (
        <Dialog label="Integrated master's degree" onClose={() => setIugOpen(null)}>
            <h2>Integrated Undergraduate-Graduate (IUG)</h2>
            <p className="desc">
              Earn a master's alongside your bachelor's in ~5 years, double-counting up to 15 credits
              (PSU GCAC-210). Not official advising — confirm the plan of study with the graduate adviser.
            </p>
            {plan.iug && (
              <div className="status ok" style={{ marginBottom: 10 }}>
                Attached: {iugOpen.find((e) => e.slug === plan.iug!.slug)?.gradDegree ?? plan.iug.slug}.
                <button
                  style={{ marginLeft: 10 }}
                  onClick={async () => { setIugOpen(null); setToast(await usePlanner.getState().detachIugNow()); }}
                >
                  Remove
                </button>
              </div>
            )}
            {iugOpen.length === 0 && <p className="desc">No IUG programs pair with your current major(s) in our catalog yet.</p>}
            <div style={{ maxHeight: "50vh", overflow: "auto" }}>
              {iugOpen.map((e) => (
                <div key={e.slug} className="row" style={{ alignItems: "center", marginTop: 8 }}>
                  <span style={{ flex: 1 }}>
                    <b>{e.gradDegree}</b>
                    <span style={{ color: "var(--muted)", display: "block", fontSize: 12 }}>{e.college} · {e.campus}</span>
                  </span>
                  <button
                    disabled={plan.iug?.slug === e.slug}
                    onClick={async () => {
                      setIugOpen(null);
                      setToast("Attaching master's degree…");
                      setToast(await usePlanner.getState().attachIugNow(e.slug));
                    }}
                  >
                    {plan.iug?.slug === e.slug ? "Attached" : "Add this master's"}
                  </button>
                </div>
              ))}
            </div>
            <div className="row"><button onClick={() => setIugOpen(null)}>Close</button></div>
        </Dialog>
      )}
      {historyOpen && (
        <Dialog label="Plan history" onClose={() => setHistoryOpen(null)}>
            <h2>Plan history</h2>
            <p className="desc">
              The last {historyOpen.length} saved versions of your plan (newest first) — restore any of them,
              including from before AI chat changes. Restoring saves your current plan to history first.
            </p>
            {historyOpen.length === 0 && <p className="desc">No history yet.</p>}
            <div style={{ maxHeight: "50vh", overflow: "auto" }}>
              {historyOpen.map((h, i) => (
                <div key={`${h.ts}-${i}`} className="row" style={{ alignItems: "center", marginTop: 8 }}>
                  <span style={{ flex: 1 }}>
                    <b>{new Date(h.ts).toLocaleString()}</b>
                    <span style={{ color: "var(--muted)", marginLeft: 8 }}>
                      {h.cause} · rev {h.rev} · {h.plan.terms.length} terms
                    </span>
                  </span>
                  <button
                    disabled={i === 0}
                    title={i === 0 ? "This is your current plan" : "Restore this version"}
                    onClick={async () => {
                      setHistoryOpen(null);
                      await setPlan(structuredClone(h.plan));
                      setToast(`Restored your plan from ${new Date(h.ts).toLocaleString()}.`);
                    }}
                  >
                    {i === 0 ? "Current" : "Restore"}
                  </button>
                </div>
              ))}
            </div>
            <div className="row"><button onClick={() => setHistoryOpen(null)}>Close</button></div>
        </Dialog>
      )}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onDone={(msg) => setToast(`Import: ${msg}.`)}
        />
      )}
      {showLegal && <LegalModal onClose={() => setShowLegal(false)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
