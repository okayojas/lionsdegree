/** Adding and withdrawing a Program on an EXISTING Plan.
 *
 * `generatePlan` builds a Plan from scratch and is called exactly once, during
 * onboarding. That is the whole problem this module exists for: a student who
 * declares a minor in October had no way to add it except starting over, which
 * threw away every completed Course, every Course they added themselves, every
 * Slot they had filled and every Constraint they had set. "Generate again" is
 * not an answer when the generator's only input is the state it would destroy.
 *
 * So the merge is ADDITIVE and in place. It writes to exactly two things on the
 * Plan -- `programs`, and the `items` arrays of Terms that already exist -- and
 * reads everything else. Nothing here touches `completed`, `added`, `slotFills`,
 * `moves`, `constraints`, `summerYears`, `honors`, `iug`, `rev` or `edition`.
 * The Edition especially: a Plan is governed by the bulletin in force when the
 * student entered their major, so merging a Program reads the Plan's own pin
 * and never re-bases it (docs/adr/0001-forward-only-catalog-editions.md).
 *
 * Two rules do the real work:
 *
 *   - **Requirements fold into the Terms that are already there.** Appending the
 *     new Program's Template to the end would produce a Plan that schedules a
 *     minor's 100-level survey course after the capstone. A Template semester is
 *     mapped proportionally onto the Terms the Plan has left, which keeps the
 *     Program's own ordering without inventing calendar time the student did not
 *     ask for. The optimizer is still the last word on exact placement.
 *
 *   - **A Course two Programs require is ONE card, and its Origin names both.**
 *     Otherwise a double major's shared requirements are counted twice: the
 *     credit total inflates, the chart shows the same course in two Terms, and
 *     withdrawing either Program would strand or duplicate the other's work.
 *     Origin is what makes the count honest, which is why withdrawal reads it.
 */
import {
  codeMatchesPool,
  poolHasMembership,
  resolveSlotPool,
  type Registry,
  type ReqSection,
} from "./requirements.js";
import { normSlotLabel, type ProgramTemplate, type TemplateEntry } from "./planGen.js";
import type { Catalog, CourseSpec, ItemOrigin, PlanDoc, SlotSpec } from "./types.js";

/** Every Program whose Template requires an item, primary first.
 *
 * Reading `origin.program` alone was the bug this replaces: it answers "who put
 * this here", and withdrawal needs "who still needs this". A Course placed by a
 * major and later also required by a minor has one Origin and two Programs. */
export function originPrograms(origin: ItemOrigin | undefined): string[] {
  if (!origin) return [];
  const all = [origin.program, ...(origin.alsoPrograms ?? [])];
  return all.filter((p, i) => p && all.indexOf(p) === i);
}

export interface ProgramMergeOptions {
  /** DIRECTIONAL coverage mined from bulletin descriptions (MATH 250 ->
   * [MATH 251]): a completed covering Course satisfies the requirement for the
   * covered one, never the reverse. Same map `generatePlan` takes, so a merge
   * and a generation agree about what the student has already done. */
  coveredBy?: Record<string, string[]>;
  /** Department lists the bulletin names but does not contain. INJECTED, like
   * everywhere else in the engine, so this module reads no files. */
  registry?: Registry;
  /** Edition used ONLY to look up Edition-scoped Registry entries. Defaults to
   * the Plan's own pin and is NEVER written back: re-basing a continuing
   * student onto the newest bulletin is the exact failure ADR 0001 forbids. */
  edition?: string;
}

