/** Running a Candidate's changes — in the browser, through the connector's
 * own sandbox.
 *
 * THE DECISION THIS FILE EXISTS TO HONOUR (#56). A Candidate tab draws the
 * plan a saved list of changes would leave behind, and it must be drawn by
 * the planner's own chart because it IS the planner's own chart. For that
 * to be safe, the plan it draws has to be the same plan `simulate_changes`
 * would describe — so this does not apply changes itself. It imports
 * `runChanges` from `packages/mcp/src/sandbox.ts`, the one place an ordered
 * list of changes is applied, and hands it a context built over the
 * planner's state.
 *
 * A second implementation here would be a picture of a degree the connector
 * then refuses to produce, which is the drift this codebase has paid for in
 * #47, #50, #53 and #54.
 *
 * LOADED LAZILY, AND THAT IS NOT AN OPTIMISATION. The connector's mutation
 * surface is ~12 KB gzipped (MEASURED: `plan-*.js` went from 104.1 KB to
 * 116.3 KB gzipped when it was imported statically, `zlib.gzipSync` over the
 * built asset). A student who never opens a what-if should not download it
 * before their chart appears — `e2e/boot-budget.spec.ts` holds a measured
 * ceiling on exactly that, and ADR 0002 says the answer is to fix the
 * payload rather than raise the number.
 *
 * NOTHING HERE IS ACCOUNT-DEPENDENT. A Candidate is on the Plan document,
 * which lives in localStorage whether or not `syncConfigured` is true, and
 * the catalog is the same static files the chart already reads. Signed out,
 * all of this works.
 */
import type {
  Candidate, CandidateChange, Catalog, PlanDoc, PlanItem, ProgramTemplate, ReqSection, Schedule,
} from "@psu-planner/engine";
import { buildItems, buildSchedule } from "@psu-planner/engine";
// TYPE ONLY, and that matters: `@connector/tools.js` imports `node:fs` at
// the top level, so a value import of it would drag Node into the browser
// bundle. Types are erased, and the context shape is what has to agree.
import type { ToolContext } from "@connector/tools.js";
import type { EditionCatalog } from "@connector/catalog.js";
import type { PlanStore } from "@connector/planStore.js";
import {
  loadCatalogFor,
  loadCoverage,
  loadEditions,
  loadIug,
  loadProgramBySlug,
  loadProgramsIndex,
} from "./catalogClient";

/** Everything the runner needs to know about the Plan as it stands.
 *
 * Passed in rather than read from the store, so this module does not import
 * the store the store imports it from. */
export interface PlannerSnapshot {
  plan: PlanDoc;
  catalog: Catalog;
  items: PlanItem[];
  sched: Schedule;
}

/** The plan a Candidate's changes leave behind, ready to draw. */
export interface CandidateDrawing {
  /** Which what-if this is, so a view that is not the rail can say so —
     a screen-reader user in the list view has no tab to look at. */
  name: string;
  plan: PlanDoc;
  items: PlanItem[];
  sched: Schedule;
  /** Courses or Programs this what-if takes out of the degree.
   *
   * TOLD, NOT REFUSED (#59). Keeping this is the student's own click on
   * their own plan — the same one the course card already takes — so it
   * is allowed. What they must not do is discover the cost afterwards,
   * so the rail states it before they choose. The name is the connector's
   * own (`runChanges` computes it); what changed is what the planner does
   * with the answer. */
  needsConsent: string[];
}

/** Why a Candidate cannot be drawn, in the connector's own words.
 *
 * NO PARTIAL PLAN COMES WITH THIS. A tab showing the plan as it stood after
 * three of five changes is a plan nobody asked for, offered as the answer
 * to a question about five. The rule is `simulate_changes`'s and this is
 * the same refusal object, so the sentence a student reads on a tab is the
 * sentence their assistant would have read. */
export interface CandidateRefusal {
  reason: string;
  nothingChanged: string;
  /** Which change stopped it, counted the way a person reads a list. */
  position: string | null;
}

/** A program file as the pipeline writes it. Only the parts the connector
 * reads — the same subset `store.ts` takes for its own merges. */
interface PipelineProgramFile {
  slug: string;
  name: string;
  type?: string;
  totalCredits?: number | null;
  requirementSections?: ReqSection[];
  suggestedPlans?: { campusLabel: string; semesters: ProgramTemplate["semesters"] }[];
}

