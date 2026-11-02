/** Courses the student has ALREADY taken — AP, transfer, a summer course,
 * a term before they started planning.
 *
 * WHY THIS IS NOT ITS OWN STORE. Prior credit IS completion: `plan.completed`
 * is the one place a Plan records "this is behind me", and the planner has
 * recorded it there since the first spreadsheet import. A second list would
 * be a second answer to "what do I still need", and the two would disagree
 * the first time either side changed — so everything here is the planner's
 * own `markCompleted`/`bulkComplete` behaviour (apps/web/src/store.ts),
 * reached from a tool call instead of a checkbox.
 *
 * Three things that behaviour does, each of which matters here:
 *
 *   1. It clears the cards the Course satisfies, not just the card with the
 *      same code — an ALTERNATIVE the Template offered ("CMPSC 121 or 131"),
 *      and a card the Course COVERS (took MATH 251, the Program lists MATH
 *      250). Clearing only the exact code leaves the student looking at a
 *      schedule that still tells them to take what they have passed.
 *   2. It takes the card out of the Terms, so the Plan stops scheduling it.
 *   3. It leaves the audit to coverage, which already knows MATH 251
 *      satisfies MATH 250 — this module never invents a satisfaction.
 *
 * WHAT IT ADDS, and the failure that forced it: the planner's un-mark re-adds
 * the course itself and nothing else, because in the planner you un-tick a
 * card that is still on your chart. Here the student is correcting a CLAIM,
 * and the card the claim cleared may have been a graduation requirement that
 * nothing in this tree can rebuild — the Terms come from a Program's
 * published grid, generated once, and the connector does not carry the grids.
 * So recording keeps a note of exactly what it took (`clearedByPriorCredit`)
 * and un-recording puts that back.
 */
import type { Catalog, ClearedByPriorCredit, PlanDoc, PlanItemSpec } from "@psu-planner/engine";

/** The Course codes a call is about.
 *
 * BOTH SPELLINGS, because the tool is named in the singular and every other
 * mutation on this server takes `code` — a model reaching for the habit it
 * has from `add_course` would otherwise be told "no courses named" and
 * retry the same shape. Several in one call is the point of `codes`: a
 * student listing four AP exams must not cost four round trips and four
 * revisions (DECISIONS.md 4.1, rule 3).
 *
 * Upper-cased and de-duplicated, so "math 231" and "MATH 231" are one claim
 * about one Course rather than two. */
