import { create } from "zustand";
import {
  applyHonorsUpgrades, attachIug, auditHonors, buildItems, buildSchedule, declareProgram, detachIug,
  optimizeSchedule, parseTermLabel, previewRemoveProgram, refineGenEdSlots, templateCourseCodes,
  withdrawProgram, carryCourseRefs, repairPrereqOrdering, termSequence, unrecordPriorCredit,
  type Catalog, type CourseSpec, type PlanDoc, type PlanItem, type ProgramTemplate,
  type RemoveProgramPreview, type ReqSection, type Schedule,
} from "@psu-planner/engine";
import {
  CANDIDATE_NAME_MAX, MAX_CANDIDATES, candidatesOf, contentsOf, foldView, isLegacyCandidate,
  keepCandidate as swapWithPlan, makeCandidate, viewOf,
  type Candidate, type LegacyCandidate, type PlanContents,
} from "@psu-planner/engine";
import { loadCatalogFor, loadCoverage, loadEditions, loadFlowchartPatterns, loadIug, loadProgramBySlug, setCatalogEdition } from "./data/catalogClient";
import { schedulePush } from "./data/sync";

/** A program file as the pipeline writes it. Only the parts the merge reads. */
interface PipelineProgramFile {
  slug: string;
  name: string;
  requirementSections?: ReqSection[];
  suggestedPlans?: { campusLabel: string; semesters: ProgramTemplate["semesters"] }[];
}

/** Load a Program as the engine wants it.
 *
 * The catalog client is already pinned to THIS Plan's Edition by `setPlan`, so
 * the Template a late-declared minor merges in comes from the bulletin that
 * governs the student rather than from whichever one is newest. Re-basing a
 * continuing student is precisely what ADR 0001 forbids, and it would happen
 * here silently if this read the current Edition instead. */
async function templateFor(slug: string): Promise<ProgramTemplate | null> {
  const prog = await loadProgramBySlug<PipelineProgramFile>(slug);
  if (!prog) return null;
  // The first published grid. Onboarding asks which campus plan to use; this
  // does not, because most late-declared Programs are minors and certificates,
  // which publish no grid at all and contribute only requirements. A second
  // MAJOR added here takes the catalog's own first plan — the ordering it gives
  // is a starting shape, and the optimizer re-flows it against this Plan
  // anyway. Worth a campus picker the first time someone asks for one.
  const grid = (prog.suggestedPlans ?? [])[0];
  return {
    slug: prog.slug,
    name: prog.name,
    campusLabel: grid?.campusLabel ?? "",
    semesters: grid?.semesters ?? [],
    requirements: prog.requirementSections ?? [],
  };
}

async function templatesFor(slugs: string[]): Promise<ProgramTemplate[]> {
  const loaded = await Promise.all(slugs.map((s) => templateFor(s).catch(() => null)));
  return loaded.filter((t): t is ProgramTemplate => !!t);
}

const LS_KEY = "psu-planner-plan-v1";

export function loadSavedPlan(): PlanDoc | null {
  try {
    const s = localStorage.getItem(LS_KEY);
    return s ? (JSON.parse(s) as PlanDoc) : null;
  } catch {
    return null;
  }
}

interface PlannerState {
  plan: PlanDoc | null;
  catalog: Catalog;
  items: PlanItem[];
  sched: Schedule;
  /** Directional coverage map (MATH 250 -> [MATH 251]) for substitute-aware completion. */
  coverage: Record<string, string[]>;
  loading: boolean;
  /** Why loading a plan failed, if it did. `loading` alone cannot express
   * this: setPlan used to set it true and clear it only on the happy path, so
   * any throw in between (a failed editions.json, a dropped catalog fetch)
   * left the app on "Loading your plan…" forever with the student's work
   * still on disk and no way to reach it. */
  loadError: string | null;
  /** The edition actually being READ, which is the plan's pin unless we do not
   * publish it. Separate from `plan.edition` on purpose: the pin is the
   * student's fact and we must not overwrite it, but the UI has to be able to
   * say which bulletin the requirements on screen actually came from. */
  servedEdition: string | null;
  /** One-shot note about generation-time prereq repairs, shown as a toast. */
  repairNote: string | null;
  clearRepairNote: () => void;

  /* ── What-ifs: independent copies of the Plan (#69) ───────────────────
     `plan` above is THE PLAN IN VIEW: the student's own, or the what-if
     whose tab is open. Everything that draws a plan or edits one reads it
     and needs to know nothing more, which is the whole mechanism: there is
     one editing path, and it edits what the student is looking at. The
     STORED document, the Plan with its what-ifs inside it, is
     `storedPlan()`; that is what is saved, synced and exported. */