/** Course codes a list of changes names, so the catalog can be widened
 * before the changes run.
 *
 * WITHOUT THIS A CANDIDATE LIES. The planner holds a catalog covering the
 * Plan's own codes, not the whole bulletin; `add_course` asks `catalog[code]`
 * directly and answers "not in the catalog — search for it first" when it is
 * absent. A what-if that adds CHEM 112 would therefore refuse itself on a
 * course that exists, and the tab would say the student cannot do something
 * they can.
 *
 * Matched on shape — SUBJ 123 — rather than on argument name, because the
 * code arrives as `code`, `codes`, `to` and `from` depending on the tool,
 * and a list of argument names is a thing that goes out of date silently. */
const CODE_SHAPE = /^[A-Z][A-Z& ]{1,9} ?\d{1,3}[A-Z]?$/;
function codesNamedIn(changes: readonly CandidateChange[]): string[] {
  const out = new Set<string>();
  const look = (v: unknown): void => {
    if (typeof v === "string") {
      const s = v.trim().toUpperCase();
      if (CODE_SHAPE.test(s)) out.add(s);
      return;
    }
    if (Array.isArray(v)) v.forEach(look);
  };
  for (const c of changes) for (const v of Object.values(c.arguments)) look(v);
  return [...out];
}

const planCodes = (plan: PlanDoc): string[] => [
  ...plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : []))),
  ...plan.added.map((a) => a.code),
  ...Object.values(plan.slotFills),
  ...Object.keys(plan.completed),
];

/** The connector's `EditionCatalog`, served from the planner's own fetches.
 *
 * ONE SHAPE, TWO SOURCES. The connector reads the catalog off disk or over
 * its own fetch; this reads the same files the chart reads. What matters is
 * that `mutations.ts` cannot tell which it has — the moment it could, the
 * two surfaces would start answering differently about the same degree.
 *
 * The methods nobody on this path calls THROW rather than return something
 * plausible. `summary` and the search ranking are read tools; if a future
 * mutation reaches for one, a thrown error is a bug report and an empty
 * string is a wrong answer nobody notices. */
async function editionCatalog(
  snap: PlannerSnapshot,
  changes: readonly CandidateChange[],
): Promise<EditionCatalog> {
  const editions = await loadEditions();
  const pinned = snap.plan.edition ?? editions.editions[0];
  const effective = editions.editions.includes(pinned) ? pinned : editions.editions[0];

  // The Plan's own courses plus anything the changes name, in one fetch.
  // `loadCatalogFor` is memoised per subject, so re-opening a tab costs
  // nothing.
  const catalog: Catalog = {
    ...snap.catalog,
    ...(await loadCatalogFor([...planCodes(snap.plan), ...codesNamedIn(changes)])),
  };

  // The Programs already on the Plan, so `fill_slot` can find the rule
  // behind a Slot. Loaded up front because the field is read synchronously.
  const programs: EditionCatalog["programs"] = {};
  await Promise.all(
    snap.plan.programs.map(async (slug) => {
      const p = await loadProgramBySlug<PipelineProgramFile>(slug).catch(() => null);
      if (!p) return;
      programs[slug] = {
        slug: p.slug,
        name: p.name,
        type: p.type ?? "major",
        totalCredits: p.totalCredits ?? null,
        requirementSections: p.requirementSections ?? [],
      };
    }),
  );

  const index = await loadProgramsIndex().catch(() => []);

  return {
    edition: effective,
    editions: editions.editions,
    catalog,
    programs,
    programsIndex: index,
    coveredBy: await loadCoverage(),
    async ensureCourses(codes: readonly string[]) {
      Object.assign(catalog, await loadCatalogFor([...codes]));
    },
    async ensureSubjects(subjects: readonly string[]) {
      // `loadCatalogFor` keys off the subject prefix of each code, so a
      // subject is asked for as one of its own courses. The number is
      // ignored; nothing reads it.
      Object.assign(catalog, await loadCatalogFor(subjects.map((s) => `${s} 1`)));
    },
    async iugPrograms() {
      throw new Error("a candidate does not list IUG programs");
    },
    iug: (slug: string) => loadIug(slug),
    async summary() {
      throw new Error("a candidate does not read course prose");
    },
    async programTemplate(slug: string) {
      const p = await loadProgramBySlug<PipelineProgramFile>(slug);
      if (!p) return null;
      // The first published grid, exactly as `store.ts` takes it for the
      // planner's own merges — a Program with no grid contributes
      // requirements and places no courses, which is what minors do.
      const grid = (p.suggestedPlans ?? [])[0];
      return {
        slug: p.slug,
        name: p.name,
        campusLabel: grid?.campusLabel ?? "",
        semesters: grid?.semesters ?? [],
        requirements: p.requirementSections ?? [],
      };
    },
    async ensureSearchRanking() {
      throw new Error("a candidate does not search the catalog");
    },
    get ranking(): never {
      throw new Error("a candidate does not rank search results");
    },
  };
}

