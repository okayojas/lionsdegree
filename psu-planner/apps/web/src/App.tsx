import { useEffect, useRef, useState } from "react";
import { progress, type Course, type PlanItem } from "@psu-planner/engine";
import { usePlanner, loadSavedPlan, getPlanHistory, storedPlan, type PlanHistoryEntry } from "./store";
import { conflictMessage, flushPush, pullNewerPlan, setConflictListener, startOver } from "./data/sync";
import { loadCourse, loadIugIndex, type IugIndexEntry } from "./data/catalogClient";
import { downloadPlan, openPlanFile } from "./data/planFileIO";
import { Onboarding } from "./components/Onboarding";
import { SiteHead } from "./components/SiteHead";
import { SITE_NAV } from "./site/header";
import { followProgramLink, withoutProgramLink } from "./data/programLinkWhatIf";
import { countPlan } from "./data/planCount";
import { Tour } from "./components/Tour";
import { markTourSeen, tourSeen, tourSteps } from "./data/tour";
import { currentUser, syncConfigured } from "./data/sync";
import { PlanCanvas } from "./components/PlanCanvas";
import { Dialog } from "./components/Dialog";
import { CourseModal } from "./components/CourseModal";
import { SlotFillPicker } from "./components/SlotFillPicker";
import { SearchBox } from "./components/SearchBox";
import { SidePanel } from "./components/SidePanel";
import { ImportModal } from "./components/ImportModal";
import { PlanListView } from "./components/PlanListView";
import { ProgramsModal } from "./components/ProgramsModal";
import { LegalModal } from "./components/LegalModal";
import { AccountMenu } from "./components/AccountMenu";
import { KeepPlanBar } from "./components/KeepPlanBar";
import { wantsSignIn } from "./data/deepLink";
import { PlanSkeleton } from "./components/PlanSkeleton";
import { CandidateRail } from "./components/CandidateRail";
import { chatConfigured } from "./chat/config";

/** Where "the side panel is put away" is remembered. Anything but "closed"
 * reads as open, so a device that has never set it starts with the panel
 * showing. */
const SIDE_PANEL_KEY = "lionsdegree-side-panel";