  /** Which what-if's tab is open, or null for the student's own Plan.
   * AND THEREFORE WHAT AN EDIT CHANGES: with a tab open, `plan` is that
   * what-if's copy, and the Plan's own contents are set aside in `home`,
   * untouched, until the student goes back to them. */
  candidateId: string | null;
  /** The Plan's own contents while a what-if is in view; null otherwise. */
  home: PlanContents | null;
  /** Open a what-if's tab, or pass null to go back to the Plan. */
  showCandidate: (id: string | null) => Promise<void>;
  /** Make a what-if: an exact copy of the student's Plan, in a new tab, and
   * open it. Returns what to tell the student, including at the limit: the
   * refusal names the what-ifs that are in the way, because a `+` that
   * silently fails or silently drops the oldest is worse than one that
   * explains itself. */
  newCandidate: (opts?: { name?: string }) => Promise<string>;
  /** Rename a what-if. A default name must not block the student from
   * drawing, and three of them have to be tellable apart. */
  renameCandidate: (id: string, name: string) => string;
  /** Move an item to a Term: a drag on the chart, or "later" in the list
   * view. On the plan in view, like every edit. */
  moveItem: (itemId: string, termIndex: number) => Promise<void>;
  /** Add a Course from the toolbar search. Returns the toast. */
  addCourseAt: (code: string, termIndex: number) => Promise<string>;
  /** Fill a Slot with a Course. Returns the toast. */
  fillSlotWith: (slotId: string, code: string, label: string) => Promise<string>;
  /** Make a what-if the student's Plan. A SWAP: the Plan it replaces
   * becomes a what-if in its place, so nothing is lost by one click.
   * Returns what to tell them. */
  keepCandidate: (id: string) => Promise<string>;
  /** Throw a what-if away. Touches nothing else. */
  deleteCandidate: (id: string) => void;
  setPlan: (plan: PlanDoc | null, opts?: { repairOrdering?: boolean; optimize?: boolean }) => Promise<void>;
  /** Repack the current plan into the fewest <=19-credit terms, keeping the
   * flowchart's difficulty order and capstone at the end. Pass a term
   * target to spread the work across exactly that many terms (best effort). */
  optimizeNow: (targetTerms?: number) => Promise<string>;
  autoReoptimize: () => void;
  /** Edit the plan in view: the student's Plan, or the what-if they have
   * open (#69). It used to refuse with a what-if open; a what-if is a copy
   * now, and takes any edit a plan takes.
   *
   * Returns whether anything was written (`false` only where there is no
   * plan at all). */
  mutatePlan: (fn: (plan: PlanDoc) => void) => boolean;
  /** Marking complete removes the course from future terms (it already
   * happened — don't keep scheduling it); unmarking re-adds it to the first
   * term so it isn't lost. */
  markCompleted: (code: string, done: boolean) => void;
  /** Mark many courses completed at once (spreadsheet import) — one mutation. */
  bulkComplete: (codes: string[]) => void;
  /** Apply a spreadsheet import in one shot: mark `completed` courses done
   * (mapping onto matching template/alternative cards), fold `scheduled`
   * courses into the plan, then RE-OPTIMIZE unconditionally so the flowchart
   * adapts — imported courses flow to prerequisite-valid positions instead of
   * piling into the last term, and duplicates of template courses dedupe. */
  applyImport: (completed: string[], scheduled: { code: string; sem: number }[]) => Promise<void>;
  /** Swap a plan course for one of its listed alternatives (CMPSC 121 <-> 131). */
  swapAlternative: (oldCode: string, newCode: string) => Promise<void>;
  /** Hide an item from the chart and credit totals (restorable). */
  removeItem: (id: string) => void;
  restoreItem: (id: string) => void;
  /** Opt into the summer session of a calendar year (inserted between Spring
   * and Fall of that year). Returns the summer's term index, remapping any
   * index-keyed state (constraints, moves, added) that sits after it. Idempotent. */
  addSummerSession: (year: number) => number;
  /** Append an empty term to the end of the plan and return its index (for
   * dragging a course past the last term). Transient like any manual move —
   * re-optimizing repacks and trims it if left empty.
   *
   * ASYNC BECAUSE A WHAT-IF IS RE-RUN. Inside a Candidate this appends
   * `add_term` to its change list and the new index is read off the plan
   * those changes leave behind, which means running them. Returns -1 when
   * nothing was added. */
  addTerm: () => Promise<number>;
  /** Skip a term (gap year / co-op / leave): mark it an empty gap and
   * re-optimize so coursework flows around it and graduation moves back. */
  deleteTerm: (index: number) => Promise<string>;
  /** Un-skip a previously gapped term and re-optimize back into it. */
  restoreTerm: (index: number) => Promise<string>;
  /** Declare a Program on the Plan the student already has.
   *
   * The gap this closes: plan generation ran once, during onboarding, so a
   * student who declared a minor in October could only start over and lose
   * every completed Course, every Course they had added, every Slot they had
   * filled and every Constraint they had set. Returns a human summary. */
  addProgramNow: (slug: string) => Promise<string>;
  /** What dropping a Program would do, WITHOUT doing it. Dropping a Program
   * has a larger blast radius than removing one Course, so the student sees
   * the whole of it — what leaves, what stays, what is left unfilled — before
   * they decide. */
  previewDropProgram: (slug: string) => Promise<RemoveProgramPreview | null>;
  /** Drop a Program, removing the Courses it placed that nothing else needs. */
  removeProgramNow: (slug: string) => Promise<string>;
  /** Attach an IUG master's (by slug) to the current plan: loads the grad
   * program + grad courses, folds them on as graduate terms with double-count,
   * re-optimizes the undergrad half. Returns a human summary. */
  attachIugNow: (slug: string) => Promise<string>;
  /** Remove the attached IUG, returning to a plain bachelor's. */
  detachIugNow: () => Promise<string>;
  refreshCatalog: () => Promise<void>;
}

function recompute(plan: PlanDoc | null, catalog: Catalog): { items: PlanItem[]; sched: Schedule } {
  if (!plan) return { items: [], sched: {} };
  const items = buildItems(plan, catalog);
  return { items, sched: buildSchedule(plan, items, catalog) };
}

const HISTORY_LS_KEY = "psu-planner-plan-history-v1";
const HISTORY_MAX = 15;

export interface PlanHistoryEntry {
  ts: string;
  rev: number;
  /** e.g. "chat turn", "optimize", "manual edit", "generated" */
  cause: string;
  plan: PlanDoc;
}

/** Ring buffer of recent plan states — recovery that does NOT depend on the
 * chat session (a real incident: chat undo was lost and the wrecked plan was
 * the only persisted state). Restorable from Menu → Plan history. */
export function getPlanHistory(): PlanHistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_LS_KEY) ?? "[]") as PlanHistoryEntry[];
  } catch {
    return [];
  }
}

/** Put a Plan into history WITHOUT making it the current one.
 *
 * For a Plan that arrives from somewhere else and is not being adopted —
 * today that means the Plan found in a student's account when they chose
 * to carry on with the one on this device. It is still in Postgres, but
 * the sign-in read takes the newest row and this device's Plan is about
 * to be that, so nothing in the interface would ever show it again.
 * History is the door the rest of the app already points students at. */
