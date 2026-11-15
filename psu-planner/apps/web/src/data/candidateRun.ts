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
   * Saving a what-if needs no consent — looking at an option is not taking
   * it — but KEEPING one is a real removal, and the planner will not do
   * that from a tab. Surfaced so the student is told before they choose,
   * rather than at the last step. */
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
  if (dry.needsConsent.length) {
    // THE ONE THING A TAB MAY NOT DO. Taking a required Course or a whole
    // Program out of a degree needs the student to ask for it in their own
    // words — a button on a what-if is not that, and relaxing the gate for
    // a tab would relax it for everything.
    return {
      applied: 0,
      of: total,
      refused: {
        reason:
          `Keeping this would take ${dry.needsConsent.join(", ")} out of your degree, and a ` +
          "what-if tab cannot do that.",
        nothingChanged:
          "Your plan has not been changed. Remove it from the course itself if that is what you want.",
        position: null,
      },
    };
  }

  // THE REAL PATH, with a real store behind it. The context is NOT marked
  // `simulating`, so the consent gate stands exactly as it does for any
  // other write — which is why the check above had to come first.
  let applied = 0;
  const live: ToolContext = {
    ...ctx,
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
