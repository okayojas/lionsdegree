import { create } from "zustand";
import {
  applyHonorsUpgrades, attachIug, auditHonors, buildItems, buildSchedule, declareProgram, detachIug,
  optimizeSchedule, parseTermLabel, previewRemoveProgram, refineGenEdSlots, templateCourseCodes,
  withdrawProgram, carryCourseRefs, repairPrereqOrdering, termSequence, unrecordPriorCredit,
  type Catalog, type CourseSpec, type PlanDoc, type PlanItem, type ProgramTemplate,
  type RemoveProgramPreview, type ReqSection, type Schedule,
} from "@psu-planner/engine";
import { MAX_CANDIDATES, type Candidate, type CandidateChange } from "@psu-planner/engine";
import type { CandidateDrawing, CandidateRefusal } from "./data/candidateRun";
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

  /* ── Candidates: what-ifs the student can look at ──────────────────────
     A Candidate lives on `plan.candidates` as a list of CHANGES. What is
     here is the one the student has open and the plan those changes leave
     behind — recomputed every time the tab is opened, never kept on disk.
     Storing the drawn plan is the mistake the whole design avoids: it
     would go stale against the real Plan without saying so. */

  /** Which Candidate's tab is open, or null for the student's own Plan.
   *
   * AND THEREFORE WHERE AN EDIT GOES (#59). This is the store's answer to
   * "which plan am I editing": with a tab open every edit the planner
   * accepts is appended to THAT Candidate's change list, and the real
   * Plan is not written at all. A mutation that forgot the routing would
   * edit the student's degree while they believed they were
   * experimenting, so the ones that are not routed do not fall through —
   * `mutatePlan` refuses them (see below), which makes a forgotten one a
   * message rather than a silent write. */
  candidateId: string | null;
  /** The plan that Candidate's changes leave behind, ready for the chart. */
  candidateView: CandidateDrawing | null;
  /** Why the open Candidate cannot be drawn, in the connector's own words.
   *
   * A tab whose change has stopped being possible says so and draws
   * NOTHING. Half a what-if rendered as a plan is the confident wrong
   * answer this project exists to refuse. */
  candidateRefusal: CandidateRefusal | null;
  /** A Candidate is being recomputed. Every open costs a re-run of the
   * whole plan, so the rail has to be able to say it is working. */
  candidateBusy: boolean;
  /** Open a Candidate's tab, or pass null to go back to the real Plan. */
  showCandidate: (id: string | null) => Promise<void>;
  /** Make a what-if of the student's own, starting as the Plan as it
   * stands — an EMPTY change list — and open it.
   *
   * The door #56 left only on the assistant's side. Returns what to tell
   * the student, including at the cap: the refusal names the what-ifs
   * that are in the way, because a `+` that silently fails or silently
   * drops the oldest is worse than one that explains itself. */
  newCandidate: () => Promise<string>;
  /** Rename a what-if. A default name must not block the student from
   * drawing, and three of them have to be tellable apart. */
  renameCandidate: (id: string, name: string) => string;
  /** Append one change to the OPEN Candidate's change list.
   *
   * THE EDIT SEAM. Tried against the plan the what-if currently leaves
   * behind before it is stored, so one impossible edit cannot brick the
   * tab, and nothing but the Candidate's own list is written. */
  editCandidate: (change: CandidateChange) => Promise<{ ok: boolean; message: string }>;
  /** Move an item to a Term — a drag on the chart, or "later →" in the
   * list view. Routed: inside a what-if this is a `move_course` on its
   * change list, and the real Plan is untouched. */
  moveItem: (itemId: string, termIndex: number) => Promise<void>;
  /** Add a Course from the toolbar search. Routed. Returns the toast. */
  addCourseAt: (code: string, termIndex: number) => Promise<string>;
  /** Fill a Slot with a Course. Routed. Returns the toast. */
  fillSlotWith: (slotId: string, code: string, label: string) => Promise<string>;
  /** Make the open Candidate the student's real Plan, by REPLAYING its
   * changes through the ordinary mutation path. Returns what to tell them. */
  keepCandidate: (id: string) => Promise<string>;
  /** Throw a Candidate away. Touches nothing else on the Plan. */
  deleteCandidate: (id: string) => void;
  setPlan: (plan: PlanDoc | null, opts?: { repairOrdering?: boolean; optimize?: boolean }) => Promise<void>;
  /** Repack the current plan into the fewest <=19-credit terms, keeping the
   * flowchart's difficulty order and capstone at the end. Pass a term
   * target to spread the work across exactly that many terms (best effort). */
  optimizeNow: (targetTerms?: number) => Promise<string>;
  autoReoptimize: () => void;
  /** Edit the student's REAL Plan.
   *
   * REFUSES WHILE A WHAT-IF IS OPEN, and says so. Every edit here writes
   * the document the student's degree is in, so an edit made while they
   * are looking at a what-if would change the plan they are comparing
   * AGAINST — the worst outcome this feature can produce. The chart's own
   * edits are routed to the Candidate instead (`editCandidate`); anything
   * that is not routed lands here and is refused rather than silently
   * applied to the wrong plan.
   *
   * Returns whether anything was written. `false` always comes with a
   * message already on screen, so a caller that ignores it cannot claim
   * success — it can only fail to add words of its own. */
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