export function recordInPlanHistory(plan: PlanDoc, cause: string): void {
  pushHistory(plan, cause);
}

function pushHistory(plan: PlanDoc, cause: string) {
  try {
    const log = getPlanHistory();
    const last = log[log.length - 1];
    if (last && JSON.stringify(last.plan) === JSON.stringify(plan)) return; // no-op change
    log.push({ ts: new Date().toISOString(), rev: plan.rev, cause, plan });
    localStorage.setItem(HISTORY_LS_KEY, JSON.stringify(log.slice(-HISTORY_MAX)));
  } catch { /* quota — history is best-effort, never blocks saving the plan */ }
}

/** The stored document a plan in view belongs to.
 *
 * Which what-if is in view, and the Plan's own contents while it is, are the
 * store's `candidateId` and `home`. `persist`, which every writer calls,
 * reads them here and puts a view back where it belongs, so that no writer
 * has to know there are what-ifs. A writer that had to, and forgot, would
 * save a what-if's contents as the student's degree. */
function storedFrom(view: PlanDoc): PlanDoc {
  const { candidateId, home } = usePlanner.getState();
  return candidateId && home ? foldView(view, candidateId, home) : view;
}

/** The stored document: the student's Plan with its what-ifs inside it,
 * whichever tab is open. What is saved, synced and exported; never the
 * plan in view, which with a tab open is somebody's sketch. */
export function storedPlan(): PlanDoc | null {
  const view = usePlanner.getState().plan;
  return view ? storedFrom(view) : null;
}

/** A short, local, time-ordered id, the shape `save_candidate` uses too. */
const candidateIdNow = (): string => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function persist(view: PlanDoc | null, cause = "edit") {
  // WHAT IS SAVED IS THE STORED DOCUMENT. With a what-if open, `view` is its
  // copy under the Plan's identity; folded, it lands in the what-if and the
  // Plan's own contents go back exactly as they were.
  const plan = view ? storedFrom(view) : null;
  try {
    if (plan) {
      pushHistory(plan, cause);
      localStorage.setItem(LS_KEY, JSON.stringify(plan));
    } else localStorage.removeItem(LS_KEY);
  } catch { /* quota exceeded: plan persists next time */ }
  if (plan) schedulePush(plan); // no-op unless Supabase configured + signed in
}

/** Completing X clears not just X's card but any card X substitutes for:
 * a card whose `alternatives` include X ("CMPSC 121 or 131" card, took 131),
 * or a card whose content X covers (took MATH 251, card is MATH 250). */
function clearSatisfiedCards(p: PlanDoc, code: string, coverage: Record<string, string[]>) {
  const satisfies = (cardCode: string, alts: string[] | undefined): boolean =>
    cardCode === code || (alts ?? []).includes(code) || (coverage[cardCode] ?? []).includes(code);
  for (const t of p.terms) {
    t.items = t.items.filter((it) => !("code" in it && satisfies(it.code, it.alternatives)));
  }
  p.added = p.added.filter((a) => !satisfies(a.code, undefined));
  delete p.moves[code];
  delete p.moves["add-" + code];
  for (const [slotId, fill] of Object.entries(p.slotFills)) {
    if (fill !== code) continue;
    delete p.slotFills[slotId];
    delete p.moves[slotId];
    for (const t of p.terms) {
      t.items = t.items.filter((it) => !("slot" in it && it.id === slotId));
    }
  }
}

function planCodes(plan: PlanDoc): string[] {
  const codes = plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));
  codes.push(...plan.added.map((a) => a.code));
  codes.push(...Object.values(plan.slotFills));
  codes.push(...Object.keys(plan.completed));
  return codes;
}