export default function App() {
  const { plan, catalog, items, setPlan, markCompleted, restoreItem, loading, loadError, servedEdition, repairNote, clearRepairNote } = usePlanner();
  const [showRemoved, setShowRemoved] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showPrograms, setShowPrograms] = useState(false);
  /** The Program the dialog should open on changing, from the button beside its name. */
  const [changingProgram, setChangingProgram] = useState<string | null>(null);
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
  // WHETHER THE SIDE PANEL IS PUT AWAY. Held here rather than in the panel
  // because the divider beside it is this component's, and a divider with
  // nothing to resize has to go when the panel does. Remembered on the
  // device like the view and the panel's width: it is a preference about
  // this screen, not a fact about the plan, so it is not synced.
  const [panelOpen, setPanelOpen] = useState<boolean>(
    () => localStorage.getItem(SIDE_PANEL_KEY) !== "closed",
  );
  const togglePanel = () => {
    const next = !panelOpen;
    setPanelOpen(next);
    try { localStorage.setItem(SIDE_PANEL_KEY, next ? "open" : "closed"); } catch { /* ignore */ }
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

  /* ── A save that was refused ──────────────────────────────────────────
     NOT a toast. A toast dismisses itself after 3.5 seconds, which is
     right for "added MATH 141" and wrong for "your last edit did not
     save": the student has to decide something, and a message that
     disappears while they are reading it leaves them working against a
     copy that has quietly stopped saving. This stays until they act. */
  // A boolean. It held the refused PlanDoc, which nothing read — the
  // banner shows one fixed message and the recovery path re-reads from
  // storage. Carrying the document implied a use that did not exist.
  const [conflict, setConflict] = useState(false);

  /* ── Counted, once, anonymously (#70) ──────────────────────────────
     AFTER the Plan is on screen and NOT WAITED FOR: nothing about a
     Plan may depend on a count. What is sent, and why only from the
     site itself, is in data/planCount.ts. By the Plan's id and not the
     plan in view: a what-if is the same Plan. */
  const planId = plan?.id;
  const planEdition = plan?.edition;
  useEffect(() => {
    // Not while it is loading, and not where it failed to load: a Plan the
    // student is looking at an error instead of has not been opened.
    if (!planId || loading || loadError) return;
    void countPlan({ id: planId, edition: planEdition });
  }, [planId, planEdition, loading, loadError]);

  /* ── A link to a Program, with a Plan already saved (#69) ──────────
     Onboarding reads `?programs=` for a student with no Plan. One who
     has a Plan used to get it back with no word about the link. Now the
     Program opens as a what-if, a copy of their Plan with it in, and the
     Plan is not touched.

     ONLY WHERE THE PLAN WAS ALREADY THERE when the page opened: a plan
     onboarding has just generated FROM this link has the Program in it,
     and following the link again would be noise. Once, and the link is
     taken out of the address so a reload does not follow it again. */
  /* ── The first-run tour (#71) ───────────────────────────────────────
     Once per browser, the first time a plan is on screen and loaded;
     never over setup, and not while a dialog or a what-if link is
     being dealt with. Again from Menu → Take the tour. */
  const [tour, setTour] = useState<ReturnType<typeof tourSteps> | null>(null);
  const startTour = async () => {
    const user = syncConfigured ? await currentUser().catch(() => null) : null;
    setTour(tourSteps({ accounts: syncConfigured, signedIn: !!user }));
  };
  const tourOffered = useRef(false);
  useEffect(() => {
    if (!plan || loading || loadError || tourOffered.current) return;
    tourOffered.current = true;
    if (tourSeen()) return;
    // A moment after the chart is drawn, so the controls it points at
    // are where they will stay.
    const t = window.setTimeout(() => void startTour(), 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, loading, loadError]);

  const hadPlanOnArrival = useRef(loadSavedPlan() !== null);
  const linkFollowed = useRef(false);
  useEffect(() => {
    if (!plan || loading || linkFollowed.current || !hadPlanOnArrival.current) return;
    linkFollowed.current = true;
    void followProgramLink(window.location.search)
      .then((said) => {
        if (said === null) return;
        setToast(said);
        window.history.replaceState(null, "", withoutProgramLink(new URL(window.location.href)));
      })
      .catch(() => setToast("That link could not be followed: the program list did not load. Your plan is untouched."));
  }, [plan, loading]);
  useEffect(() => {
    setConflictListener(() => setConflict(true));
    return () => setConflictListener(null);
  }, []);

  /* The debounce is 2.5s, which is most of the gap between a student's
     last edit and switching away from the tab. Flushing on hide means the
     server holds the edit they just made rather than the one before it --
     and that a conflict surfaces while they still remember causing it. */
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flushPush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

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
  // THE ACCOUNT CONTROL EXISTS BEFORE A PLAN DOES.
  //
  // It used to live only in the planner's toolbar, which only renders once
  // a plan exists on THIS device — so a student who built a plan on their
  // laptop and opened the site on their phone was shown the onboarding form
  // with no way to sign in anywhere on the page. The one thing that would
  // have got their plan back was the one thing the screen did not offer.
  //
  // Nothing else from the toolbar comes with it: a student who has not
  // built a plan has nothing to view, optimize or export.
  if (!plan) {
    return (
      <>
        {/* The same top as every other page, so the way to the rest of
            the site is where it always is. Not a banner here: the
            planner's banner is its toolbar's, and the browser tests
            wait for that one to know the chart is up. */}
        <SiteHead />
        <div className="onboard-account">
          <AccountMenu onToast={setToast} openOnMount={wantsSignIn(window.location.search)} />
        </div>
        <Onboarding />
      </>
    );
  }

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

  /* THROUGH THE STORE, WHICH EDITS THE PLAN IN VIEW (#69): the student's
     Plan, or the what-if they have open. It hands back the sentence to
     show either way. */
  const addPicked = async (sem: number) => {
    const c = pickedCourse!;
    setPickedCourse(null);
    setToast(await usePlanner.getState().addCourseAt(c.code, sem));
  };

  const fillPickedSlot = async (slotId: string, label: string) => {
    const c = pickedCourse!;
    setPickedCourse(null);
    setToast(await usePlanner.getState().fillSlotWith(slotId, c.code, label));
  };

  const removedCount = Object.keys(plan.removed ?? {}).length;
  return (
    <div className="app">
      <a href="#main" className="skip-link">Skip to plan</a>
      {/* ONE BANNER, TWO ROWS. The site's header, the same as on every
          other page (the owner asked for it, 2026-11-16), and under it
          the planner's own tools. The brand in the first row is the way
          home and the page's heading, as the toolbar's wordmark was. */}
      <div className="app-head" role="banner">
      <SiteHead heading />
      <div className="toolbar">
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
          {/* Two spellings of one number, because a phone cannot fit the
              sentence: at 412px "7 of 128 credits completed" wrapped onto
              four lines and ran into the next control. CSS cannot split a
              text node, so the short form is markup.
              NOT aria-hidden, and the long form is never `display: none` --
              only visually hidden on narrow screens. This is a live region:
              what a screen reader announces when the number changes is the
              CONTENT, so removing the sentence from the content would leave
              it reading out "7/128 cr". The wrapper keeps "Degree progress"
              as its name; the sentence stays in the content for everyone. */}
          <span className="lbl">
            <span className="lbl-long">
              {String(done).replace(/\.0$/, "")} of {String(total).replace(/\.0$/, "")} credits completed
            </span>
            <span className="lbl-short">
              {String(done).replace(/\.0$/, "")}/{String(total).replace(/\.0$/, "")} cr
            </span>
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
        {/* Menu on the trailing edge, next to the account control --
            the same corner the landing page and the static pages put
            it. One position across every surface is the point. */}
        <div className="toolbar-menu-wrap" data-tour="menu">
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
              {/* Adding a minor used to mean "Start over", which deletes the
                  plan. This is the same engine call the assistant will make,
                  so the two can never disagree about what a plan is. */}
              <button role="menuitem" onClick={() => setShowPrograms(true)}>
                Your programs ({plan.programs.length})
              </button>
              <button role="menuitem" onClick={() => setShowImport(true)}>Import courses / AP credit</button>
              <button role="menuitem" onClick={() => { const whole = storedPlan(); if (whole) downloadPlan(whole); }}>Save plan to a file</button>
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
              <button role="menuitem" onClick={() => void startTour()}>Take the tour</button>
              <button role="menuitem" onClick={() => setShowLegal(true)}>Privacy · Terms · Accessibility</button>
              {/* The site's other pages. On a phone the header has no row of
                  its own for them (styles.css says why), so they are here;
                  on anything wider they are in the header and these are
                  not shown. The same list either way. */}
              {SITE_NAV.filter(({ href }) => href !== "/plan/").map(({ href, label }) => (
                <a key={href} role="menuitem" className="menu-site-link" href={href}>{label}</a>
              ))}
              <button
                role="menuitem"
                onClick={() => {
                  // MARKED BEFORE THE PLAN GOES (sync.ts, `startOver`). Signed
                  // in, the plan in the account used to be loaded straight
                  // back, so starting over undid itself.
                  if (confirm(
                    "Start over? This removes your current plan from this device. If you are signed in, the plan " +
                    "in your account is not changed: you can bring it back, and once your new plan is ready " +
                    "you will be asked which of the two to keep.",
                  )) {
                    startOver();
                    void setPlan(null);
                  }
                }}
              >
                Start over
              </button>
            </div>
          )}
        </div>
      </div>
      </div>
      <div className="main-row" id="main" role="main">
        {/* THE RAIL GOES ON THE LEFT. The side panel is on the right with
            a load-bearing resizer between it and the chart; the left edge
            is free, and it is the side a left-to-right reader scans first,
            which suits a list you pick from. It renders nothing at all
            until there is a what-if to compare against. */}
        <CandidateRail onToast={setToast} />
        {/* THE PLAN IN VIEW: the student's own, or the what-if whose tab
            is open. The chart and the list are handed the same thing
            either way. */}
        {view === "canvas" ? (
          <PlanCanvas onOpenItem={setOpenItem} />
        ) : (
          <PlanListView onOpenItem={setOpenItem} />
        )}
        {panelOpen && (
          <div
            className="panel-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={chatConfigured ? "Resize advisor panel" : "Resize side panel"}
            onPointerDown={startResize}
          />
        )}
        <SidePanel
          width={chatWidth}
          open={panelOpen}
          onToggle={togglePanel}
          onChangeProgram={(slug) => { setChangingProgram(slug); setShowPrograms(true); }}
        />
      </div>
      {/* IN THE LAYOUT, NOT OVER IT. The conflict bar above is fixed and
          floats, because a refused save is urgent and interrupting is the
          point. This is an offer, and on a 412px screen a floating bar
          would cover the plan the student came to look at — so it takes a
          row of its own between the chart and the disclaimer and the chart
          shrinks to fit. Nothing is obscured and nothing is unreachable. */}
      <KeepPlanBar plan={plan} />
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
      {showPrograms && (
        <ProgramsModal
          changing={changingProgram}
          onClose={() => { setShowPrograms(false); setChangingProgram(null); }}
          onToast={setToast}
        />
      )}
      {showLegal && <LegalModal onClose={() => setShowLegal(false)} />}
      {tour && (
        <Tour
          steps={tour}
          onClose={() => {
            markTourSeen();
            setTour(null);
          }}
        />
      )}
      {conflict && (
        <div className="conflict-bar" role="alert">
          <p>{conflictMessage()}</p>
          <span className="cb-actions">
            <button
              type="button"
              className="cb-go"
              onClick={async () => {
                // `pullNewerPlan` backs the local copy up before handing
                // back the remote one, so the edit that lost is still
                // recoverable after this.
                const newer = await pullNewerPlan(loadSavedPlan(), true);
                setConflict(false);
                if (newer) {
                  await setPlan(newer);
                  setToast("Loaded the newer plan. Your previous version was backed up.");
                } else {
                  setToast("Nothing newer to load — try your edit again.");
                }
              }}
            >
              Load the newer plan
            </button>
            <button type="button" onClick={() => setConflict(false)}>Not now</button>
          </span>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