export function priorCourseCodes(args: Record<string, unknown>): string[] {
  const raw: unknown[] = [];
  if (Array.isArray(args.codes)) raw.push(...args.codes);
  else if (typeof args.codes === "string") raw.push(args.codes);
  if (typeof args.code === "string") raw.push(args.code);

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const code = entry.trim().toUpperCase();
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/** The codes this Edition's Bulletin does not carry.
 *
 * IRON RULE 2, and the reason recording is all-or-nothing above this: a
 * Course we cannot verify, recorded as passed, removes a real requirement
 * from a real student's audit on nothing but a model's spelling. "I could
 * not find that one" costs a message; the other costs a semester. */
export function notInBulletin(codes: readonly string[], catalog: Catalog): string[] {
  return codes.filter((c) => !catalog[c]);
}

/** The codes that are not currently recorded as taken.
 *
 * Checked so un-recording cannot report that it undid something it never
 * did -- a model told "ok" for MATH 141 it never recorded will tell the
 * student their schedule changed when it did not. Deliberately NOT a
 * Bulletin check: a Plan can carry a completed Course this Edition no
 * longer publishes (an older import), and refusing to un-record it would
 * strand the claim forever. */
export function notRecorded(plan: PlanDoc, codes: readonly string[]): string[] {
  return codes.filter((c) => !plan.completed[c]);
}

const emptyClearing = (): ClearedByPriorCredit => ({ items: [], added: [], slotFills: {}, moves: {} });

/** Does `card` stop being needed because `code` was passed?
 *
 * The planner's own test, kept identical on purpose (store.ts,
 * `clearSatisfiedCards`): the same card, a card this Course was offered as
 * an ALTERNATIVE to, or a card whose content this Course COVERS. Coverage is
 * directional — `coveredBy["MATH 250"]` lists the Courses that cover MATH
 * 250 — and reading it the other way round would clear MATH 251 for a
 * student who took MATH 250, which is a requirement dropped on a Course that
 * does not satisfy it. */
function satisfies(
  code: string,
  cardCode: string,
  alternatives: string[] | undefined,
  coveredBy: Record<string, string[]>,
): boolean {
  return (
    cardCode === code ||
    (alternatives ?? []).includes(code) ||
    (coveredBy[cardCode] ?? []).includes(code)
  );
}

export interface RecordResult {
  /** Codes newly written into `plan.completed`. */
  recorded: string[];
  /** Codes that were already recorded, so this call changed nothing for them. */
  alreadyRecorded: string[];
  /** Course codes that left the Terms as a result, in the order they were cleared. */
  noLongerScheduled: string[];
}

/** Record `codes` as already taken, and clear what they satisfy.
 *
 * Mutates `plan` in place; `mutations.ts` calls it on the copy `commit`
 * made, so a throw halfway cannot leave a half-recorded Plan behind. */
export function recordPriorCredit(
  plan: PlanDoc,
  codes: readonly string[],
  coveredBy: Record<string, string[]>,
): RecordResult {
  const result: RecordResult = { recorded: [], alreadyRecorded: [], noLongerScheduled: [] };

  for (const code of codes) {
    if (plan.completed[code]) result.alreadyRecorded.push(code);
    else result.recorded.push(code);
    plan.completed[code] = true;

    const cleared = emptyClearing();
    const takeMove = (id: string) => {
      if (id in plan.moves) {
        cleared.moves[id] = plan.moves[id];
        delete plan.moves[id];
      }
    };

    for (let term = 0; term < plan.terms.length; term++) {
      const keep: PlanItemSpec[] = [];
      for (const item of plan.terms[term].items) {
        if ("code" in item && satisfies(code, item.code, item.alternatives, coveredBy)) {
          cleared.items.push({ term, spec: item });
          result.noLongerScheduled.push(item.code);
          // Item ids ARE the course code for a course card, so a manual
          // drag of this card has to come off with it — a `moves` entry
          // pointing at a card that is no longer in any Term would send
          // the restored card to that term rather than to its Template
          // position.
          takeMove(item.code);
          continue;
        }
        keep.push(item);
      }
      plan.terms[term].items = keep;
    }

    plan.added = plan.added.filter((a) => {
      if (!satisfies(code, a.code, undefined, coveredBy)) return true;
      cleared.added.push(a);
      return false;
    });
    takeMove(code);
    takeMove(`add-${code}`);

    // A Slot the student had CHOSEN this Course for. The fill goes, and so
    // does the Slot card: leaving the card would show the requirement as
    // still open when the Course that answered it is passed, and leaving
    // the fill would schedule the Course again under a Slot's id.
    for (const [slotId, fill] of Object.entries(plan.slotFills)) {
      if (fill !== code) continue;
      cleared.slotFills[slotId] = fill;
      delete plan.slotFills[slotId];
      takeMove(slotId);
      for (let term = 0; term < plan.terms.length; term++) {
        const keep: PlanItemSpec[] = [];
        for (const item of plan.terms[term].items) {
          if ("slot" in item && item.id === slotId) cleared.items.push({ term, spec: item });
          else keep.push(item);
        }
        plan.terms[term].items = keep;
      }
    }

    // STORED EVEN WHEN EMPTY, and the emptiness is the information. A
    // Course that cleared nothing (a free elective already passed) must
    // un-record to nothing; the absence of a note means something else
    // recorded this Course and we do not know what it took.
    plan.clearedByPriorCredit = { ...(plan.clearedByPriorCredit ?? {}), [code]: cleared };
  }

  return result;
}

export interface UnrecordResult {
  /** Codes no longer recorded as taken. */
  noLongerRecorded: string[];
  /** Course codes put back into the Terms. */
  restored: string[];
  /** Codes we had no note for, so the Course itself was put back instead. */
  restoredBlind: string[];
}

/** Un-record `codes` and put back whatever recording them took away. */
export function unrecordPriorCredit(plan: PlanDoc, codes: readonly string[]): UnrecordResult {
  const result: UnrecordResult = { noLongerRecorded: [], restored: [], restoredBlind: [] };

  for (const code of codes) {
    delete plan.completed[code];
    result.noLongerRecorded.push(code);

    const note = plan.clearedByPriorCredit?.[code];
    if (!note) {
      // NO NOTE MEANS SOMEBODY ELSE RECORDED IT — the planner's own
      // checkbox, or a spreadsheet import, both of which predate this
      // tool. We cannot know which card it cleared, and the student is
      // now short a Course they have not taken, so it goes back on the
      // chart the way the planner's own un-mark does it. Without this the
      // Course would be neither passed nor scheduled, which is a
      // requirement quietly deleted.
      const scheduled = plan.terms.some((t) => t.items.some((i) => "code" in i && i.code === code));
      if (!scheduled && !plan.added.some((a) => a.code === code)) {
        plan.added.push({ code, sem: 0 });
        result.restoredBlind.push(code);
      }
      continue;
    }

    for (const { term, spec } of note.items) {
      if (present(plan, spec)) continue;
      // Clamped rather than dropped: the Plan may have fewer Terms than it
      // had when this was recorded (an optimize since then), and a card
      // restored into a term that no longer exists is a card the student
      // never sees again. The optimizer re-flows it from here anyway.
      if (!plan.terms.length) plan.terms.push({ label: "", items: [] });
      const at = Math.min(term, plan.terms.length - 1);
      plan.terms[at].items.push(structuredClone(spec));
      if ("code" in spec) result.restored.push(spec.code);
    }
    for (const entry of note.added) {
      if (!plan.added.some((a) => a.code === entry.code)) {
        plan.added.push({ ...entry });
        result.restored.push(entry.code);
      }
    }
    for (const [slotId, fill] of Object.entries(note.slotFills)) {
      // Only if the Slot is still unanswered. The student may have filled
      // it with something else since, and overwriting that choice would be
      // this tool deciding which Course satisfies their requirement.
      if (!(slotId in plan.slotFills)) plan.slotFills[slotId] = fill;
    }
    for (const [id, term] of Object.entries(note.moves)) {
      // A move made SINCE wins: it is the student's more recent word about
      // where that card goes.
      if (!(id in plan.moves)) plan.moves[id] = term;
    }

    delete plan.clearedByPriorCredit![code];
  }

  return result;
}

/** Is this spec already in the Plan's Terms? Restoring a duplicate would
 * show the student two cards for one requirement and count its credits
 * twice. */
function present(plan: PlanDoc, spec: PlanItemSpec): boolean {
  return plan.terms.some((t) =>
    t.items.some((i) =>
      "code" in spec ? "code" in i && i.code === spec.code : "slot" in i && i.id === spec.id,
    ),
  );
}