function persist(plan: PlanDoc | null, cause = "edit") {
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
  /** The ONE writer of the student's real Plan.
   *
   * `mutatePlan` is this plus the guard that refuses while a what-if is
   * open. The two are separate because the Candidate housekeeping —
   * creating one, appending a change to one, deleting one — writes the
   * plan document on purpose WITH a tab open, and routing it through the
   * guard would mean the guard had an exception in it. An exception in a
   * guard is the shape of the bug the guard exists to stop.
   *
   * `redrawCandidate` is skipped by the edit path, which has already
   * computed the drawing it is about to show: re-running the whole change
   * list a second time costs an optimiser pass per edit and lands on the
   * same answer. */
  const writePlan = (
    fn: (plan: PlanDoc) => void,
    opts?: { cause?: string; redrawCandidate?: boolean },
  ): boolean => {
    const plan = get().plan;
    if (!plan) return false;
    const next: PlanDoc = structuredClone(plan);
    fn(next);
    next.rev += 1;
    next.updatedAt = new Date().toISOString();
    persist(next, opts?.cause);
    set({ plan: next, ...recompute(next, get().catalog) });
    // AN OPEN WHAT-IF FOLLOWS THE PLAN IT IS A WHAT-IF ABOUT. The student
    // or their assistant can edit the real Plan while a tab is open, and a
    // tab still showing the old comparison is the stale-into-a-lie case the
    // stored-changes design exists to rule out.
    const open = get().candidateId;
    if (open && opts?.redrawCandidate !== false) void get().showCandidate(open);
    return true;
  };

  /** What a change a what-if cannot hold is refused with.
   *
   * ONE SENTENCE, EVERYWHERE. A student who tried to drop a Program from
   * a what-if and a student whose detail card wrote nothing are in the
   * same position and need the same two facts: nothing happened, and
   * which plan is the one they are looking at. */
  const notInWhatIf = (what: string, c: Candidate): string =>
    `${what} isn't something a what-if can hold, so nothing was changed. You're looking at ` +
    `"${c.name}" — switch to Your plan to do it there.`;

  /** Route one chart edit into the open what-if, and make sure a refusal
   * is never silent.
   *
   * The chart's own controls — a drag, a term header button — have
   * nowhere of their own to put a sentence, and an edit that quietly does
   * nothing reads as a broken control. `repairNote` is the store's
   * channel to the toast. */
  const routeToCandidate = async (change: CandidateChange): Promise<string> => {
    const out = await get().editCandidate(change);
    if (!out.ok) set({ repairNote: out.message });
    return out.message;
  };

  /** The what-if the student has open, if it is still on the plan. */
  const openCandidate = (): Candidate | null => {
    const s = get();
    if (!s.candidateId) return null;
    return (s.plan?.candidates ?? []).find((c) => c.id === s.candidateId) ?? null;
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
  candidateView: null,
  candidateRefusal: null,
  candidateBusy: false,

  showCandidate: async (id) => {
    if (id === null) {
      set({ candidateId: null, candidateView: null, candidateRefusal: null, candidateBusy: false });
      return;
    }
    const s = get();
    const candidate = (s.plan?.candidates ?? []).find((c) => c.id === id);
    if (!s.plan || !candidate) {
      // Gone — deleted on another device, or kept there. The id is KEPT
      // so the message is reachable: the refusal panel is shown only for
      // an open tab, and clearing the id here left the student silently
      // looking at their own plan under a tab they had just clicked.
      set({ candidateId: id, candidateView: null, candidateBusy: false,
        candidateRefusal: {
          reason: "That what-if is no longer on this plan.",
          nothingChanged: "Your plan has not been changed.",
          position: null,
        } });
      return;
    }
    set({ candidateId: id, candidateBusy: true, candidateRefusal: null });
    // RECOMPUTED, NOT REPLAYED. The changes run against the Plan as it
    // stands at this moment, so a student who edited their plan after
    // saving the what-if is comparing against the plan they actually have.
    const { drawCandidate } = await import("./data/candidateRun");
    const snap = { plan: s.plan, catalog: s.catalog, items: s.items, sched: s.sched };
    try {
      const out = await drawCandidate(snap, candidate);
      // The student may have clicked another tab while this ran. Dropping a
      // stale answer is the difference between a slow tab and the wrong one.
      if (get().candidateId !== id) return;
      if ("refused" in out) {
        set({ candidateView: null, candidateRefusal: out.refused, candidateBusy: false });
      } else {
        set({ candidateView: out.drawn, candidateRefusal: null, candidateBusy: false });
      }
    } catch {
      if (get().candidateId !== id) return;
      // A failed catalog fetch is not a verdict about the what-if. It says
      // so rather than reporting the changes impossible.
      set({
        candidateView: null,
        candidateBusy: false,
        candidateRefusal: {
          reason: "This what-if couldn't be worked out just now — the course catalog didn't load.",
          nothingChanged: "Your plan has not been changed. Try the tab again in a moment.",
          position: null,
        },
      });
    }
  },

  keepCandidate: async (id) => {
    const s = get();
    const plan = s.plan;
    const candidate = (plan?.candidates ?? []).find((c) => c.id === id);
    if (!plan || !candidate) return "That what-if is no longer on this plan.";

    const { keepCandidate: replay } = await import("./data/candidateRun");
    /* THE COMPARE-AND-SWAP, against the LIVE plan rather than the copy this
       started from (ADR 0003). Each change names the revision it was
       computed from; if the assistant or another tab moved the plan in
       between, the write is refused and nothing is overwritten. This is why
       a Candidate stores changes and not a document: installing the drawn
       plan would have no revision to name. */
    const write = async (next: PlanDoc, baseRev: number): Promise<"written" | "stale"> => {
      const live = get().plan;
      if (!live || live.rev !== baseRev) return "stale";
      persist(next, `kept the what-if "${candidate.name}"`);
      set({ plan: next, ...recompute(next, get().catalog) });
      return "written";
    };

    const result = await replay(
      { plan, catalog: s.catalog, items: s.items, sched: s.sched },
      candidate,
      write,
    );

    if (result.refused) {
      if (result.applied === 0) {
        return `${result.refused.reason} ${result.refused.nothingChanged}`;
      }
      // A PARTIAL APPLY IS SAID OUT LOUD. It takes a genuine race to get
      // here — the changes were run in a sandbox first — and rounding it to
      // "done" or to "nothing happened" would both be false about a plan
      // the student is about to act on. Plan history holds the version from
      // before, which is where the recovery is.
      await get().showCandidate(id);
      return (
        `${result.applied} of ${result.of} changes were made before this stopped: ` +
        `${result.refused.reason} The rest were not made. Menu → Plan history has your plan ` +
        "from before, if you would rather go back."
      );
    }

    // Kept. The what-if is the plan now, so its tab goes: leaving it would
    // be a tab showing the plan it is beside.
    set({ candidateId: null, candidateView: null, candidateRefusal: null });
    writePlan((p) => {
      p.candidates = (p.candidates ?? []).filter((c) => c.id !== id);
    }, { cause: `kept the what-if "${candidate.name}"` });
    return `Kept "${candidate.name}" — it's your plan now. The other what-ifs are still here.`;
  },

  deleteCandidate: (id) => {
    // NOTHING ELSE IS TOUCHED. Tidying up the rail must never be a risk to
    // the plan itself, which is what `plan-candidates.test.ts` asserts on
    // the stored document rather than on what the screen shows.
    if (get().candidateId === id) {
      set({ candidateId: null, candidateView: null, candidateRefusal: null, candidateBusy: false });
    }
    // THROUGH THE WRITER, NOT THE GUARD. Deleting one what-if while
    // ANOTHER one is open is an edit to the plan document made on
    // purpose with a tab open, which is exactly what `mutatePlan` now
    // refuses — routing it there would have made the second tab
    // undeletable from the first.
    writePlan((p) => {
      p.candidates = (p.candidates ?? []).filter((c) => c.id !== id);
    }, { cause: "deleted a what-if" });
  },

  newCandidate: async () => {
    const plan = get().plan;
    if (!plan) return "No plan yet.";
    const already = plan.candidates ?? [];
    // AT THE CAP, SAY WHICH ONE IS IN THE WAY. Dropping the oldest
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
    let n = 1;
    while (taken.has(`what-if ${n}`)) n++;
    const candidate: Candidate = {
      // The same id shape `save_candidate` uses: short, local, and
      // time-ordered so the rail's order is stable without a sort key.
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name: `What-if ${n}`,
      // EMPTY, which is what makes it "my plan as it stands". A what-if
      // that started as a copy of the document would be the frozen
      // PlanDoc #56 refused; an empty change list re-runs to exactly the
      // plan the student is looking at, every time it is drawn.
      changes: [],
      basedOnRev: plan.rev,
      createdAt: new Date().toISOString(),
    };
    writePlan((p) => { p.candidates = [...(p.candidates ?? []), candidate]; },
      { cause: `made the what-if "${candidate.name}"`, redrawCandidate: false });
    await get().showCandidate(candidate.id);
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
    if (trimmed.length > 40) {
      return `That name is ${trimmed.length} characters, and a tab shows about 40.`;
    }
    if ((plan.candidates ?? []).some((c) => c.id !== id && c.name.toLowerCase() === trimmed.toLowerCase())) {
      return `You already have a what-if called "${trimmed}", and two of the same name are not tellable apart.`;
    }
    if (trimmed === candidate.name) return `Still called "${trimmed}".`;
    writePlan((p) => {
      const c = (p.candidates ?? []).find((x) => x.id === id);
      if (c) c.name = trimmed;
    }, { cause: "renamed a what-if", redrawCandidate: false });
    // The drawing carries the name so a view that is not the rail can say
    // which what-if it is showing — the list view's region label, which a
    // screen-reader user has instead of a tab.
    const view = get().candidateView;
    if (view && get().candidateId === id) set({ candidateView: { ...view, name: trimmed } });
    return `Renamed it to "${trimmed}".`;
  },

  editCandidate: async (change) => {
    const s = get();
    const candidate = openCandidate();
    if (!s.plan || !candidate) {
      return { ok: false, message: "Open a what-if first — this changes the what-if, not your plan." };
    }
    const id = candidate.id;
    set({ candidateBusy: true });
    const { appendChange } = await import("./data/candidateRun");
    const snap = { plan: s.plan, catalog: s.catalog, items: s.items, sched: s.sched };
    let out: Awaited<ReturnType<typeof appendChange>>;
    try {
      out = await appendChange(snap, candidate, change);
    } catch {
      set({ candidateBusy: false });
      return {
        ok: false,
        message: "That couldn't be worked out just now — the course catalog didn't load. Nothing was changed.",
      };
    }
    // The student may have closed the tab or opened another while this
    // ran. Appending to a what-if they are no longer looking at would be
    // an edit they did not watch happen.
    if (get().candidateId !== id) {
      set({ candidateBusy: false });
      return { ok: false, message: "That what-if is no longer open, so nothing was changed." };
    }
    if ("refused" in out) {
      // NOTHING IS APPENDED. A change that cannot be made is not written
      // into the list, so the tab still draws and the student can try
      // something else — a what-if bricked by one bad edit would be a
      // dead end with their work in it.
      set({ candidateBusy: false });
      return { ok: false, message: `${out.refused.reason} ${out.refused.nothingChanged}` };
    }
    writePlan((p) => {
      const c = (p.candidates ?? []).find((x) => x.id === id);
      if (c) c.changes = [...c.changes, change];
    }, { cause: `edited the what-if "${candidate.name}"`, redrawCandidate: false });
    set({ candidateView: out.drawn, candidateRefusal: null, candidateBusy: false });
    return { ok: true, message: `Added to "${candidate.name}". Your plan is untouched.` };
  },

  setPlan: async (plan, opts) => {
    // A DIFFERENT PLAN HAS DIFFERENT WHAT-IFS. Carrying the open tab across
    // would leave a Candidate id pointing at nothing, or worse at a
    // same-named one belonging to another plan.
    set({ candidateId: null, candidateView: null, candidateRefusal: null, candidateBusy: false });
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
    set({
      plan, catalog, ...recompute(plan, catalog), loading: false,
      repairNote: notes.length ? `Optimized your schedule: ${notes.join("; ")}.` : null,
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
    // ROUTED. Optimising inside a what-if is a change the what-if holds,
    // not a repack of the student's real schedule.
    if (openCandidate()) {
      const out = await get().editCandidate({
        tool: "optimize_schedule",
        arguments: targetTerms ? { target_terms: targetTerms } : {},
      });
      return out.message;
    }
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
    // THE BACKSTOP, AND THE POINT OF THE WHOLE TICKET. Reaching here with
    // a what-if open means an edit was not routed to it — so it is
    // refused and named, never applied to the plan the student is
    // comparing against. The ones the planner does route never arrive
    // here; they go through `editCandidate`.
    const open = openCandidate();
    if (open) {
      set({ repairNote: notInWhatIf("That", open) });
      return false;
    }
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
    // The re-optimize below is OUTSIDE the mutation, so a refused write
    // would otherwise still reflow something — the real plan, or the open
    // what-if. Nothing happened; nothing follows.
    if (openCandidate()) { get().mutatePlan(() => {}); return; }
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
    // Same reason as `bulkComplete`: the import ends in an unconditional
    // re-optimize, which must not run when the import itself did not.
    if (openCandidate()) { get().mutatePlan(() => {}); return; }
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
    // The index this returns is a fact about a plan that was changed, so
    // it refuses here rather than letting the backstop below swallow the
    // write and still hand back a number. (Nothing in the chart reaches
    // this inside a what-if: it is the advisor's tool, and the advisor is
    // refused by name while a tab is open.)
    const open = openCandidate();
    if (open) {
      set({ repairNote: notInWhatIf("Adding a summer", open) });
      return -1;
    }
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
    if (openCandidate()) {
      const before = get().candidateView?.plan.terms.length ?? 0;
      await routeToCandidate({ tool: "add_term", arguments: {} });
      if ((get().candidateView?.plan.terms.length ?? 0) <= before) return -1;
      // THE INDEX OF THE TERM THE WHAT-IF NOW HAS, read off the plan its
      // changes leave behind rather than off the student's own plan —
      // dropping a card past the last column has to land in the term the
      // student can see, and the two plans need not be the same length.
      return (get().candidateView?.plan.terms.length ?? 0) - 1;
    }
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
    const candidate = openCandidate();
    if (!candidate) {
      get().mutatePlan((p) => { p.moves[itemId] = termIndex; });
      return;
    }
    // THE ITEM AS THE WHAT-IF HAS IT. The card the student dragged is on
    // the plan the what-if's changes leave behind, and `move_course`
    // names a COURSE CODE — so the id has to be resolved against that
    // plan, not against the student's own, where the same slot may be
    // filled by a different course or not exist at all.
    const it = (get().candidateView?.items ?? []).find((i) => i.id === itemId);
    if (!it || it.kind !== "course" || !it.code) {
      // An EMPTY Slot has no code, and the change list names courses. The
      // honest answer is to say which plan can take the edit rather than
      // to invent a change that means something else.
      set({
        repairNote:
          "An open requirement can't be moved inside a what-if — a what-if records changes by " +
          "course. Fill it first, or move it on your own plan.",
      });
      return;
    }
    // A refusal is said out loud and a move that worked is not: it is
    // already on the screen, and a toast after every drag is noise over
    // an answer the student can see.
    await routeToCandidate({ tool: "move_course", arguments: { code: it.code, term_index: termIndex } });
  },

  addCourseAt: async (code, termIndex) => {
    const display = get().catalog[code]?.display ?? code;
    const candidate = openCandidate();
    if (candidate) {
      const out = await get().editCandidate({
        tool: "add_course",
        arguments: { code, term_index: termIndex },
      });
      return out.message;
    }
    if (!get().mutatePlan((p) => { p.added.push({ code, sem: termIndex }); })) return "";
    await get().refreshCatalog();
    const label = get().plan?.terms[termIndex]?.label ?? "your plan";
    return `Added ${display} to ${label}.`;
  },

  fillSlotWith: async (slotId, code, label) => {
    const display = get().catalog[code]?.display ?? code;
    if (openCandidate()) {
      const out = await get().editCandidate({
        tool: "fill_slot",
        arguments: { slot_id: slotId, code },
      });
      return out.message;
    }
    if (!get().mutatePlan((p) => { p.slotFills[slotId] = code; })) return "";
    await get().refreshCatalog();
    return `Filled your ${label} slot with ${display}.`;
  },

  deleteTerm: async (index) => {
    const plan = get().plan;
    if (openCandidate()) {
      // The term indices on screen are the WHAT-IF's, which is what the
      // change has to name: its plan may be a different length from the
      // student's own by the time three changes have run.
      return routeToCandidate({ tool: "skip_term", arguments: { term_index: index } });
    }
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
    if (openCandidate()) {
      return routeToCandidate({ tool: "restore_term", arguments: { term_index: index } });
    }
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
    /* THESE FOUR WRITE THE PLAN WITHOUT GOING THROUGH `mutatePlan` — they
       hand the engine a copy, re-flow it and install it — so the backstop
       there does not cover them and they refuse for themselves. A Program
       or a master's degree is also a decision about the DEGREE rather
       than about the shape of one what-if, which is why they are refused
       rather than routed: there is no reading of "drop my minor inside
       this sketch" that does not change what the student is studying. */
    const open = openCandidate();
    if (open) return notInWhatIf("Declaring a program", open);
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
    const open = openCandidate();
    if (open) return notInWhatIf("Dropping a program", open);
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
    const open = openCandidate();
    if (open) return notInWhatIf("Adding a master's degree", open);
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
    const open = openCandidate();
    if (open) return notInWhatIf("Removing the master's degree", open);
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
    set({ catalog, ...recompute(plan, catalog) });
  },
  };
});