export interface AddProgramResult {
  program: string;
  /** True when the Program was already one of the Plan's: nothing was changed.
   * Reported rather than thrown, because asking twice is not an error. */
  alreadyPresent: boolean;
  /** Courses that became new cards in existing Terms. */
  coursesAdded: string[];
  /** Courses the Plan already places, now counted once with both Programs on
   * the Origin. The double major's honesty, in one list. */
  coursesShared: string[];
  /** Courses the new Program requires that the student had REMOVED. Brought
   * back, because a Plan silently missing a required Course is worse than an
   * unwanted card, and named so the student can remove it again if they meant
   * it. */
  coursesRestored: string[];
  /** Courses the new Program requires that the student has already completed.
   * Adding a minor must not reset two years of progress, so these are reported
   * rather than scheduled. */
  alreadyCompleted: string[];
  /** Labels of Slots added for requirements the Plan did not already carry. */
  slotsAdded: string[];
  /** Labels of the new Program's Slots that something already in the Plan
   * covers -- an existing Slot of the same kind, or a Course the Plan already
   * places that the requirement's Pool admits. */
  slotsCovered: string[];
  /** One sentence for the student. */
  note: string;
}

/** Slot budgeting key.
 *
 * General Education is deliberately ONE bucket rather than one per domain. The
 * framework, not a Program, decides which categories a student still owes, and
 * `refineGenEdSlots` re-labels and drops Slots against that audit on the next
 * pass. Keying gen eds by domain here would add a GH Slot next to a GS Slot the
 * audit is about to turn into a GH one, and the student would briefly be shown
 * two cards for one requirement. Elective Slots keep their normalized label,
 * which is what lets "Technical Elective (400-level)" and "Technical Electives"
 * share one budget across a double major. */
function slotBudgetKey(slot: string, label: string | undefined): string {
  return slot === "EL" ? "ph:" + normSlotLabel(label ?? "Elective") : "genEd";
}

function entryBudgetKey(e: TemplateEntry): string {
  return e.type === "genEd" ? "genEd" : "ph:" + normSlotLabel(e.label ?? "Elective");
}

function entryLabel(e: TemplateEntry): string {
  return e.label ?? (e.type === "genEd" ? "General Education" : "Elective");
}

/** Record `slug` on an item's Origin without losing who put it there.
 * Returns true when this was new information. */
function recordOrigin(spec: CourseSpec, slug: string, templateSem: number): boolean {
  if (!spec.origin) {
    // A Course the optimizer folded in from `added` has no Origin: it was the
    // student's own, not a Template's. A Program's Template now requires it, so
    // it IS template-placed -- which also makes it count as bulletin-endorsed
    // in the gen-ed audit, where `!!origin` is the endorsement test.
    spec.origin = { program: slug, templateSem };
    return true;
  }
  if (originPrograms(spec.origin).includes(slug)) return false;
  spec.origin.alsoPrograms = [...(spec.origin.alsoPrograms ?? []), slug];
  return true;
}

/** Merge a Program's Template into an existing Plan.
 *
 * Mutates `plan` in place, as `attachIug` and `optimizeSchedule` already do, and
 * returns an account of what happened. The caller is responsible for advancing
 * the Revision and for re-optimizing: this function places requirements into
 * Terms, it does not re-flow the schedule. */
