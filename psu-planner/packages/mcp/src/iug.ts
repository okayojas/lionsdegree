/** Integrated Undergraduate-Graduate degrees, for the connector.
 *
 * An IUG is a bachelor's and a master's taken as one programme, with
 * some coursework counting toward both under GCAC-210. The planner has
 * been able to attach one since 2026-07-19 (DECISIONS.md 4.1); the
 * connector could not, because the catalog it ships carried no `iug/`
 * at all. #48 is that data plus the three tools over it.
 *
 * WHY THIS IS ITS OWN FILE. Everything here is shared by a read tool in
 * `tools.ts` and two writes in `mutations.ts`, and those two modules can
 * only import in one direction. Putting the shared half in either of
 * them would either make the other restate it or create a cycle, and a
 * restated copy of the policy-quoting rule below is the one thing that
 * must not exist twice.
 *
 * THE RULE WORTH READING BEFORE EDITING THIS FILE: graduate policy text
 * is reproduced verbatim wherever it is quoted. Not summarised, not
 * truncated, not rewritten into the planner's own vocabulary — a student
 * checking a citation against the Graduate Bulletin has to find the same
 * words (CONTEXT.md). That is why `admissionText` does no formatting of
 * any kind, and why the Bulletin URL travels beside it: a quote nobody
 * can check is not a citation.
 */
import { fenceCatalogText, type IugSpec, type PlanDoc } from "@psu-planner/engine";
import type { IugIndexEntry } from "./catalog.js";

/** The Bulletin's own admission paragraph for one IUG, ready to hand to
 * a model, or undefined when the scrape found none.
 *
 * FENCED, NOT CLEANED. The fence marks it as data so a model does not
 * read Penn State's prose as instruction (DECISIONS.md 5.0 S4), and
 * `fenceCatalogText` strips only the fence marker itself — every other
 * byte, including the Bulletin's own "semester", survives exactly as
 * published. Trimming whitespace or collapsing the paragraph here would
 * be a quiet paraphrase, and the first student to paste a sentence of it
 * into the Bulletin's search box would find nothing.
 */
export function admissionText(spec: IugSpec): string | undefined {
  return spec.applyText ? fenceCatalogText(spec.applyText) : undefined;
}

/** What the connector says about IUG admission in its OWN voice.
 *
 * Deliberately separate from `admissionText`, and deliberately not
 * fenced: marking our own words untrusted teaches a model to discount
 * them (DECISIONS.md 5.1). It keeps the Bulletin's "semester" because it
 * is reporting what GCAC-210 says, and a reader checking the citation
 * must find the same word there (CONTEXT.md).
 */
export const GCAC_210_GATE =
  "IUG admission under GCAC-210: apply after entrance to major and 60 credits, and no later " +
  "than the second week of the semester before the bachelor's degree is conferred. We cannot " +
  "see whether the student has been admitted — attaching an IUG here plans it, it does not " +
  "apply for it.";

/** Does this IUG pair with one of the Plan's own Programs?
 *
 * The index publishes the bachelor's slugs each IUG is written against,
 * so this is a catalog fact rather than a guess from the programme name.
 * A name match would pair "Engineering Science and Mechanics" with any
 * engineering major, which is how a student ends up planning a master's
 * their department does not offer them. */
export function pairsWithPlan(entry: IugIndexEntry, plan: PlanDoc): boolean {
  return entry.pairsWith.some((slug) => plan.programs.includes(slug));
}

/** Every Course code an attach touches, so their subject files can be
 * read before the graduate half is folded on.
 *
 * Without this the graduate courses stay as audit rows, which carry no
 * prerequisite structure -- so every one of them evaluates as "cannot
 * be checked" and the plan the student is shown says nothing about
 * whether their graduate schedule is legal. See the call site in
 * `mutations.ts` for the measured effect.
 *
 * The same expression the planner's `attachIugNow` uses, for the same
 * reason the catalog has one loader: two ideas about which courses an
 * attach touches would drift, and the drift would show up as the two
 * surfaces double-counting different credits. */
export function attachCodes(spec: IugSpec): string[] {
  return [
    ...spec.doubleCount.eligible,
    ...spec.gradTracks.flatMap((t) =>
      t.sections.flatMap((s) =>
        s.rules.flatMap((r) =>
          r.type === "course" ? [r.code] : "options" in r ? r.options : [],
        ),
      ),
    ),
  ];
}

/** One row of the list a student chooses from. */
export interface IugListing {
  slug: string;
  name: string;
  grad_degree: string;
  college: string;
  campus: string;
  pairs_with: string[];
}

export const listing = (e: IugIndexEntry): IugListing => ({
  slug: e.slug,
  name: e.name,
  grad_degree: e.gradDegree,
  college: e.college,
  campus: e.campus,
  pairs_with: e.pairsWith,
});

/** The facts that decide between two IUGs, read from the programme
 * itself rather than the index.
 *
 * Only built for the ones that actually pair with the student's major —
 * the others are listed by name so a model can say "that one is for
 * Accounting", and reading three graduate requirement trees to answer a
 * question about one is cost nobody asked for. */
export function detail(spec: IugSpec, track: number): Record<string, unknown> {
  return {
    total_grad_credits: spec.gradTracks[track]?.totalCredits ?? spec.totalGradCredits,
    double_count: {
      max_credits: spec.doubleCount.maxCredits,
      at_least_half_at_500_or_800_level: spec.doubleCount.minHalfAt500Level,
      eligible_courses: spec.doubleCount.eligible,
    },
    // VERBATIM, and the link beside it. See the header comment: a
    // student checking this against the Graduate Bulletin must find the
    // same words, so nothing here reshapes the quote.
    admission_requirements: admissionText(spec),
    bulletin_url: spec.sourceUrl,
  };
}