/** Read the refusal the connector built into the words a tab shows. */
function refusalFrom(refused: Record<string, unknown>): CandidateRefusal {
  const stopped = refused.stopped_at as { position?: string } | undefined;
  return {
    reason: String(refused.reason ?? refused.error ?? "This what-if cannot be worked out from your plan as it stands."),
    nothingChanged: String(refused.nothing_changed ?? "Your plan has not been changed."),
    position: stopped?.position ?? null,
  };
}

/** Build the context the connector's tools work on, over the Plan the
 * planner is holding.
 *
 * `store` is null: a sandbox makes its own, and the real-apply path below
 * supplies one. `rev` is the document's, which in the browser IS the held
 * revision — there is no column that can be ahead of it. */
async function contextFor(
  snap: PlannerSnapshot,
  changes: readonly CandidateChange[],
): Promise<ToolContext> {
  const data = await editionCatalog(snap, changes);
  // Rebuilt against the WIDENED catalog rather than reused from the
  // snapshot: the store's items were built before the changes' own
  // courses were loaded, and a schedule that cannot see them reports
  // prerequisites it has not read.
  const items = buildItems(snap.plan, data.catalog);
  return {
    plan: snap.plan,
    planPath: "",
    store: null,
    rev: snap.plan.rev,
    updatedAt: snap.plan.updatedAt,
    data,
    items,
    sched: buildSchedule(snap.plan, items, data.catalog),
  };
}

/** The plan this Candidate's changes would leave, recomputed against the
 * Plan as it stands RIGHT NOW.
 *
 * Never replayed from a snapshot: that is what stops a tab going stale into
 * a lie. If the student edited their plan after saving the what-if, the tab
 * shows the what-if applied to the plan they actually have. */
export async function drawCandidate(
  snap: PlannerSnapshot,
  candidate: Candidate,
): Promise<{ drawn: CandidateDrawing } | { refused: CandidateRefusal }> {
  const { runChanges, sandbox } = await import("@connector/sandbox.js");
  const ctx = await contextFor(snap, candidate.changes);
  const run = await runChanges(sandbox(ctx), candidate.changes);
  if ("refused" in run) return { refused: refusalFrom(run.refused as Record<string, unknown>) };

  const plan = run.after.plan!;
  const catalog = run.after.data.catalog;
  const items = buildItems(plan, catalog);
  return {
    drawn: {
      name: candidate.name,
      plan,
      items,
      sched: buildSchedule(plan, items, catalog),
      needsConsent: run.needsConsent,
    },
  };
}

/** One more change on the end of a Candidate's list — tried first, and
 * only handed back if the what-if still draws.
 *
 * THE EDIT PATH (#59). A student editing inside a what-if is adding to
 * ITS change list, never mutating a copy of the Plan: that is what keeps
 * a Candidate recomputable, small, and keepable through the ordinary
 * mutation path with the revision check intact. Storing the mutated
 * document instead would reintroduce exactly what #56 refused.
 *
 * TRIED BEFORE IT IS STORED, because one impossible edit must not brick
 * the tab. The change runs against the plan the what-if currently leaves
 * behind; if the connector refuses it, nothing is appended and the
 * student is told in the connector's own words — the same sentence their
 * assistant would have read.
 *
 * The caller does the storing: this module does not reach into the
 * store, for the same reason `keepCandidate` does not. */