export function addProgram(
  plan: PlanDoc,
  template: ProgramTemplate,
  opts: ProgramMergeOptions = {},
): AddProgramResult {
  const result: AddProgramResult = {
    program: template.slug,
    alreadyPresent: false,
    coursesAdded: [],
    coursesShared: [],
    coursesRestored: [],
    alreadyCompleted: [],
    slotsAdded: [],
    slotsCovered: [],
    note: "",
  };
  if (plan.programs.includes(template.slug)) {
    result.alreadyPresent = true;
    result.note = `${template.name} is already one of your programs — nothing changed.`;
    return result;
  }

  const coveredBy = opts.coveredBy ?? {};
  const completedSet = new Set(Object.keys(plan.completed).filter((c) => plan.completed[c]));
  // Same satisfaction test `generatePlan` uses, so a Course that would never
  // have been scheduled for a fresh Plan is not scheduled for a merged one
  // either: a listed alternative, a covering Course (MATH 251 covers MATH 250,
  // one way only), or the honors twin (MATH 140H satisfies MATH 140).
  const doneAlready = (code: string): boolean =>
    completedSet.has(code) ||
    (coveredBy[code] ?? []).some((sup) => completedSet.has(sup)) ||
    completedSet.has(code + "H") ||
    completedSet.has(code + "M");

  // Everything the Plan already places, by code. Terms first (those carry the
  // Origin we may have to extend), then the student's own additions and Slot
  // fills -- which are NOT given an Origin, because they came from the student
  // rather than from any Program's Template.
  const onChart = new Map<string, { spec: CourseSpec; term: number }>();
  plan.terms.forEach((t, i) => {
    for (const it of t.items) if (!("slot" in it) && !onChart.has(it.code)) onChart.set(it.code, { spec: it, term: i });
  });
  const studentCodes = new Set<string>([...plan.added.map((a) => a.code), ...Object.values(plan.slotFills)]);

  // Undergraduate Terms only. An IUG's graduate Terms are a fixed,
  // adviser-approved sequence; dropping a bachelor's requirement into one would
  // put an undergraduate course in a master's term and the optimizer, which
  // preserves grad terms verbatim, would never move it back out.
  let undergrad = plan.terms.map((t, i) => (t.phase !== "grad" ? i : -1)).filter((i) => i >= 0);
  if (!undergrad.length) {
    plan.terms.unshift({ label: plan.terms[0]?.label ?? "", items: [] });
    undergrad = [0];
  }
  const termCount = undergrad.length;

  // Origins across a Plan share one index space (see ItemOrigin), and a
  // major-switcher's Plan can start part-way through its Template -- so new
  // Origins are offset by the lowest one already present. Anchoring at 0
  // instead would make every merged Course look earlier in the flow than the
  // Courses the student is actually taking next, and the optimizer would pull a
  // minor's electives in front of the major's spine.
  let baseSem = Number.POSITIVE_INFINITY;
  for (const t of plan.terms) {
    for (const it of t.items) {
      if (!("slot" in it) && it.origin) baseSem = Math.min(baseSem, it.origin.templateSem);
    }
  }
  if (!Number.isFinite(baseSem)) baseSem = 0;

  /** Template semester -> position among the Terms the Plan has left.
   * Proportional, so a four-semester minor spreads across six remaining Terms
   * in its own order rather than piling into the next one. */
  const spanCount = Math.max(1, template.semesters.length);
  const slotOf = (si: number): number =>
    Math.min(termCount - 1, Math.max(0, Math.floor((si * termCount) / spanCount)));

  const usedSlotIds = new Set<string>();
  for (const t of plan.terms) for (const it of t.items) if ("slot" in it) usedSlotIds.add(it.id);
  let seq = 0;
  const freshSlotId = (slot: string): string => {
    let id = `${slot}-${template.slug}-${seq++}`;
    while (usedSlotIds.has(id)) id = `${slot}-${template.slug}-${seq++}`;
    usedSlotIds.add(id);
    return id;
  };

  const placed = new Set<string>();
  const addCourse = (e: { code: string; alternatives?: string[]; unverified?: boolean }, pos: number) => {
    const spec: CourseSpec = {
      code: e.code,
      alternatives: e.alternatives ?? [],
      unverified: e.unverified,
      origin: { program: template.slug, templateSem: baseSem + pos },
    };
    plan.terms[undergrad[pos]].items.push(spec);
    onChart.set(e.code, { spec, term: undergrad[pos] });
    placed.add(e.code);
    result.coursesAdded.push(e.code);
  };

  /** A Course the student removed, which the new Program requires. */
  const unRemove = (code: string): void => {
    if (!plan.removed?.[code]) return;
    delete plan.removed[code];
    if (plan.removedSpecs) delete plan.removedSpecs[code];
    result.coursesRestored.push(code);
  };

  /** Fold one Template course entry in. Returns nothing; records into result. */
  const foldCourse = (code: string, alternatives: string[] | undefined, unverified: boolean | undefined, pos: number) => {
    if (placed.has(code)) return;
    const codes = [code, ...(alternatives ?? [])];
    if (codes.some(doneAlready)) {
      result.alreadyCompleted.push(code);
      placed.add(code);
      return;
    }
    const hit = codes.map((c) => onChart.get(c)).find((x) => !!x);
    if (hit) {
      // ONE card, two Programs. The Origin is extended rather than replaced, so
      // withdrawing either Program later can still tell whether anything else
      // needs this Course.
      recordOrigin(hit.spec, template.slug, baseSem + hit.term);
      unRemove(hit.spec.code);
      result.coursesShared.push(hit.spec.code);
      placed.add(code);
      return;
    }
    // The student's own Course, or one they chose for a Slot, already covers
    // this. It stays exactly as it is -- promoting it into a Template card
    // would rewrite the student's work as the Program's.
    const mine = codes.find((c) => studentCodes.has(c));
    if (mine) {
      result.coursesShared.push(mine);
      placed.add(code);
      return;
    }
    // Removed, and the card itself already gone (a re-optimize rebuilt the
    // Terms without it). Put the preserved spec back rather than minting a new
    // one: it carries the alternatives and the position it was removed from.
    const revived = codes.map((c) => plan.removedSpecs?.[c]).find((x) => !!x);
    if (revived) {
      const spec = structuredClone(revived);
      recordOrigin(spec, template.slug, baseSem + pos);
      plan.terms[undergrad[pos]].items.push(spec);
      onChart.set(spec.code, { spec, term: undergrad[pos] });
      placed.add(code);
      unRemove(spec.code);
      return;
    }
    unRemove(code);
    addCourse({ code, alternatives, unverified }, pos);
  };

  // ---- Pass 1: the Template's courses, in its own order --------------------
  template.semesters.forEach((sem, si) => {
    const pos = slotOf(si);
    for (const e of sem.entries) {
      if (e.type !== "course" || !e.code) continue;
      foldCourse(e.code, e.alternatives, e.unverified, pos);
    }
  });

  // ---- Pass 2: Slots, MAX of the two Programs rather than the sum ----------
  // Gen eds and electives are university-wide requirements, not per-Program
  // ones. A double major owes the larger of the two Programs' Slot counts, not
  // both added together -- adding the sum is how a student ends up being told
  // they need sixteen gen eds.
  const have = new Map<string, number>();
  for (const t of plan.terms) {
    for (const it of t.items) {
      if (!("slot" in it)) continue;
      if (plan.removed?.[it.id]) continue; // a removed Slot stands for nothing
      const k = slotBudgetKey(it.slot, it.label);
      have.set(k, (have.get(k) ?? 0) + 1);
    }
  }
  // Courses the Plan already places, available once each to absorb one of the
  // new Program's elective Slots -- the same cross-program fulfillment
  // `generatePlan` does for a double major, applied to a late-declared Program.
  const consumed = new Set<string>();
  const poolCandidates = [...onChart.keys(), ...studentCodes, ...completedSet];
  const edition = opts.edition ?? plan.edition;
  const absorbedBy = (label: string): string | null => {
    if (!template.requirements?.length) return null;
    const pool = resolveSlotPool(label, template.requirements, {
      programSlug: template.slug,
      edition,
      registry: opts.registry,
    });
    // Only a Pool with testable membership can absorb a Course: a gen-ed Pool
    // is answered by the gen-ed audit, and an adviser or unreadable Pool has
    // nothing to test. Guessing either way would be the confident wrong answer.
    if (!poolHasMembership(pool)) return null;
    for (const code of poolCandidates) {
      if (consumed.has(code)) continue;
      if (codeMatchesPool(code, pool)) {
        consumed.add(code);
        return code;
      }
    }
    return null;
  };

  const wanted = new Map<string, { entry: TemplateEntry; pos: number }[]>();
  template.semesters.forEach((sem, si) => {
    const pos = slotOf(si);
    for (const e of sem.entries) {
      if (e.type === "course") continue;
      const k = entryBudgetKey(e);
      const list = wanted.get(k) ?? [];
      list.push({ entry: e, pos });
      wanted.set(k, list);
    }
  });
  for (const [k, list] of wanted) {
    const already = have.get(k) ?? 0;
    list.forEach(({ entry, pos }, i) => {
      if (i < already) {
        result.slotsCovered.push(entryLabel(entry));
        return;
      }
      if (entry.type === "placeholder" && entry.label && absorbedBy(entry.label)) {
        result.slotsCovered.push(entry.label);
        return;
      }
      pushSlot(entry.type === "genEd" ? entry.domain ?? "GE" : "EL", entryLabel(entry), entry.credits, pos);
    });
  }

  function pushSlot(slot: string, label: string, credits: number | null, pos: number): void {
    const spec: SlotSpec = {
      slot,
      id: freshSlotId(slot),
      credits,
      label,
      program: template.slug,
      origin: { program: template.slug, templateSem: baseSem + pos },
    };
    plan.terms[undergrad[pos]].items.push(spec);
    result.slotsAdded.push(label);
  }

  // ---- Pass 3: a Program with no suggested-plan grid -----------------------
  // Most minors and certificates publish requirements but no semester-by-
  // semester grid, which is exactly the Program a student declares late. Their
  // requirements still shape the Plan: prescribed Courses get scheduled, choice
  // groups assume overlap with what is already planned and only add the
  // shortfall, and that shortfall becomes labeled Slots in the back half -- so a
  // minor does not land on top of next Term.
  if (!template.semesters.length && template.requirements?.length) {
    const backHalf = Math.floor(termCount / 2);
    let turn = 0;
    const nextPos = (): number => backHalf + (turn++ % Math.max(1, termCount - backHalf));
    for (const section of template.requirements as ReqSection[]) {
      for (const rule of section.rules) {
        if (rule.type === "course") {
          foldCourse(rule.code, undefined, undefined, nextPos());
        } else if (rule.type === "oneOf" || rule.type === "chooseN") {
          const n = rule.type === "chooseN" ? rule.n : 1;
          const met = rule.options.filter(
            (c) => doneAlready(c) || onChart.has(c) || studentCodes.has(c),
          ).length;
          for (let i = 0; i < Math.max(0, n - met); i++) {
            pushSlot("EL", `${section.heading} (${template.name})`, rule.credits, nextPos());
          }
        } else if (rule.type === "selectCredits" && rule.credits) {
          const options = rule.from?.kind === "courses" ? rule.from.courses : [];
          const overlap = options.filter((c) => doneAlready(c) || onChart.has(c) || studentCodes.has(c)).length;
          const needed = Math.max(0, Math.ceil(rule.credits / 3) - overlap);
          for (let i = 0; i < needed; i++) {
            pushSlot("EL", `${section.heading} (${template.name})`, 3, nextPos());
          }
        }
      }
    }
  }

  plan.programs = [...plan.programs, template.slug];

  const parts: string[] = [];
  if (result.coursesAdded.length) parts.push(`${result.coursesAdded.length} courses folded into your existing terms`);
  if (result.slotsAdded.length) parts.push(`${result.slotsAdded.length} new requirement slots`);
  if (result.coursesShared.length) parts.push(`${result.coursesShared.length} already in your plan and counted once`);
  if (result.alreadyCompleted.length) parts.push(`${result.alreadyCompleted.length} you have already completed`);
  if (result.coursesRestored.length) parts.push(`restored ${result.coursesRestored.join(", ")}`);
  result.note = parts.length
    ? `Added ${template.name}: ${parts.join(", ")}.`
    : `Added ${template.name}. Everything it requires is already in your plan.`;
  return result;
}

