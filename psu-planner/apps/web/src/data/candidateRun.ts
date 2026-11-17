/** Converting a what-if that was stored as a list of changes (#69).
 *
 * A what-if is a copy of the Plan now (engine/candidates.ts). Before #69 it
 * was a list of changes, re-run against the Plan every time its tab was
 * opened, and students have some of those saved. This file turns one into
 * the copy it comes to, once, when the planner loads the Plan.
 *
 * IT DOES NOT APPLY THE CHANGES ITSELF. It imports `runChanges` from
 * `packages/mcp/src/sandbox.ts`, the one place an ordered list of changes
 * is applied, and hands it a context built over the planner's state: the
 * copy a student is left with is the plan their assistant was shown when
 * it proposed the what-if.
 *
 * LOADED LAZILY, AND THAT IS NOT AN OPTIMISATION. The connector's mutation
 * surface is ~12 KB gzipped, and a student with no old what-ifs (which will
 * soon be every student) should never download it: the store imports this
 * only when it finds one. `e2e/boot-budget.spec.ts` holds a measured ceiling
 * on the planner's boot payload, and ADR 0002 says the answer is to fix the
 * payload rather than raise the number.
 */
import type {
  CandidateChange, Catalog, LegacyCandidate, PlanContents, PlanDoc, PlanItem, ProgramTemplate, ReqSection, Schedule,
} from "@psu-planner/engine";
import { buildItems, buildSchedule, contentsOf } from "@psu-planner/engine";
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
  // `loadCatalogFor` is memoised per subject.
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

/** Build the context the connector's tools work on, over the Plan the
 * planner is holding.
 *
 * `store` is null: the sandbox makes its own, and nothing here writes.
 * `rev` is the document's, which in the browser IS the held revision:
 * there is no column that can be ahead of it. */
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

/** The copy a what-if stored as changes comes to, against the Plan as it
 * stands: its contents, or `null` where a change can no longer be made.
 *
 * NO PARTIAL COPY. A what-if that got through three of its five changes is
 * a plan nobody asked for; the caller is told there is none and decides
 * what the student keeps (a copy of their Plan under the what-if's name,
 * and a sentence saying so).
 *
 * THROWS if the catalog will not load. That is not a verdict about the
 * what-if, and the caller must not treat it as one. */
export async function convertLegacyCandidate(
  snap: PlannerSnapshot,
  candidate: LegacyCandidate,
): Promise<PlanContents | null> {
  const { runChanges, sandbox } = await import("@connector/sandbox.js");
  const ctx = await contextFor(snap, candidate.changes);
  const run = await runChanges(sandbox(ctx), candidate.changes);
  if ("refused" in run) return null;
  return contentsOf(run.after.plan!);
}