export const usePlanner = create<PlannerState>((set, get) => {
  /** The one writer of the plan in view.
   *
   * With no what-if open that is the student's Plan. With one open it is
   * the what-if's copy, and `persist` folds it back into the stored
   * document, leaving the Plan's own contents as they were. Every edit the
   * planner makes comes through here or calls `persist` itself, so none of
   * them has to ask which tab is open. */
  const writePlan = (fn: (plan: PlanDoc) => void, opts?: { cause?: string }): boolean => {
    const plan = get().plan;
    if (!plan) return false;
    const next: PlanDoc = structuredClone(plan);
    fn(next);
    next.rev += 1;
    next.updatedAt = new Date().toISOString();
    persist(next, opts?.cause);
    set({ plan: next, ...recompute(next, get().catalog) });
    return true;
  };

  /** Put a stored document on screen: its Plan, or the what-if `id`.
   * Writes nothing. Says whether the what-if was there to show. */
  const showStored = (stored: PlanDoc, id: string | null): boolean => {
    const view = id ? viewOf(stored, id) : null;
    if (id && view) {
      set({ candidateId: id, home: contentsOf(stored), plan: view, ...recompute(view, get().catalog) });
      return true;
    }
    set({ candidateId: null, home: null, plan: stored, ...recompute(stored, get().catalog) });
    return false;
  };

  /** Write the stored document itself, whichever tab is open: a what-if
   * made, kept or thrown away. Then show `thenShow` (or the Plan). */
  const writeStored = (next: PlanDoc, cause: string, thenShow: string | null): void => {
    next.rev += 1;
    next.updatedAt = new Date().toISOString();
    // `next` IS a stored document, so nothing is in view while it is saved:
    // folded a second time, the Plan's contents would be overwritten by
    // the ones set aside before this write.
    set({ candidateId: null, home: null });
    persist(next, cause);
    showStored(next, thenShow);
  };

  return {
  plan: null,
  catalog: {},
  items: [],
  sched: {},
  coverage: {},
  loading: false,
  loadError: null,
  servedEdition: null,
  repairNote: null,
  clearRepairNote: () => set({ repairNote: null }),

  candidateId: null,
  home: null,

  showCandidate: async (id) => {
    const view = get().plan;
    if (!view || id === get().candidateId) return;
    const stored = storedFrom(view);
    if (!showStored(stored, id) && id !== null) {
      // Gone: deleted or kept on another device. Said, and the student is
      // looking at their own Plan and knows it.
      set({ repairNote: "That what-if is no longer on this plan. You're looking at your own plan, which has not been changed." });
      return;
    }
    // A what-if may name Courses the Plan does not (that is the point of
    // one), and the catalog on hand was loaded for whichever was in view.
    await get().refreshCatalog();
  },

  keepCandidate: async (id) => {
    const view = get().plan;
    const stored = view ? storedFrom(view) : null;
    const candidate = candidatesOf(stored).find((c) => c.id === id);
    if (!stored || !candidate) return "That what-if is no longer on this plan.";
    // A SWAP (candidates.ts). What was the Plan becomes a what-if where the
    // kept one was, whole, so the student who kept the wrong one keeps the
    // other and is back where they started.
    const replacedId = candidateIdNow();
    const swapped = swapWithPlan(stored, id, replacedId, new Date().toISOString());
    if (!swapped) return "That what-if is no longer on this plan.";
    const replacedName = candidatesOf(swapped).find((c) => c.id === replacedId)?.name ?? "";
    writeStored(swapped, `kept the what-if "${candidate.name}"`, null);
    await get().refreshCatalog();
    return (
      `Kept "${candidate.name}". It's your plan now, and the plan it replaced is the what-if ` +
      `"${replacedName}", so nothing is lost.`
    );
  },

  deleteCandidate: (id) => {
    // NOTHING ELSE IS TOUCHED. Tidying up the rail must never be a risk to
    // the Plan itself, or to another what-if.
    const view = get().plan;
    if (!view) return;
    const open = get().candidateId;
    const stored = structuredClone(storedFrom(view));
    stored.candidates = (stored.candidates ?? []).filter((c) => c.id !== id);
    writeStored(stored, "deleted a what-if", open === id ? null : open);
  },

  newCandidate: async (opts) => {
    const view = get().plan;
    if (!view) return "No plan yet.";
    const stored = structuredClone(storedFrom(view));
    const already = stored.candidates ?? [];
    // AT THE LIMIT, SAY WHICH ONES ARE IN THE WAY. Dropping the oldest
    // silently deletes a comparison the student is in the middle of
    // making, and failing silently teaches them the button is broken.
    if (already.length >= MAX_CANDIDATES) {
      return (
        `You have ${already.length} what-ifs, which is the most a plan holds: ` +
        `${already.map((c) => `"${c.name}"`).join(", ")}. Delete one you have finished with, ` +
        "then make another."
      );
    }
    // A DEFAULT THAT DOES NOT BLOCK THE DRAWING. Being made to name a
    // sketch before starting it is friction at exactly the wrong moment,
    // so it gets the first unused number and a Rename button.
    const taken = new Set(already.map((c) => c.name.toLowerCase()));
    let name = opts?.name?.trim().slice(0, CANDIDATE_NAME_MAX).trimEnd() ?? "";
    if (!name || taken.has(name.toLowerCase())) {
      let n = 1;
      while (taken.has(`what-if ${n}`)) n++;
      name = `What-if ${n}`;
    }
    // A COPY OF THE STUDENT'S PLAN, whichever tab the `+` was pressed from:
    // "what if" is a question about the plan they have.
    const candidate: Candidate = makeCandidate(candidateIdNow(), name, stored, new Date().toISOString());
    stored.candidates = [...already, candidate];
    writeStored(stored, `made the what-if "${candidate.name}"`, candidate.id);
    return `Made "${candidate.name}", starting as your plan. Edit it here — your plan is untouched.`;
  },

  renameCandidate: (id, name) => {
    const plan = get().plan;
    const trimmed = name.trim();
    const candidate = (plan?.candidates ?? []).find((c) => c.id === id);
    if (!plan || !candidate) return "That what-if is no longer on this plan.";
    if (!trimmed) return "A what-if needs a name, so the old one has been kept.";
    // MEASURED against the rail: 200px at the planner's label size fits
    // roughly 40 characters before it wraps to a third line. The same
    // number `save_candidate` holds the assistant to.
    if (trimmed.length > CANDIDATE_NAME_MAX) {
      return `That name is ${trimmed.length} characters, and a tab shows about ${CANDIDATE_NAME_MAX}.`;
    }
    if ((plan.candidates ?? []).some((c) => c.id !== id && c.name.toLowerCase() === trimmed.toLowerCase())) {
      return `You already have a what-if called "${trimmed}", and two of the same name are not tellable apart.`;
    }
    if (trimmed === candidate.name) return `Still called "${trimmed}".`;
    // The list of what-ifs is on the plan in view as well as on the stored
    // one (`viewOf` carries it, `foldView` puts it back), so this is an
    // ordinary write whichever tab is open.
    writePlan((p) => {
      const c = (p.candidates ?? []).find((x) => x.id === id);
      if (c) c.name = trimmed;
    }, { cause: "renamed a what-if" });
    return `Renamed it to "${trimmed}".`;
  },

  setPlan: async (plan, opts) => {
    // A DIFFERENT PLAN HAS DIFFERENT WHAT-IFS. Carrying the open tab across
    // would leave a Candidate id pointing at nothing, or worse at a
    // same-named one belonging to another plan.
    set({ candidateId: null, home: null });
    persist(plan, opts?.optimize ? "generated" : "set plan");
    if (!plan) {
      // Starting over: drop the previous plan's edition pin too. Without this
      // the catalog stays on whatever that plan used, and onboarding builds a
      // BRAND-NEW plan pinned to an older bulletin, with no way back short of
      // a reload.
      void loadEditions().then((e) => setCatalogEdition(e.latest));
      set({ plan: null, items: [], sched: {}, loading: false });
      return;
    }
    set({ plan, loading: true, loadError: null });
    try {
    // Point the catalog at THIS plan's edition before anything reads a course.
    // A plan generated against 2025-2026 must keep being audited against
    // 2025-2026; serving it the newest edition would silently re-plan it
    // against requirements that do not govern this student.
    const editions = await loadEditions();
    // A plan saved before editions existed was generated against the oldest we
    // publish, so that is what it reads as. An edition we do not have falls
    // back to the OLDEST, not the newest: editions accumulate forward, so a
    // plan older than our range is nearer the oldest in requirements than the
    // newest (ADR-0001). The student is told which one they are seeing; that
    // notice is part of the onboarding edition work.
    const pinned = plan.edition ?? editions.editions[0];
    const effective = editions.editions.includes(pinned) ? pinned : editions.editions[0];
    setCatalogEdition(effective);
    // BACKFILL ONLY. PlanDoc.edition is "pinned at creation and never silently
    // upgraded", and a plan created before the field existed has none -- that
    // absence is what this fills, and the oldest published edition is what
    // such a plan was generated against.
    //
    // It must NOT be written when a pin is already there. An earlier version
    // assigned `effective` unconditionally, so a plan pinned to an edition we
    // do not publish yet had its real pin destroyed and replaced with our
    // fallback: shipping that bulletin later could never restore it, and the
    // plan would claim to BE the fallback. Where the two differ, the
    // difference is state (`servedEdition`), not an edit to the student's plan.
    if (plan.edition === undefined) {
      plan.edition = effective;
      // Persist ran at the top of setPlan, before this. Without re-saving, the
      // backfill lived only in memory and the next load repeated the work.
      persist(plan, "edition backfilled");
    }
    set({ servedEdition: effective });
    const catalog = await loadCatalogFor(planCodes(plan));
    const coverage = await loadCoverage();
    set({ coverage });
    const notes: string[] = [];
    // Schreyer honors upgrades run FIRST (RCL pair swapped + pinned to the
    // first two terms; the gen-ed audit then sees the swapped GWS courses),
    // then gen-ed refinement, then the optimizer. Because packing shifts which
    // academic year a course lands in, the upgrade pass runs AGAIN on the
    // final layout — swaps are in-place, so no re-optimization is needed.
    // All passes are idempotent.
    if (plan.honors) {
      const hon = applyHonorsUpgrades(plan, catalog);
      if (hon.note) notes.push(hon.note);
    }
    // Gen-ed refinement: names generic GE cards by framework category, drops
    // ones the major's own courses already cover (double-counting), and hints
    // at IL/US picks.
    const genEd = refineGenEdSlots(plan, catalog);
    if (genEd.note) notes.push(genEd.note);
    if (opts?.optimize) {
      // The optimizer is the LAST word: it anchors to the template order with
      // leaf-level prereq feasibility AND the 19-credit cap. Never run the
      // cap-blind repair pass after it (that was the 25-credit dual-major bug).
      const patterns = await loadFlowchartPatterns();
      const res = optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
      notes.push(`kept your ${res.termsAfter}-term flowchart order, ≤19 credits each, gen eds and electives spread throughout`);
      if (res.capstoneNote) notes.push(res.capstoneNote);
    } else if (opts?.repairOrdering) {
      // Non-optimized path: bulletin suggested plans sometimes violate their
      // own enforced prerequisites; move prereqs earlier like the department
      // flowcharts do.
      const moves = repairPrereqOrdering(plan, catalog);
      if (moves.length) {
        notes.push(`prerequisites reordered (${moves.map((m) => m.code).join(", ")})`);
      }
    }
    // Second honors pass on the FINAL layout: packing shifts academic years,
    // so top up the per-year windows in place and report what's still short.
    if (plan.honors) {
      const hon2 = applyHonorsUpgrades(plan, catalog);
      if (hon2.note) notes.push(hon2.note);
      const audit = auditHonors(plan, catalog);
      const short = audit.windows.filter((w) => w.shortfall > 0);
      if (short.length) notes.push(short.map((w) => `Schreyer ${w.label}: still ${w.shortfall} honors credits short (honors options on regular courses count too — arrange with instructors)`).join("; "));
    }
    if (notes.length) persist(plan, opts?.optimize ? "generated + optimized" : "repaired");
    // WHAT-IFS STORED THE OLD WAY (#69) were lists of changes. Each is
    // replayed once, against the Plan as it stands, and stored as the copy
    // it comes to. One whose changes no longer apply becomes a copy of the
    // Plan under its own name, and the student is told: an update must not
    // delete their work, and must not show them a what-if that is not one
    // without saying so. A catalog that would not load converts nothing;
    // the next load tries again.
    const unconverted: string[] = [];
    const old = ((plan.candidates ?? []) as (Candidate | LegacyCandidate)[]).filter(isLegacyCandidate);
    if (old.length) {
      try {
        const { convertLegacyCandidate } = await import("./data/candidateRun");
        const snap = { plan, catalog, ...recompute(plan, catalog) };
        const copies: Candidate[] = [];
        for (const c of (plan.candidates ?? []) as (Candidate | LegacyCandidate)[]) {
          if (!isLegacyCandidate(c)) { copies.push(c); continue; }
          const contents = await convertLegacyCandidate(snap, c);
          if (!contents) unconverted.push(c.name);
          copies.push({ id: c.id, name: c.name, createdAt: c.createdAt, plan: contents ?? contentsOf(plan) });
        }
        plan.candidates = copies;
        plan.rev += 1;
        plan.updatedAt = new Date().toISOString();
        persist(plan, "what-ifs converted to copies");
      } catch { /* the catalog did not load: they stay as they are, unlisted, for the next load */ }
    }
    const said = [
      notes.length ? `Optimized your schedule: ${notes.join("; ")}.` : "",
      unconverted.length
        ? `${unconverted.map((n) => `"${n}"`).join(", ")} ${unconverted.length === 1 ? "was a what-if" : "were what-ifs"} ` +
          "made of changes that no longer fit your plan, so " +
          `${unconverted.length === 1 ? "it is" : "they are"} now a copy of your plan under the same name.`
        : "",
    ].filter(Boolean).join(" ");
    set({
      plan, catalog, ...recompute(plan, catalog), loading: false,
      repairNote: said || null,
    });
    } catch (e) {
      // The plan itself is untouched on disk. Clearing `loading` and saying
      // what happened lets the student retry; leaving it set stranded them on
      // a spinner with their work inaccessible.
      set({
        loading: false,
        loadError: e instanceof Error ? e.message : "Could not load the catalog for this plan.",
      });
    }
  },

  optimizeNow: async (targetTerms?: number) => {
    const plan = get().plan;
    if (!plan) return "No plan yet.";
    const catalog = get().catalog;
    const patterns = await loadFlowchartPatterns();
    if (plan.honors) applyHonorsUpgrades(plan, catalog); // RCL pin + pre-pack upgrades (idempotent)
    const genEd = refineGenEdSlots(plan, catalog); // idempotent; keeps categories fresh
    const res = optimizeSchedule(plan, catalog, { maxCredits: 19, patterns, targetTerms });
    // Post-pack honors pass: packing shifts academic years, so top up windows
    // on the final layout (in-place swaps, no re-pack needed).
    const honors = plan.honors ? applyHonorsUpgrades(plan, catalog) : null;
    const next: PlanDoc = { ...plan, rev: plan.rev + 1, updatedAt: new Date().toISOString() };
    persist(next, "optimize");
    set({ plan: next, ...recompute(next, catalog) });
    let base: string;
    if (targetTerms && res.targetMissed) {
      base = `The remaining work won't fit in ${targetTerms} terms at 19 credits each — the tightest I can do is ${res.termsAfter}. Courses still rise in difficulty, max 19 credits each.`;
    } else if (targetTerms) {
      base = `Consolidated into ${res.termsAfter} terms as requested, max 19 credits each, difficulty rising and capstone last.`;
    } else {
      base = res.termsAfter < res.termsBefore
        ? `Packed your plan into ${res.termsAfter} terms (was ${res.termsBefore}), max 19 credits each, following the flowchart's difficulty order.`
        : `Rebalanced into ${res.termsAfter} terms, max 19 credits each, following the flowchart's difficulty order.`;
    }
    const extras = [res.capstoneNote, honors?.note, genEd.note].filter(Boolean).join(" ");
    return extras ? `${base} ${extras}` : base;
  },

  /** After completions change what's schedulable, re-optimize automatically —
   * but never silently destroy a manually arranged chart. */
  autoReoptimize: () => {
    const plan = get().plan;
    if (!plan) return;
    if (Object.keys(plan.moves).length === 0) {
      void get().optimizeNow().then((msg) => set({ repairNote: `Schedule updated — ${msg}` }));
    } else {
      set({ repairNote: "Course completed. You've arranged cards manually, so I didn't reshuffle — Menu → Optimize when ready." });
    }
  },

  mutatePlan: (fn) => {
    // ONE PATH (#69). The plan in view is what this writes: the student's
    // Plan, or the what-if they have open. There used to be a guard here
    // that refused with a what-if open; a what-if is a copy now, and takes
    // any edit a plan takes.
    return writePlan(fn);
  },

  markCompleted: (code, done) => {
    const coverage = get().coverage;
    get().mutatePlan((p) => {
      if (done) {
        p.completed[code] = true;
        // Remove the course wherever it's scheduled — including cards it
        // substitutes for (alternatives) or covers (MATH 251 -> MATH 250).
        clearSatisfiedCards(p, code, coverage);
        queueMicrotask(() => get().autoReoptimize());
      } else {
        // PUT BACK WHAT THE CLAIM ACTUALLY TOOK (#53), through the same
        // engine function the connector uses. This used to re-add the
        // bare code, which the optimiser then placed wherever it fitted
        // — losing Origin, so a requirement two Programs share stopped
        // counting once, and landing the card somewhere the student's
        // Program never put it.
        //
        // A Course marked complete some other way — this checkbox
        // before today, a spreadsheet import — has no record of what it
        // cleared, and `unrecordPriorCredit` falls back to the old
        // blind re-add for exactly those. Same function, both cases.
        unrecordPriorCredit(p, [code]);
      }
    });
  },

  bulkComplete: (codes) => {
    const coverage = get().coverage;
    get().mutatePlan((p) => {
      for (const code of codes) {
        p.completed[code] = true;
        clearSatisfiedCards(p, code, coverage);
      }
    });
    if (codes.length) get().autoReoptimize();
  },

  applyImport: async (completed, scheduled) => {
    if (!get().plan) return;
    const coverage = get().coverage;
    get().mutatePlan((p) => {
      for (const code of completed) {
        p.completed[code] = true;
        // Map onto the matching template/alternative/covered card instead of
        // leaving a duplicate on the chart.
        clearSatisfiedCards(p, code, coverage);
      }
      for (const s of scheduled) {
        if (p.completed[s.code]) continue;
        // Skip anything already on the chart — the optimizer dedupes by code,
        // but this also avoids a redundant `added` entry.
        const onChart = p.terms.some((t) => t.items.some((it) => "code" in it && it.code === s.code));
        if (!onChart && !p.added.some((a) => a.code === s.code)) p.added.push({ code: s.code, sem: s.sem });
      }
    });
    // Load any newly referenced subjects, then re-optimize UNCONDITIONALLY (an
    // import is a deliberate bulk change): the engine folds `added` courses into
    // prerequisite-valid positions and re-flows the whole plan around the
    // completed courses — no more "everything dumped in the last term".
    await get().refreshCatalog();
    await get().optimizeNow();
  },

  removeItem: (id) => {
    get().mutatePlan((p) => {
      p.removed = { ...(p.removed ?? {}), [id]: true };
      // "added" courses are simply dropped from the list instead.
      if (id.startsWith("add-")) {
        const code = id.slice(4);
        p.added = p.added.filter((a) => a.code !== code);
        delete p.removed[id];
        return;
      }
      // Preserve the full course spec (origin, alternatives) so Restore can
      // reinstate it even after a re-optimize rebuilds the term list without it
      // — the optimizer reads `removed`, so a removed course's card would
      // otherwise be gone for good and Restore would have nothing to bring back.
      for (const t of p.terms) {
        const spec = t.items.find((it) => "code" in it && it.code === id) as CourseSpec | undefined;
        if (spec) { p.removedSpecs = { ...(p.removedSpecs ?? {}), [id]: structuredClone(spec) }; break; }
      }
    });
  },

  restoreItem: (id) => {
    let reAdded = false;
    get().mutatePlan((p) => {
      if (p.removed) delete p.removed[id];
      // If a re-optimize already dropped the course from the term list, put its
      // preserved spec back so it's scheduled again (auto-restore). Its origin
      // rides along, so re-optimizing flows it to the right term.
      const present = p.terms.some((t) => t.items.some((it) => ("code" in it ? it.code : it.id) === id));
      const spec = p.removedSpecs?.[id];
      if (!present && spec) {
        if (!p.terms.length) p.terms.push({ label: "", items: [] });
        p.terms[0].items.push(structuredClone(spec) as typeof spec);
        reAdded = true;
      }
      if (p.removedSpecs) delete p.removedSpecs[id];
    });
    // A course put back into term 0 needs the optimizer to flow it into place
    // (guarded so a manually arranged chart isn't reshuffled).
    if (reAdded) get().autoReoptimize();
  },

  addSummerSession: (year) => {
    const plan = get().plan;
    if (!plan) return -1;
    const label = `Summer ${year}`;
    const existing = plan.terms.findIndex((t) => t.label === label);
    if (existing >= 0 || (plan.summerYears ?? []).includes(year)) {
      return existing >= 0 ? existing : plan.terms.findIndex((t) => t.label === label);
    }
    // Insert right after Spring of that year (or at the end if the plan
    // doesn't reach that spring yet — the optimizer resequences either way).
    const springIdx = plan.terms.findIndex((t) => t.label === `Spring ${year}`);
    const insertAt = springIdx >= 0 ? springIdx + 1 : plan.terms.length;
    get().mutatePlan((p) => {
      p.summerYears = [...(p.summerYears ?? []), year].sort((a, b) => a - b);
      p.terms.splice(insertAt, 0, { label, items: [] });
      // Remap every index-keyed reference at/after the insertion point.
      for (const c of p.constraints ?? []) if (c.termIndex >= insertAt) c.termIndex++;
      for (const a of p.added) if (a.sem >= insertAt) a.sem++;
      for (const k of Object.keys(p.moves)) if (p.moves[k] >= insertAt) p.moves[k]++;
    });
    return insertAt;
  },

  addTerm: async () => {
    const plan = get().plan;
    if (!plan) return -1;
    let idx = -1;
    get().mutatePlan((p) => {
      const ref = parseTermLabel(p.terms[0]?.label ?? "") ?? { kind: "Fall" as const, year: 2026, label: "Fall 2026" };
      const start = { term: (ref.kind === "Summer" ? "Fall" : ref.kind) as "Fall" | "Spring", year: ref.year };
      const seq = termSequence(start, p.terms.length + 2, p.summerYears ?? []);
      idx = p.terms.length;
      p.terms.push({ label: seq[idx]?.label ?? `Term ${idx + 1}`, items: [] });
    });
    return idx;
  },

  moveItem: async (itemId, termIndex) => {
    get().mutatePlan((p) => { p.moves[itemId] = termIndex; });
  },

  addCourseAt: async (code, termIndex) => {
    const display = get().catalog[code]?.display ?? code;
    if (!get().mutatePlan((p) => { p.added.push({ code, sem: termIndex }); })) return "";
    await get().refreshCatalog();
    const label = get().plan?.terms[termIndex]?.label ?? "your plan";
    return `Added ${display} to ${label}.`;
  },

  fillSlotWith: async (slotId, code, label) => {
    const display = get().catalog[code]?.display ?? code;
    if (!get().mutatePlan((p) => { p.slotFills[slotId] = code; })) return "";
    await get().refreshCatalog();
    return `Filled your ${label} slot with ${display}.`;
  },

  deleteTerm: async (index) => {
    const plan = get().plan;
    if (!plan || !plan.terms[index]) return "No such term.";
    const label = plan.terms[index].label;
    // Marking the term a gap makes the optimizer keep it empty and flow the
    // coursework (including whatever was in it) around it. Reoptimize is the
    // mechanism — nothing is removed, graduation simply moves back a term.
    get().mutatePlan((p) => { if (p.terms[index]) p.terms[index].gap = true; });
    const msg = await get().optimizeNow();
    const full = `Skipped ${label} (kept empty for your gap) — ${msg}`;
    set({ repairNote: full });
    return full;
  },

  restoreTerm: async (index) => {
    const plan = get().plan;
    if (!plan || !plan.terms[index]) return "No such term.";
    const label = plan.terms[index].label;
    get().mutatePlan((p) => { if (p.terms[index]) delete p.terms[index].gap; });
    const msg = await get().optimizeNow();
    const full = `Using ${label} again — ${msg}`;
    set({ repairNote: full });
    return full;
  },

  addProgramNow: async (slug) => {
    const plan = get().plan;
    if (!plan) return "No plan yet.";
    /* THESE FOUR WRITE WITHOUT GOING THROUGH `mutatePlan`: they hand the
       engine a copy, re-flow it and install it. They write the plan in
       view like everything else, so a Program or a master's degree can be
       tried in a what-if (#69): that is the question a what-if is most
       often for, and the one it used to refuse. */
    if (plan.programs.includes(slug)) return "That program is already on your plan.";
    const template = await templateFor(slug);
    if (!template) return "Couldn't load that program from the catalog.";
    // A COPY. The engine mutates in place, and handing it the live object
    // would leave the UI rendering a half-merged Plan if the catalog fetch
    // below threw — the student would see courses with no titles and no way
    // back. Nothing is committed until the merge and the re-flow both finish.
    const next = structuredClone(plan);
    // THE SUBJECTS FIRST, which used to happen after the merge so the
    // merged plan could be read for codes. `declareProgram` optimizes
    // against the catalog it is handed, so the catalog has to be wide
    // enough BEFORE it runs — and the template's own codes say what it
    // will bring without having to merge to find out.
    const catalog = {
      ...get().catalog,
      ...(await loadCatalogFor([...planCodes(plan), ...templateCourseCodes(template)])),
    };
    // ONE SEQUENCE, SHARED WITH THE CONNECTOR (#47). Merge, refine the
    // gen-eds against the whole merged plan, optimize last, then honors.
    // It used to be written out here and again in the connector, which is
    // two copies of an ordering — the divergence #39 exists to prevent.
    const res = declareProgram(next, template, {
      coveredBy: await loadCoverage(),
      catalog,
      maxCredits: 19,
      patterns: await loadFlowchartPatterns(),
    });
    next.rev = plan.rev + 1;
    next.updatedAt = new Date().toISOString();
    persist(next, `add program ${slug}`);
    set({ plan: next, catalog, ...recompute(next, catalog) });
    return res.note;
  },

  previewDropProgram: async (slug) => {
    const plan = get().plan;
    if (!plan) return null;
    // The Programs being KEPT, so the preview can say which of their
    // requirements this leaves with nothing standing for them. Without them
    // the report would be quietly incomplete, which is the reassuring-wrong
    // answer this project exists to avoid.
    const remaining = await templatesFor(plan.programs.filter((p) => p !== slug));
    return previewRemoveProgram(plan, slug, { remaining, catalog: get().catalog });
  },

  removeProgramNow: async (slug) => {
    const plan = get().plan;
    if (!plan) return "No plan yet.";
    const remaining = await templatesFor(plan.programs.filter((p) => p !== slug));
    const next = structuredClone(plan);
    const catalog = get().catalog;
    // The same shared sequence as declaring, pointed the other way (#47):
    // withdraw, refine the gen-eds against what is left, optimize last.
    const res = withdrawProgram(next, slug, {
      remaining,
      catalog,
      maxCredits: 19,
      patterns: await loadFlowchartPatterns(),
    });
    // Refused — the stored plan was never touched, because the engine was
    // handed a copy.
    if (res.refusal) return res.refusal;
    next.rev = plan.rev + 1;
    next.updatedAt = new Date().toISOString();
    persist(next, `remove program ${slug}`);
    set({ plan: next, ...recompute(next, catalog) });
    return res.note;
  },

  attachIugNow: async (slug) => {
    const plan = get().plan;
    if (!plan) return "No plan yet.";
    const spec = await loadIug(slug);
    if (!spec) return "Couldn't load that IUG program.";
    // Load the grad courses the IUG needs (grad-level subjects merge in via
    // loadSubject's :grad handling), on top of the current catalog.
    const gradCodes = [
      ...spec.doubleCount.eligible,
      ...spec.gradTracks.flatMap((t) => t.sections.flatMap((s) => s.rules.flatMap((r) =>
        r.type === "course" ? [r.code] : "options" in r ? r.options : []))),
    ];
    const catalog = { ...get().catalog, ...(await loadCatalogFor([...gradCodes, ...planCodes(plan)])) };
    const res = attachIug(plan, spec, catalog);
    const patterns = await loadFlowchartPatterns();
    optimizeSchedule(plan, catalog, { maxCredits: 19, patterns }); // re-flow UG half; grad terms preserved
    const next: PlanDoc = { ...plan, rev: plan.rev + 1, updatedAt: new Date().toISOString() };
    persist(next, `attach IUG ${slug}`);
    set({ plan: next, catalog, ...recompute(next, catalog) });
    return res.note;
  },

  detachIugNow: async () => {
    const plan = get().plan;
    if (!plan?.iug) return "No IUG attached.";
    const catalog = get().catalog;
    detachIug(plan);
    const patterns = await loadFlowchartPatterns();
    optimizeSchedule(plan, catalog, { maxCredits: 19, patterns });
    const next: PlanDoc = { ...plan, rev: plan.rev + 1, updatedAt: new Date().toISOString() };
    persist(next, "detach IUG");
    set({ plan: next, ...recompute(next, catalog) });
    return "Removed the master's degree — back to your bachelor's plan.";
  },

  swapAlternative: async (oldCode, newCode) => {
    get().mutatePlan((p) => {
      for (const t of p.terms) {
        for (const it of t.items) {
          if ("code" in it && it.code === oldCode) {
            const alts = new Set(it.alternatives ?? []);
            alts.delete(newCode);
            alts.add(oldCode);
            it.code = newCode;
            it.alternatives = [...alts];
            it.unverified = undefined;
            // EVERYTHING THAT NAMED THE OLD CODE, not just the move
            // (#54). A Constraint left pointing at a Course no longer in
            // the plan applies to nothing, so a student who said "not
            // that term" and then swapped lost the preference silently.
            // Shared with the connector so both surfaces carry the same
            // things.
            carryCourseRefs(p, oldCode, newCode);
            return;
          }
        }
      }
    });
    await get().refreshCatalog(); // the alternative may live in an unloaded subject
  },

  refreshCatalog: async () => {
    const plan = get().plan;
    if (!plan) return;
    const catalog = await loadCatalogFor(planCodes(plan));
    // THE PLAN IN VIEW NOW, not the one this started for: the student may
    // have opened another tab while the catalog was on its way, and items
    // built for a plan that is no longer on screen would be drawn under it.
    const now = get().plan;
    if (!now) return;
    const wide = { ...get().catalog, ...catalog };
    set({ catalog: wide, ...recompute(now, wide) });
  },
  };
});