// ------------------------------------------------------------------ removal

export interface UnfilledRequirement {
  /** Which of the Programs you are KEEPING is left short. */
  program: string;
  /** The requirement, as the bulletin names it. */
  requirement: string;
  /** Why the withdrawal leaves it short, in a sentence a student can act on. */
  because: string;
}

export interface RemoveProgramOptions {
  /** The Templates of the Programs the student is KEEPING.
   *
   * Without them the unfilled report is guesswork, and guessing in the
   * reassuring direction is the failure this whole codebase is written against.
   * A Plan generated before Origin recorded two Programs attributes a shared
   * Course to whichever Program placed it first, so these Templates are the
   * only way to know that the departing Program's Course is still needed. */
  remaining?: ProgramTemplate[];
  /** For the credit total in the preview. Omitted: `creditsRemoved` is 0 and
   * means "not counted", not "nothing leaves". */
  catalog?: Catalog;
}

export interface RemoveProgramPreview {
  program: string;
  /** Set when the withdrawal cannot happen. Nothing was changed. */
  refusal: string | null;
  /** Courses this Program placed that nothing else requires. NAMED, because a
   * student who is told "12 courses were removed" cannot check the claim, and
   * the alternative -- leaving them -- strands courses in a Plan for a Program
   * the student no longer has. */
  coursesRemoved: string[];
  /** Courses this Program placed that another Program still requires. They
   * stay, and their Origin is re-pointed at the Program that still needs them. */
  coursesKept: string[];
  slotsRemoved: { id: string; label: string }[];
  /** Slots the student had already CHOSEN a Course for. Called out separately:
   * losing a decision the student made is worth more words than losing an empty
   * card. */
  filledSlotsCleared: { id: string; label: string; code: string }[];
  /** What the Plan would no longer have anything standing for. */
  unfilled: UnfilledRequirement[];
  /** Which remaining Programs we were able to check against. Anything not in
   * this list was NOT checked, and the student is told so rather than being
   * left to assume a clean report means a clean withdrawal. */
  remainingChecked: string[];
  /** Credits leaving the Plan. 0 when no catalog was supplied. */
  creditsRemoved: number;
  note: string;
}

