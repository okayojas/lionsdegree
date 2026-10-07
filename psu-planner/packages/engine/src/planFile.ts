/** The Plan file: a portable artifact the student owns.
 *
 * This is the boundary between the web app and anything else that works on
 * the same degree, so the shape is a contract. It lives in the engine rather
 * than in the app because both sides of that boundary need the same reader,
 * and two readers would be two ideas of what a valid plan is.
 *
 * Every failure here REFUSES. A plan read against the wrong bulletin Edition
 * silently re-plans a student's degree against requirements that do not
 * govern them, and a half-applied plan is harder to notice than a rejected
 * one. */
import type { PlanDoc } from "./types.js";

export const PLAN_FILE_FORMAT = "lionsdegree.plan";
export const PLAN_FILE_VERSION = 1;

export interface PlanFile {
  format: typeof PLAN_FILE_FORMAT;
  formatVersion: number;
  plan: PlanDoc;
}

export type PlanFileResult =
  | { ok: true; plan: PlanDoc }
  /** No partial plan is returned with a failure, deliberately: a caller that
   * destructures the result cannot half-apply something that did not parse. */
  | { ok: false; reason: string };

/** Serialize a Plan, and nothing else.
 *
 * No timestamp, no device, no identifiers. A plan is coursework; the file
 * should not quietly become a record of when or where a student worked on it.
 * Indented because a student may well open it. */
export function exportPlanFile(plan: PlanDoc): string {
  const doc: PlanFile = { format: PLAN_FILE_FORMAT, formatVersion: PLAN_FILE_VERSION, plan };
  return JSON.stringify(doc, null, 2);
}

/** A sensible default filename. */
export function planFileName(plan: PlanDoc): string {
  const slug = (plan.programs[0] ?? "plan").replace(/[^a-z0-9-]+/gi, "-").slice(0, 40);
  return `lionsdegree-${slug}.json`;
}

function isTerm(t: unknown): boolean {
  return !!t && typeof t === "object" && typeof (t as { label?: unknown }).label === "string" && Array.isArray((t as { items?: unknown }).items);
}

/**
 * Read a Plan file.
 *
 * `publishedEditions` is the list this installation can actually serve,
 * OLDEST FIRST. A plan naming an Edition outside it is refused rather than
 * read against a different one.
 */
export function parsePlanFile(text: string, publishedEditions: string[]): PlanFileResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // Deliberately not the parser's message: "Unexpected token } at position
    // 412" tells a student nothing they can act on.
    return { ok: false, reason: "That file could not be read as a LionsDegree plan file." };
  }

  const d = doc as Partial<PlanFile>;
  if (!d || typeof d !== "object" || d.format !== PLAN_FILE_FORMAT) {
    return { ok: false, reason: "That is not a LionsDegree plan file." };
  }
  if (typeof d.formatVersion !== "number" || d.formatVersion > PLAN_FILE_VERSION) {
    // Guessing at a newer format is how a plan gets half-applied.
    return {
      ok: false,
      reason: "That plan file was written by a newer version of LionsDegree. Update, then try again.",
    };
  }

  const plan = d.plan as Partial<PlanDoc> | undefined;
  if (!plan || typeof plan !== "object") {
    return { ok: false, reason: "That plan file has no plan in it." };
  }
  for (const [field, ok] of [
    ["id", typeof plan.id === "string" && !!plan.id],
    ["programs", Array.isArray(plan.programs) && plan.programs.every((p) => typeof p === "string")],
    ["terms", Array.isArray(plan.terms)],
  ] as const) {
    if (!ok) return { ok: false, reason: `That plan file is missing its ${field}, so it can't be opened.` };
  }
  if (!plan.terms!.every(isTerm)) {
    return { ok: false, reason: "That plan file has a term in it that isn't a term, so it can't be opened." };
  }

  // A plan saved before Editions existed was generated against the oldest we
  // publish, which is what it is read as.
  const edition = plan.edition ?? publishedEditions[0];
  if (!publishedEditions.includes(edition)) {
    return {
      ok: false,
      reason:
        `That plan follows the ${edition} bulletin, which this copy of LionsDegree doesn't have. ` +
        `It has ${publishedEditions.join(" and ")}. Opening it against a different bulletin would ` +
        `change which requirements apply to you, so it hasn't been opened.`,
    };
  }

  const whole = plan as PlanDoc;
  return {
    ok: true,
    plan: {
      ...whole,
      edition,
      // Defaults come AFTER the spread: a hand-edited file that omits one of
      // these has the key absent, and spreading it last would set it to
      // undefined rather than leave the default standing.
      completed: whole.completed ?? {},
      moves: whole.moves ?? {},
      slotFills: whole.slotFills ?? {},
      added: whole.added ?? [],
      rev: whole.rev ?? 0,
      updatedAt: whole.updatedAt ?? new Date(0).toISOString(),
    },
  };
}
