/** What-ifs as independent copies of a Plan (#69).
 *
 * A Candidate holds a full copy of a Plan's contents. From the moment it is
 * made, it and the Plan do not affect each other: nothing is replayed, and
 * nothing is recomputed from the other.
 *
 * ONE DOCUMENT STILL. The Plan and its what-ifs are stored together, the
 * Plan's contents at the top and each what-if's inside `candidates`, so that
 * they ride one sync, one compare-and-swap and one row (types.ts says why
 * they must not become rows of their own). What changes with the tab the
 * student has open is which contents are IN VIEW:
 *
 *   stored document  --viewOf-->  the document in view  --foldView-->  stored
 *
 * The document in view is an ordinary PlanDoc: the open what-if's contents
 * under the stored document's id and Revision. Everything that draws or
 * edits a plan is handed that and needs to know nothing about what-ifs.
 * `foldView` puts an edited view back where it came from, and leaves the
 * Plan's own contents exactly as they were.
 */
import type { Candidate, LegacyCandidate, PlanContents, PlanDoc } from "./types.js";

/** The contents of a document: everything but its identity, its Revision
 * and the what-ifs held beside it. A copy, sharing nothing with `doc`. */
export function contentsOf(doc: PlanDoc | PlanContents): PlanContents {
  const { id: _id, rev: _rev, updatedAt: _updatedAt, candidates: _candidates, ...contents } = doc as PlanDoc;
  return structuredClone(contents);
}

/** A what-if stored the old way, as a list of changes to replay. It is read
 * once and converted (the planner does that when it loads the Plan). */
export function isLegacyCandidate(c: Candidate | LegacyCandidate): c is LegacyCandidate {
  return !("plan" in c) || !c.plan;
}

/** The what-ifs of a document that are copies, which is all of them once
 * the planner has converted any stored the old way. */
export function candidatesOf(doc: PlanDoc | null | undefined): Candidate[] {
  return ((doc?.candidates ?? []) as (Candidate | LegacyCandidate)[]).filter((c): c is Candidate => !isLegacyCandidate(c));
}

/** The document to draw and edit while the what-if `candidateId` is open:
 * its contents, under the stored document's identity and Revision. `null`
 * if there is no such what-if (or it has not been converted yet). */
export function viewOf(stored: PlanDoc, candidateId: string): PlanDoc | null {
  const candidate = candidatesOf(stored).find((c) => c.id === candidateId);
  if (!candidate) return null;
  return {
    ...contentsOf(candidate.plan),
    id: stored.id,
    rev: stored.rev,
    updatedAt: stored.updatedAt,
    candidates: structuredClone(stored.candidates),
  };
}

/** Put a document in view back into the stored document.
 *
 * `home` is the Plan's own contents, which the view does not carry: they
 * come back exactly as they went. The view's contents become the open
 * what-if's. Its Revision, and its list of what-ifs (one may have been
 * renamed or deleted while this one was open), are the stored document's. */
export function foldView(view: PlanDoc, candidateId: string, home: PlanContents): PlanDoc {
  const contents = contentsOf(view);
  return {
    ...structuredClone(home),
    id: view.id,
    rev: view.rev,
    updatedAt: view.updatedAt,
    candidates: ((view.candidates ?? []) as Candidate[]).map((c) =>
      c.id === candidateId ? { ...structuredClone(c), plan: contents } : structuredClone(c),
    ),
  };
}

/** A new what-if: a copy of `contents`, named. */
export function makeCandidate(id: string, name: string, contents: PlanDoc | PlanContents, now: string): Candidate {
  return { id, name, plan: contentsOf(contents), createdAt: now };
}

/** The longest a what-if's name may be. */
export const CANDIDATE_NAME_MAX = 40;

/** A name cut to fit a tab, for a what-if named after something longer
 * (a Program: "Mechanical Engineering, B.S. (Engineering)" is 42).
 *
 * A trailing note in brackets goes first, since it is the part a reader
 * can spare; then whole words from the end. Never mid-word: "(Engineerin"
 * reads as a mistake. */
export function nameThatFits(name: string): string {
  let fit = name.trim();
  if (fit.length > CANDIDATE_NAME_MAX) fit = fit.replace(/\s*\([^()]*\)\s*$/, "");
  while (fit.length > CANDIDATE_NAME_MAX && fit.includes(" ")) fit = fit.slice(0, fit.lastIndexOf(" "));
  return fit.slice(0, CANDIDATE_NAME_MAX).replace(/[\s,;:(]+$/, "");
}

/** What the Plan is called once a what-if has taken its place: "My plan
 * before <the what-if's name>", cut to fit, and numbered if that name is
 * taken. */
export function nameForReplacedPlan(keptName: string, taken: readonly string[]): string {
  const has = (name: string) => taken.some((t) => t.trim().toLowerCase() === name.toLowerCase());
  const lead = "My plan before ";
  const base = (lead + keptName).slice(0, CANDIDATE_NAME_MAX).trimEnd();
  if (!has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const tail = ` (${n})`;
    const name = base.slice(0, CANDIDATE_NAME_MAX - tail.length).trimEnd() + tail;
    if (!has(name)) return name;
  }
  return base;
}

/** Keep a what-if: it becomes the Plan, and the Plan it replaces becomes a
 * what-if in its place.
 *
 * A SWAP, so that one click destroys nothing: the student who kept the wrong
 * one keeps the other and is back where they were. The number of what-ifs
 * does not change, so keeping never meets the limit. The Revision is not
 * advanced here; the caller writes the result as it writes any edit.
 *
 * `null` if the document holds no such what-if. */
export function keepCandidate(stored: PlanDoc, candidateId: string, replacedId: string, now: string): PlanDoc | null {
  const all = candidatesOf(stored);
  const kept = all.find((c) => c.id === candidateId);
  if (!kept) return null;
  const others = all.filter((c) => c.id !== candidateId);
  const replaced = makeCandidate(
    replacedId,
    nameForReplacedPlan(kept.name, others.map((c) => c.name)),
    stored,
    now,
  );
  return {
    ...contentsOf(kept.plan),
    id: stored.id,
    rev: stored.rev,
    updatedAt: stored.updatedAt,
    // Where the kept one was, so the tabs do not move under the student.
    candidates: all.map((c) => (c.id === candidateId ? replaced : structuredClone(c))),
  };
}