export async function appendChange(
  snap: PlannerSnapshot,
  candidate: Candidate,
  change: CandidateChange,
): Promise<{ drawn: CandidateDrawing } | { refused: CandidateRefusal }> {
  const { MAX_CHANGES } = await import("@connector/sandbox.js");
  if (candidate.changes.length >= MAX_CHANGES) {
    // The connector's own ceiling, read from the connector rather than
    // written down twice: every change re-runs the optimiser over the
    // whole plan, and a list past this is a tab that takes longer to draw
    // than the student will wait.
    return {
      refused: {
        reason:
          `This what-if already has ${candidate.changes.length} changes, which is as many as one ` +
          "holds — each change re-runs your whole plan.",
        nothingChanged:
          "Your plan has not been changed. Keep this what-if, or start another one for the rest.",
        position: null,
      },
    };
  }
  return drawCandidate(snap, { ...candidate, changes: [...candidate.changes, change] });
}

/** What happened when a Candidate was kept. */
export interface KeptResult {
  /** How many of the changes landed. Reported even on a refusal, because a
   * change that lands and one that does not are both facts about the
   * student's plan and only one of them is visible. */
  applied: number;
  of: number;
  refused: CandidateRefusal | null;
}

/** Keep a Candidate: replay its changes through the ORDINARY mutation path,
 * against the revision the Plan is at now.
 *
 * NOT AN INSTALL OF THE DRAWN DOCUMENT, and that is the whole reason a
 * Candidate stores changes. Writing the plan the tab was showing would
 * overwrite whatever the student or their assistant did in the meantime;
 * replaying the calls means each one names the revision it was computed
 * from and is refused rather than allowed to overwrite them (ADR 0003).
 *
 * `write` is the compare-and-swap. It is handed in so this module does not
 * reach into the store, and so the swap is against the LIVE plan rather
 * than against the copy this function started with.
 *
 * A DRY RUN FIRST. The changes are run in a sandbox before any of them is
 * written, so the ordinary "this is no longer possible" case costs nothing
 * and leaves the plan alone. What survives that is a genuine race — another
 * tab or the assistant writing between two of our calls — and the count is
 * reported rather than rounded to "done". */
export async function keepCandidate(
  snap: PlannerSnapshot,
  candidate: Candidate,
  write: (plan: PlanDoc, baseRev: number) => Promise<"written" | "stale">,
): Promise<KeptResult> {
  const total = candidate.changes.length;
  const { runChanges, sandbox } = await import("@connector/sandbox.js");
  const ctx = await contextFor(snap, candidate.changes);

  const dry = await runChanges(sandbox(ctx), candidate.changes);
  if ("refused" in dry) {
    return { applied: 0, of: total, refused: refusalFrom(dry.refused as Record<string, unknown>) };
  }

  // THE REAL PATH, with a real store behind it.
  //
  // A WHAT-IF THAT REMOVES A COURSE MAY BE KEPT (#59), and this flag is
  // where that decision lives. The consent gate demands the student's own
  // words because a MODEL can claim they asked; the caller here is the
  // student, pressing "keep this one" in their own browser, and the
  // planner already lets them drop a Course with one click on its card.
  // Refusing it from a tab was inherited from the hosted path, not
  // decided — and a product that refuses from one tab what it permits on
  // the next erodes trust in the refusal itself.
  //
  // NOTHING ABOUT THE HOSTED GATE MOVES. `byTheStudent` is set here, in
  // the browser, and nowhere in the connector; over the wire
  // `remove_course` still requires `user_explicitly_asked` and
  // `student_words`, still rejects model narration, and still echoes the
  // quote. What the student is told BEFORE this — `needsConsent` on the
  // tab — is the warning, and it stays.
  let applied = 0;
  const live: ToolContext = {
    ...ctx,
    byTheStudent: true,
    store: {
      read: async () => ({ plan: live.plan!, rev: live.rev ?? 0, updatedAt: live.updatedAt ?? "" }),
      write: async (next: PlanDoc, baseRev: number) => {
        const outcome = await write(next, baseRev);
        if (outcome === "written") applied++;
        return outcome;
      },
    } satisfies PlanStore,
  };
  const real = await runChanges(live, candidate.changes);
  if ("refused" in real) {
    return { applied, of: total, refused: refusalFrom(real.refused as Record<string, unknown>) };
  }
  return { applied, of: total, refused: null };
}