/** Definite requirements of a Template: Courses it schedules outright and
 * Courses its requirements prescribe by name. Choice groups are deliberately
 * excluded here -- an option is not a requirement -- and handled separately as
 * an unfilled WARNING rather than as grounds to keep a card. */
function definiteCourses(t: ProgramTemplate): Set<string> {
  const out = new Set<string>();
  for (const sem of t.semesters) {
    for (const e of sem.entries) {
      if (e.type === "course" && e.code) {
        out.add(e.code);
        for (const a of e.alternatives ?? []) out.add(a);
      }
    }
  }
  for (const section of t.requirements ?? []) {
    for (const rule of section.rules) if (rule.type === "course") out.add(rule.code);
  }
  return out;
}

/** What withdrawing a Program would do, computed WITHOUT doing it.
 *
 * Dropping a Program has a larger blast radius than removing a Course, so the
 * student sees the whole of it first. `removeProgram` runs exactly this and
 * then applies it, so the preview and the act cannot drift apart. */
export function previewRemoveProgram(
  plan: PlanDoc,
  slug: string,
  opts: RemoveProgramOptions = {},
): RemoveProgramPreview {
  const preview: RemoveProgramPreview = {
    program: slug,
    refusal: null,
    coursesRemoved: [],
    coursesKept: [],
    slotsRemoved: [],
    filledSlotsCleared: [],
    unfilled: [],
    remainingChecked: [],
    creditsRemoved: 0,
    note: "",
  };
  if (!plan.programs.includes(slug)) {
    preview.refusal = "That is not one of this plan's programs.";
    preview.note = preview.refusal;
    return preview;
  }
  if (plan.programs.length === 1) {
    // A Plan with no Program is a Plan for nothing: there would be no Template
    // to audit against, no requirements to be short of, and no way back except
    // the "start over" this whole module exists to avoid.
    preview.refusal =
      "This is the only program on your plan. Add the one you are switching to first, then remove this one.";
    preview.note = preview.refusal;
    return preview;
  }

  const survivors = plan.programs.filter((p) => p !== slug);
  const remaining = (opts.remaining ?? []).filter((t) => survivors.includes(t.slug));
  preview.remainingChecked = remaining.map((t) => t.slug);
  const stillRequired = new Set<string>();
  for (const t of remaining) for (const code of definiteCourses(t)) stillRequired.add(code);

  const creditsOfCourse = (code: string): number => {
    const c = opts.catalog?.[code];
    if (!c) return 0;
    if (c.creditsParsed) return c.creditsParsed.min;
    const m = /[\d.]+/.exec(c.credits ?? "");
    return m ? parseFloat(m[0]) : 0;
  };

  for (const t of plan.terms) {
    for (const it of t.items) {
      const progs = originPrograms(it.origin);
      if (!progs.includes(slug)) continue;
      if ("slot" in it) {
        // A Slot the departing Program placed goes with it. The gen-ed
        // framework audit re-adds whatever the student still owes on the next
        // pass, so this never silently shortens the degree -- but the student
        // is told now, not after the fact.
        const others = progs.filter((p) => p !== slug && survivors.includes(p));
        if (others.length) continue;
        const fill = plan.slotFills[it.id];
        if (fill) preview.filledSlotsCleared.push({ id: it.id, label: it.label ?? it.slot, code: fill });
        else preview.slotsRemoved.push({ id: it.id, label: it.label ?? it.slot });
        preview.creditsRemoved += Number(it.credits) || 0;
        continue;
      }
      const others = progs.filter((p) => p !== slug && survivors.includes(p));
      if (others.length || stillRequired.has(it.code)) {
        preview.coursesKept.push(it.code);
        continue;
      }
      preview.coursesRemoved.push(it.code);
      preview.creditsRemoved += creditsOfCourse(it.code);
    }
  }

  // ---- What the withdrawal leaves unfilled --------------------------------
  // Two different shortfalls, both real:
  //
  //  1. A Slot count. Slots are budgeted as the MAX across Programs, so the
  //     card standing for a surviving Program's gen ed may be the one the
  //     departing Program contributed.
  //  2. A Course a surviving Program lists as an OPTION. It is not grounds to
  //     keep the card -- the student may satisfy the requirement another way --
  //     but they should hear about it before, not discover it at graduation.
  const goingSlotIds = new Set([
    ...preview.slotsRemoved.map((s) => s.id),
    ...preview.filledSlotsCleared.map((s) => s.id),
  ]);
  const surviving = new Map<string, number>();
  for (const t of plan.terms) {
    for (const it of t.items) {
      if (!("slot" in it) || goingSlotIds.has(it.id) || plan.removed?.[it.id]) continue;
      const k = slotBudgetKey(it.slot, it.label);
      surviving.set(k, (surviving.get(k) ?? 0) + 1);
    }
  }
  for (const t of remaining) {
    const wants = new Map<string, { count: number; label: string }>();
    for (const sem of t.semesters) {
      for (const e of sem.entries) {
        if (e.type === "course") continue;
        const k = entryBudgetKey(e);
        const cur = wants.get(k) ?? { count: 0, label: entryLabel(e) };
        cur.count += 1;
        wants.set(k, cur);
      }
    }
    for (const [k, { count, label }] of wants) {
      const short = count - (surviving.get(k) ?? 0);
      if (short > 0) {
        preview.unfilled.push({
          program: t.name,
          requirement: label,
          because: `${short} fewer ${short === 1 ? "card" : "cards"} than ${t.name} needs once this program's slots go.`,
        });
      }
    }
    const leaving = new Set(preview.coursesRemoved);
    for (const section of t.requirements ?? []) {
      for (const rule of section.rules) {
        const options =
          rule.type === "oneOf" || rule.type === "chooseN"
            ? rule.options
            : rule.type === "selectCredits" && rule.from?.kind === "courses"
              ? rule.from.courses
              : [];
        const hit = options.filter((c) => leaving.has(c));
        if (!hit.length) continue;
        preview.unfilled.push({
          program: t.name,
          requirement: section.heading,
          because: `${hit.join(", ")} counted toward this and would leave your plan.`,
        });
      }
    }
  }

  const bits: string[] = [];
  bits.push(
    preview.coursesRemoved.length
      ? `removes ${preview.coursesRemoved.join(", ")}`
      : "removes no courses",
  );
  if (preview.coursesKept.length) bits.push(`keeps ${preview.coursesKept.length} your other programs still require`);
  if (preview.slotsRemoved.length) bits.push(`removes ${preview.slotsRemoved.length} requirement slots`);
  if (preview.filledSlotsCleared.length) {
    bits.push(
      `clears ${preview.filledSlotsCleared.length} slots you had already chosen a course for (${preview.filledSlotsCleared
        .map((s) => s.code)
        .join(", ")})`,
    );
  }
  if (preview.unfilled.length) bits.push(`leaves ${preview.unfilled.length} requirements unfilled`);
  if (!remaining.length) {
    bits.push("we could not read your other programs' requirements, so this check is incomplete");
  }
  preview.note = `Dropping this program ${bits.join("; ")}. Your completed courses and anything you added yourself stay.`;
  return preview;
}

/** Withdraw a Program from a Plan, applying exactly what `previewRemoveProgram`
 * described. Returns that same preview so a caller can show what happened. */
export function removeProgram(
  plan: PlanDoc,
  slug: string,
  opts: RemoveProgramOptions = {},
): RemoveProgramPreview {
  const preview = previewRemoveProgram(plan, slug, opts);
  if (preview.refusal) return preview;

  const dropCourses = new Set(preview.coursesRemoved);
  const dropSlots = new Set([
    ...preview.slotsRemoved.map((s) => s.id),
    ...preview.filledSlotsCleared.map((s) => s.id),
  ]);
  const survivors = plan.programs.filter((p) => p !== slug);

  for (const t of plan.terms) {
    t.items = t.items.filter((it) => !("slot" in it ? dropSlots.has(it.id) : dropCourses.has(it.code)));
    for (const it of t.items) {
      if (!it.origin) continue;
      const progs = originPrograms(it.origin).filter((p) => p !== slug);
      if (progs.length === originPrograms(it.origin).length) continue;
      // A Course this Program shared with another is KEPT, and its Origin now
      // names only the Programs that still want it -- otherwise withdrawing the
      // second Program later would read a Program the Plan no longer has and
      // decide the Course was still needed.
      if (progs.length) {
        it.origin = { ...it.origin, program: progs[0], alsoPrograms: progs.slice(1) };
        if (!it.origin.alsoPrograms?.length) delete it.origin.alsoPrograms;
      } else {
        // Kept only because a surviving Program's Template requires it, with no
        // Origin to prove it. Re-point it at that Program so the next
        // withdrawal does not have to rediscover the fact.
        const owner = (opts.remaining ?? []).find(
          (r) => survivors.includes(r.slug) && !("slot" in it) && definiteCourses(r).has(it.code),
        );
        it.origin = { ...it.origin, program: owner?.slug ?? survivors[0], alsoPrograms: undefined };
        delete it.origin.alsoPrograms;
      }
    }
  }

  // Clean up the index-keyed state that pointed at what just left. A stale
  // `slotFills` entry would re-fill a Slot that no longer exists if the Program
  // were ever re-added, and a stale `removed` entry shows the student a
  // "Removed items" list naming courses for a Program they no longer have.
  for (const id of dropSlots) {
    delete plan.slotFills[id];
    delete plan.moves[id];
    if (plan.removed) delete plan.removed[id];
  }
  for (const code of dropCourses) {
    delete plan.moves[code];
    if (plan.removed) delete plan.removed[code];
    if (plan.removedSpecs) delete plan.removedSpecs[code];
  }
  plan.programs = survivors;
  return preview;
}
