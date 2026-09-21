/** Schedule optimizer — FLOW-ORDERED PACKING.
 *
 * Goal: graduate in the FEWEST semesters, packed to a realistic full-time load
 * (14-19cr, high end), while courses still rise in difficulty over time — the
 * order the department flowchart and suggested plans intend. We do NOT preserve
 * the flowchart's absolute semester SPACING (that spreads a degree over 8 terms
 * when a motivated student could finish sooner); we preserve its ORDER.
 *
 *   - Each course carries its template semester (`origin.templateSem`), which
 *     encodes the intended difficulty flow. Courses are scheduled in that flow
 *     order and PACKED as early as prereqs + the credit cap allow — so 8 spread
 *     template semesters compress into as few dense ones as the prereq chain
 *     permits, without reordering the progression.
 *   - Every semester keeps a MIX: ~1 gen ed reserved before courses fill, plus
 *     undecided elective placeholders on a share that rises with the mined
 *     advanced-work curve (chosen elective COURSES ride the spine like any
 *     course; only generic placeholder slots follow the gradient).
 *   - `targetSemesters` (e.g. "graduate in 6"): spread the same work across
 *     exactly that many terms at an even load instead of packing maximally.
 *   - A detected capstone sequence is anchored to the FINAL semesters, one
 *     course per semester, in prereq order (senior-standing prereqs are UNK
 *     free-text, so position is the only enforcement). For a dual major the
 *     longer capstone wins; the other is set aside restorably.
 *
 * Feasibility is checked with the real leaf-level prereq evaluator — the exact
 * rule the canvas uses for red edges — so optimizer output needs no repair pass
 * (the cap-aware optimizer is always the LAST pass; see the 25-credit dual-major
 * incident in DECISIONS.md §2.9). */
import { detectCapstones, resolveDualCapstones } from "./capstone.js";
import { evalNode } from "./evaluate.js";
import { DEFAULT_FLOWCHART_PATTERNS, sampleCurve, type FlowchartPatterns } from "./flowchartPatterns.js";
import { astCourses, parsePrereqText, type AstNode } from "./prereq.js";
import { SUMMER_MAX_CREDITS, parseTermLabel, termSequence } from "./terms.js";
import { UNSAT, type Catalog, type CourseSpec, type Leaf, type PlanDoc, type PlanItemSpec, type PlanTerm, type Schedule, type ScheduleConstraint, type SlotSpec } from "./types.js";

export interface OptimizeOptions {
  maxCredits?: number;
  /** Mined flowchart priors; falls back to engine defaults when absent. */
  patterns?: FlowchartPatterns;
  /** Graduate in EXACTLY this many semesters (best effort): spread the work at
   * an even load rather than packing maximally. Omit to minimize time. */
  targetSemesters?: number;
}
export interface OptimizeResult {
  changed: boolean;
  semestersBefore: number;
  semestersAfter: number;
  maxCredits: number;
  /** Adviser-verification note when a dual-major capstone was set aside. */
  capstoneNote: string | null;
  /** Course codes moved to `removed` (a losing program's capstone). */
  droppedCapstone: string[];
  /** Set when a requested `targetSemesters` couldn't be met (too much work for
   * the cap, or prereq chains too long) — the actual count is semestersAfter. */
  targetMissed: boolean;
}

function creditsOf(spec: PlanItemSpec, catalog: Catalog): number {
  if ("slot" in spec) return Number(spec.credits) || 3;
  return catalog[spec.code]?.creditsParsed?.min ?? 3;
}

/** Course level (100/200/300/400...) — a secondary difficulty signal so that,
 * among courses sharing a template semester, the lower-level one flows first. */
function levelOf(catalog: Catalog, code: string): number {
  const num = catalog[code]?.number ?? code.split(" ")[1] ?? "0";
  return parseInt(num, 10) || 0;
}

function astOf(catalog: Catalog, code: string, field: "prereqAst" | "concurrentAst"): AstNode | null {
  const c = catalog[code];
  if (!c) return null;
  if (c[field]) return c[field];
  const raw = field === "prereqAst" ? c.enforced : c.concurrent;
  return raw ? parsePrereqText(raw) : null;
}

/** Longest chain of in-plan courses that (transitively) require `code`. Used
 * only as a tiebreak among courses sharing a template semester. */
function chainDepths(codes: Set<string>, catalog: Catalog): Map<string, number> {
  const dependents = new Map<string, string[]>();
  for (const code of codes) {
    for (const field of ["prereqAst", "concurrentAst"] as const) {
      const ast = astOf(catalog, code, field);
      if (!ast) continue;
      for (const dep of astCourses(ast)) {
        const canonical = catalog[dep]?.code ?? dep;
        if (!codes.has(canonical)) continue;
        const list = dependents.get(canonical) ?? [];
        list.push(code);
        dependents.set(canonical, list);
      }
    }
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const compute = (code: string): number => {
    const memo = depth.get(code);
    if (memo !== undefined) return memo;
    if (visiting.has(code)) return 0; // cycle guard (bad bulletin data)
    visiting.add(code);
    const d = 1 + Math.max(0, ...(dependents.get(code) ?? []).map(compute));
    visiting.delete(code);
    depth.set(code, d);
    return d;
  };
  for (const code of codes) compute(code);
  return depth;
}

interface CourseWork {
  spec: CourseSpec;
  canonical: string;
  baseSem: number; // normalized template semester (min template sem -> 0)
  credits: number;
  depth: number;
}

export function optimizeSchedule(plan: PlanDoc, catalog: Catalog, opts: OptimizeOptions = {}): OptimizeResult {
  const patterns = opts.patterns ?? DEFAULT_FLOWCHART_PATTERNS;
  const maxCredits = opts.maxCredits ?? patterns.capCreditsPerSem ?? 19;
  const removed = { ...(plan.removed ?? {}) };
  const semestersBefore = plan.terms.length;

  // ---- Term sequence, with the student's opt-in summer sessions ------------
  // Summers are year-keyed on the plan (durable across re-packs); each index of
  // the packed plan maps through this sequence for its label, credit ceiling
  // (SUMMER_MAX_CREDITS), and full-time-floor exemption.
  const startRef = parseTermLabel(plan.terms[0]?.label ?? "") ?? { label: "Fall 2026", kind: "Fall" as const, year: 2026 };
  const startTerm = { term: (startRef.kind === "Summer" ? "Fall" : startRef.kind) as "Fall" | "Spring", year: startRef.year };
  const seq = termSequence(startTerm, 80, plan.summerYears ?? []);
  const isSummer = (i: number) => seq[i]?.kind === "Summer";
  const capAt = (i: number) => (isSummer(i) ? Math.min(SUMMER_MAX_CREDITS, maxCredits) : maxCredits);

  // ---- Capstone: detect, resolve dual-major conflict, drop losers ----------
  const capstones = detectCapstones(plan, catalog, patterns);
  const resolution = resolveDualCapstones(capstones);
  for (const code of resolution.drop) removed[code] = true;
  const keptCapstone = resolution.keep ? resolution.keep.codes.map((c) => catalog[c]?.code ?? c) : [];
  const capstoneOrder = new Map(keptCapstone.map((c, i) => [c, i]));

  // ---- IUG graduate terms are PRESERVED, not re-flowed --------------------
  // The graduate half of an IUG is a fixed adviser-approved sequence; the
  // optimizer only re-packs the undergraduate half and re-appends the grad
  // terms after it (relabeled to continue the sequence). Grad courses are
  // excluded from the undergrad course pool AND from prereq/capstone/gened
  // reasoning below (they'd distort it).
  const gradTerms = plan.terms.filter((t) => t.phase === "grad");
  const undergradTerms = plan.terms.filter((t) => t.phase !== "grad");
  // Intentional gap semesters (gap year / co-op / leave): their positions in the
  // undergraduate sequence. Coursework re-packs ignoring them; after packing we
  // splice an empty term back in at each position so everything from there
  // shifts one term later (a uniform shift — prereq order and caps are preserved).
  const gapPositions = undergradTerms.map((t, i) => (t.gap ? i : -1)).filter((i) => i >= 0);

  // ---- Collect schedulable specs (user-added courses fold in permanently) --
  const courseSpecs: CourseSpec[] = [];
  const slotSpecs: SlotSpec[] = [];
  const seen = new Set<string>();
  const pushCourse = (spec: CourseSpec) => {
    const canonical = catalog[spec.code]?.code ?? spec.code;
    if (removed[spec.code] || plan.completed[canonical] || plan.completed[spec.code] || seen.has(canonical)) return;
    seen.add(canonical);
    courseSpecs.push(spec);
  };
  for (const t of undergradTerms) {
    for (const it of t.items) {
      if ("slot" in it) {
        if (!removed[it.id]) slotSpecs.push(it);
      } else {
        pushCourse(it);
      }
    }
  }
  for (const a of plan.added) pushCourse({ code: a.code });
  plan.added = [];

  // Normalize template semesters to a 0-based origin so a major-switcher whose
  // plan starts mid-template still anchors correctly.
  const rawSems = courseSpecs.map((s) => s.origin?.templateSem ?? 0);
  const minSem = rawSems.length ? Math.min(...rawSems) : 0;
  const codes = new Set(courseSpecs.map((s) => catalog[s.code]?.code ?? s.code));
  const depths = chainDepths(codes, catalog);

  const capstoneWork: CourseWork[] = [];
  const spineWork: CourseWork[] = [];
  for (const spec of courseSpecs) {
    const canonical = catalog[spec.code]?.code ?? spec.code;
    const work: CourseWork = {
      spec,
      canonical,
      baseSem: Math.max(0, (spec.origin?.templateSem ?? minSem) - minSem),
      credits: creditsOf(spec, catalog),
      depth: depths.get(canonical) ?? 0,
    };
    if (capstoneOrder.has(canonical)) capstoneWork.push(work);
    else spineWork.push(work);
  }

  // ---- Target load & plan length -------------------------------------------
  // Pack toward the FEWEST semesters at a realistic full-time load (high end of
  // 14-19). With an explicit targetSemesters, spread the same work evenly across
  // exactly that many terms instead. perSemTarget is the per-semester credit
  // aim; maxCredits stays the hard ceiling.
  const totalCredits =
    spineWork.reduce((s, w) => s + w.credits, 0) +
    slotSpecs.reduce((s, w) => s + creditsOf(w, catalog), 0) +
    capstoneWork.reduce((s, w) => s + w.credits, 0);
  let perSemTarget = maxCredits; // refined below to an even load
  /** Per-index fill target: regular semesters aim at perSemTarget; summers at
   * their lower ceiling (a 9-credit summer is a FULL summer). */
  const targetAt = (i: number) => (isSummer(i) ? capAt(i) : perSemTarget);
  const sweepTargetAt = targetAt; // sweep and backfill share the same target
  let nEst: number;
  {
    // Minimal calendar: walk cumulative FULL capacity (19 regular / 9 summer)
    // through the real term sequence, so an opt-in summer's extra capacity
    // SHRINKS the calendar — the whole point of taking summer classes.
    let acc = 0;
    let n = 0;
    while (acc < totalCredits && n < 60) {
      acc += capAt(n);
      n++;
    }
    // A requested targetSemesters may stretch the calendar, never compress it
    // below feasibility (asking for 6 when the work needs 9 gives a clean
    // 9-term plan, flagged targetMissed — not a ragged 6+tail).
    nEst = Math.max(1, n, opts.targetSemesters ?? 0);
    // EVEN load: solve for the regular-term target that spreads the total
    // across the estimate (summers fixed at their ceiling). Uniform density is
    // what keeps every term in the 14-19 band instead of packed-19s followed
    // by a thin remainder tail.
    let summerCap = 0;
    let regulars = 0;
    for (let i = 0; i < nEst; i++) { if (isSummer(i)) summerCap += capAt(i); else regulars++; }
    perSemTarget = Math.min(maxCredits, Math.max(12, Math.ceil((totalCredits - summerCap) / Math.max(1, regulars))));
  }
  // ---- Slot handling -------------------------------------------------------
  // Gen eds ride ~1/sem (reserved before courses so a dense term still gets
  // one). Undecided elective placeholders follow the ELECTIVE CURVE mined from
  // ~1,078 bulletin suggested plans: the prescribed core is front-loaded and
  // technical electives phase in toward the capstone (measured share rises
  // 0.03 -> 0.24 across the plan). Term 0 stays prescribed-only. While spine
  // courses remain, each term's elective take is capped so real courses keep
  // most of the room — the mix survives, no all-elective mid-plan term.
  // (Chosen elective COURSES are real specs with a template origin and ride
  // the spine like any course — only these generic slots follow the curve.)
  const geSlots = slotSpecs.filter((s) => s.slot !== "EL");
  const elSlots = slotSpecs.filter((s) => s.slot === "EL");
  // CONSOLIDATION RESERVE: hold back enough elective slots to fill the
  // capstone terms to a full-time load (~15, backfilled up to the target after
  // the block lands). A senior-design term carrying only its 2-3 capstone
  // credits wastes a semester — the technical electives belong right there.
  const elCurve = patterns.electiveCurve ?? DEFAULT_FLOWCHART_PATTERNS.electiveCurve;
  const elQuota = distributeWeighted(elSlots.length, nEst, (s) => (s === 0 ? 0 : sampleCurve(elCurve, s, nEst)));

  // ---- Virtual schedule for feasibility ------------------------------------
  const placedSem = new Map<string, number>();
  const buildSchedFrom = (placement: Map<string, number>): Schedule => {
    const sched: Schedule = {};
    const register = (code: string, sem: number) => {
      const c = catalog[code];
      const entry = { sem, completed: sem < 0, item: { id: code, kind: "course" as const, code, sem } };
      for (const a of c?.aliases ?? [code]) sched[a] = entry;
      sched[code] = entry;
      // Honors sections stand in for their base course's prereq role
      // (MATH 140H satisfies "MATH 140" — see schedule.ts honorsBaseOf).
      const m = /^(.* \d+)[HM]$/.exec(code);
      if (m && catalog[m[1]] && !sched[m[1]]) sched[m[1]] = entry;
    };
    for (const code of Object.keys(plan.completed)) if (plan.completed[code]) register(code, -1);
    for (const [code, sem] of placement) register(code, sem);
    return sched;
  };
  const buildSched = (): Schedule => buildSchedFrom(placedSem);
  // ---- Declared scheduling constraints ("can't take AI 100 in Fall 2026") --
  // Durable, unlike manual moves: every run honors them. A course blocked from
  // a term simply isn't placed there — the packer backfills the gap with the
  // next feasible courses and the blocked course lands at its earliest legal
  // feasible term, dependents shifting via the normal feasibility checks.
  const constraintsByCode = new Map<string, ScheduleConstraint[]>();
  for (const c of plan.constraints ?? []) {
    const canonical = catalog[c.code]?.code ?? c.code;
    const list = constraintsByCode.get(canonical) ?? [];
    list.push(c);
    constraintsByCode.set(canonical, list);
  }
  const allowedAt = (canonical: string, sem: number): boolean => {
    for (const c of constraintsByCode.get(canonical) ?? []) {
      if (c.type === "not-in" && sem === c.termIndex) return false;
      if (c.type === "not-before" && sem < c.termIndex) return false;
      if (c.type === "pin" && sem !== c.termIndex) return false;
    }
    return true;
  };

  const feasibleAt = (code: string, sem: number, sched: Schedule): boolean => {
    for (const [field, concurrent] of [["prereqAst", false], ["concurrentAst", true]] as const) {
      const ast = astOf(catalog, code, field);
      if (!ast) continue;
      const leaves: Leaf[] = [];
      if (evalNode(ast, sched, sem, concurrent, leaves) === UNSAT) return false;
      for (const l of leaves) {
        if (l.kind === "inplan" && l.v === UNSAT) return false;
        if (l.kind === "external") {
          const canonical = catalog[l.code]?.code ?? l.code;
          if (codes.has(canonical) && !plan.completed[canonical]) return false; // in-plan, not yet placed
        }
      }
    }
    return true;
  };

  // ---- Main sweep: semester by semester, spine first then gradient slots ----
  // Flow order: template semester, then prereq depth (unlockers first), then
  // course level — so difficulty rises across the packed plan.
  const unplacedSpine = [...spineWork].sort(
    (a, b) => a.baseSem - b.baseSem || b.depth - a.depth || levelOf(catalog, a.canonical) - levelOf(catalog, b.canonical),
  );
  const gePool = [...geSlots];
  const elPool = [...elSlots];
  const newTerms: PlanItemSpec[][] = [];
  let elCarry = 0; // unplaced curve share rolls forward so no elective is lost
  // Capacity-weighted flow anchor: each term's course capacity is what the cap
  // leaves after its gen-ed reservation and its curve-share of electives —
  // LARGE early (few electives), smaller late. Courses are laid onto that
  // capacity in flow order (a course can't schedule before the term where the
  // cumulative capacity reaches its cumulative flow credits). The prescribed
  // core therefore FRONT-LOADS while difficulty still rises, complementing the
  // rising elective curve — the exact shape of the bulletin's own plans. No
  // term is left a course gap that fills with an all-elective clump.
  const termCourseCapacity = (s: number): number =>
    Math.max(3, sweepTargetAt(s) - (s < geSlots.length && !isSummer(s) ? 3 : 0) - 3 * (elQuota[s] ?? 0));
  const anchorSlot = new Map<CourseWork, number>();
  {
    let cumCredits = 0;
    let term = 0;
    let cumCapacity = termCourseCapacity(0);
    for (const w of unplacedSpine) {
      cumCredits += w.credits;
      while (cumCredits > cumCapacity && term < nEst - 1) {
        term++;
        cumCapacity += termCourseCapacity(term);
      }
      anchorSlot.set(w, term);
    }
  }
  const anchorOf = (w: CourseWork) => anchorSlot.get(w) ?? 0;
  // Gen eds ride ~1 per semester so they never clump — a second only when the
  // mined curve is strongly front-loaded AND enough remain to need doubling up.
  const geDoublePace = geSlots.length > nEst;

  for (let sem = 0; (unplacedSpine.length || gePool.length || elPool.length) && sem < 40; sem++) {
    const current: PlanItemSpec[] = [];
    let credits = 0;
    const place = (spec: PlanItemSpec) => {
      current.push(spec);
      credits += creditsOf(spec, catalog);
      if ("code" in spec) placedSem.set(catalog[spec.code]?.code ?? spec.code, sem);
    };

    // 0. Courses PINNED to this exact term place first — a pin is a user
    // command, honored even when prereqs read red (the edge tells the truth).
    for (let i = 0; i < unplacedSpine.length; i++) {
      const w = unplacedSpine[i];
      const pins = (constraintsByCode.get(w.canonical) ?? []).filter((c) => c.type === "pin");
      if (!pins.some((c) => c.termIndex === sem)) continue;
      unplacedSpine.splice(i, 1);
      i--;
      place(w.spec);
    }

    // 1. RESERVE ~1 gen ed and this term's CURVE SHARE of electives BEFORE
    // filling courses (a packed spine would otherwise starve them). While
    // spine courses remain, the elective take is capped so at least ~2 course
    // slots of room survive — the defined-core/elective mix holds every term.
    const geTarget = gePool.length === 0 ? 0
      : (geDoublePace && sampleCurve(patterns.geCurve, sem, nEst) >= 1.0 ? 2 : 1);
    const reserved: PlanItemSpec[] = [];
    for (let i = 0; i < geTarget && gePool.length; i++) reserved.push(gePool.shift()!);
    const geReservedCredits = reserved.reduce((s, r) => s + creditsOf(r, catalog), 0);
    const mixCap = unplacedSpine.length
      ? Math.max(0, Math.floor((sweepTargetAt(sem) - geReservedCredits - 6) / 3))
      : Number.POSITIVE_INFINITY;
    let elTake = Math.min((elQuota[sem] ?? 0) + elCarry, mixCap, elPool.length);
    elCarry = Math.max(0, (elQuota[sem] ?? 0) + elCarry - elTake);
    while (elTake-- > 0 && elPool.length) reserved.push(elPool.shift()!);
    const reservedCredits = reserved.reduce((s, r) => s + creditsOf(r, catalog), 0);

    // 2. Course spine in flow order up to the remaining room, gated by the
    // capacity-weighted anchor (front-loaded core, difficulty still rising).
    // Multi-pass so a same-semester concurrent prereq unlocks its dependents.
    const courseBudget = sweepTargetAt(sem) - reservedCredits;
    let progressed = true;
    while (progressed) {
      progressed = false;
      const sched = buildSched();
      for (let i = 0; i < unplacedSpine.length; i++) {
        const w = unplacedSpine[i];
        if (sem < anchorOf(w)) continue; // hasn't reached its flow position
        if (!allowedAt(w.canonical, sem)) continue; // declared constraint
        if (credits + w.credits > courseBudget) continue;
        if (!feasibleAt(w.canonical, sem, sched)) continue;
        unplacedSpine.splice(i, 1);
        i--;
        place(w.spec);
        progressed = true;
      }
    }

    // 3. Place the reserved slots, then reclaim any leftover room: courses
    // first (prereq webs can hold a course back from step 2's tighter budget),
    // then remaining gen eds / electives once the spine has run dry, so no
    // half-empty tail of terms trails the plan.
    for (const r of reserved) place(r);
    const canFill = () => credits < sweepTargetAt(sem);
    if (canFill() && unplacedSpine.length) {
      let more = true;
      while (more) {
        more = false;
        const sched = buildSched();
        for (let i = 0; i < unplacedSpine.length; i++) {
          const w = unplacedSpine[i];
          if (sem < anchorOf(w)) continue;
          if (!allowedAt(w.canonical, sem)) continue;
          if (credits + w.credits > sweepTargetAt(sem)) continue;
          if (!feasibleAt(w.canonical, sem, sched)) continue;
          unplacedSpine.splice(i, 1);
          i--;
          place(w.spec);
          more = true;
        }
      }
    }
    if (!unplacedSpine.length) {
      // Spine done — spread the remaining slots across the remaining estimated
      // terms instead of flooding this one, so technical electives run right
      // alongside the senior capstone (its block anchors to the final terms).
      // STRICT bound: never overshoot the sweep target — a 1.5-credit overshoot
      // in a headroom term evicts the capstone block and appends extra terms.
      const remTerms = Math.max(1, nEst - sem);
      let geSpread = Math.ceil(gePool.length / remTerms);
      while (geSpread-- > 0 && gePool.length && credits + creditsOf(gePool[0], catalog) <= sweepTargetAt(sem)) place(gePool.shift()!);
      let elSpread = Math.ceil(elPool.length / remTerms);
      while (elSpread-- > 0 && elPool.length && credits + creditsOf(elPool[0], catalog) <= sweepTargetAt(sem)) place(elPool.shift()!);
    }

    // Deadlock / empty-term guard: if nothing landed but work remains (an early
    // term with no anchored course yet, or an unsatisfiable prereq web), force
    // the next CONSTRAINT-LEGAL item so the loop makes progress; a forced
    // course renders with a red edge, honestly. If every remaining course is
    // blocked from this term, emit the (possibly slot-only) term and move on —
    // never place a course where the student said it can't go.
    if (!current.length) {
      const forceable = unplacedSpine.findIndex((w) => allowedAt(w.canonical, sem));
      if (forceable >= 0) place(unplacedSpine.splice(forceable, 1)[0].spec);
      else if (gePool.length) place(gePool.shift()!);
      else if (elPool.length) place(elPool.shift()!);
      else if (!unplacedSpine.length) break;
      // else: all remaining courses blocked here — emit an empty term; they
      // place in the next legal one.
    }
    newTerms.push(current);
  }

  // ---- Capstone anchor: the kept sequence lands in the FINAL semesters as a
  // CONTIGUOUS block, one course per term in prereq order (a gap mid-sequence
  // is not how senior design runs). We search for the earliest starting term
  // where the whole block fits: every course's own prereqs satisfied (senior
  // design has real ones — AIE 489W needs AI 410 + AI 341W) and every target
  // term has cap room. Shifting the block later never breaks feasibility, so
  // the scan is monotone; trailing terms are appended as a last resort.
  const creditsOfTerm = (t: PlanItemSpec[]) => t.reduce((s, it) => s + creditsOf(it, catalog), 0);
  if (capstoneWork.length) {
    capstoneWork.sort((a, b) => (capstoneOrder.get(a.canonical) ?? 0) - (capstoneOrder.get(b.canonical) ?? 0));
    const K = capstoneWork.length;
    while (newTerms.length < Math.max(K, opts.targetSemesters ?? 0)) newTerms.push([]);
    // Senior design runs in REGULAR semesters — the block occupies consecutive
    // NON-summer terms (a summer between two capstone semesters is skipped, the
    // sequence stays contiguous in the fall/spring calendar).
    const regularIdx = (upTo: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < upTo; i++) if (!isSummer(i)) out.push(i);
      return out;
    };
    const blockTerms = (p: number): number[] => {
      const reg = regularIdx(newTerms.length + K + 30);
      return reg.slice(p, p + K);
    };
    const fits = (p: number, requireFeasible: boolean): boolean => {
      const terms = blockTerms(p);
      if (terms.length < K) return false;
      while (newTerms.length <= terms[K - 1]) newTerms.push([]);
      // Simulate the block so later members see earlier ones.
      capstoneWork.forEach((w, i) => placedSem.set(w.canonical, terms[i]));
      const ok = capstoneWork.every((w, i) =>
        creditsOfTerm(newTerms[terms[i]]) + w.credits <= capAt(terms[i]) &&
        allowedAt(w.canonical, terms[i]) &&
        (!requireFeasible || feasibleAt(w.canonical, terms[i], buildSched())));
      if (!ok) for (const w of capstoneWork) placedSem.delete(w.canonical);
      return ok;
    };
    // Anchor at the packed content's tail: the last K regular terms. Room is
    // MADE, not predicted — slots (prereq-free, freely movable) are evicted
    // from the tail terms to earlier terms with room until the capstone fits.
    // Total capacity >= total content guarantees recipients exist.
    const regNow = regularIdx(newTerms.length);
    const firstPos = Math.max(0, regNow.length - K);
    {
      const candidates = blockTerms(firstPos);
      capstoneWork.forEach((w, i) => {
        const t = candidates[i];
        if (t === undefined) return;
        while (newTerms.length <= t) newTerms.push([]);
        let needed = creditsOfTerm(newTerms[t]) + w.credits - capAt(t);
        while (needed > 0) {
          const si = newTerms[t].findIndex((it) => "slot" in it);
          if (si < 0) break; // all courses — the scan below will advance instead
          const [slot] = newTerms[t].splice(si, 1);
          const cr = creditsOf(slot, catalog);
          let home = -1;
          for (let r = 0; r < newTerms.length; r++) {
            if (candidates.includes(r)) continue;
            if (creditsOfTerm(newTerms[r]) + cr <= capAt(r)) { home = r; break; }
          }
          if (home < 0) { newTerms[t].splice(si, 0, slot); break; } // nowhere to go — keep as-is
          newTerms[home].push(slot);
          needed -= cr;
        }
      });
    }
    let p = firstPos;
    while (p < firstPos + 24 && !fits(p, true)) p++;
    if (p >= firstPos + 24) {
      // A capstone prereq lives outside the plan (bulletin quirk) — feasibility
      // will never pass. Anchor to the end anyway; the red edge tells the truth.
      p = firstPos;
      while (p < firstPos + 24 && !fits(p, false)) p++;
      if (p >= firstPos + 24) p = firstPos; // pathological constraints — place anyway, honestly red
    }
    const landed = blockTerms(p);
    capstoneWork.forEach((w, i) => {
      while (newTerms.length <= landed[i]) newTerms.push([]);
      newTerms[landed[i]].push(w.spec);
      placedSem.set(w.canonical, landed[i]);
    });
    // Consolidate the capstone tail: any capstone term still light pulls the
    // remaining slot pools (the spine-done spread may not have reached terms
    // this late), keeping every final term at a full-time load.
    for (let i = 0; i < K; i++) {
      const t = landed[i];
      for (const pool of [elPool, gePool]) {
        while (pool.length &&
               creditsOfTerm(newTerms[t]) + creditsOf(pool[0], catalog) <= capAt(t) &&
               creditsOfTerm(newTerms[t]) < targetAt(t)) {
          newTerms[t].push(pool.shift()!);
        }
      }
    }
  }

  // ---- FEWEST-SEMESTERS RE-PACK (the credit count is the source of truth) ---
  // The sweep keeps a difficulty gradient but can leave early terms under the
  // cap while electives pile into a trailing partial term — spending a whole
  // extra semester the credits didn't require. Minimizing TIME is the goal, so
  // after the sweep we try to re-pack everything into ceil(credits / cap) terms:
  //   reserve one ~3-credit gen ed per term, place the defined core first (in
  //   flow order, earliest prereq-feasible term with room), reserve the capstone
  //   courses in the final terms, then fill the remaining room with electives.
  // We accept the tighter layout ONLY if EVERYTHING fits feasibly; otherwise we
  // step the target up a term and retry, so an infeasible target (deep prereq
  // chains, a pinned course) self-corrects to the true minimum. The original
  // swept layout is the fallback — this pass never makes the plan longer.
  const capReserveFloor = () => {
    // Summers change per-term caps and the capstone's regular-only rule; keep
    // the swept layout for summer plans (handled by the existing spread).
    if ((plan.summerYears?.length ?? 0) > 0) return;
    const K = capstoneWork.length;
    const caps = [...capstoneWork].sort((a, b) => (capstoneOrder.get(a.canonical) ?? 0) - (capstoneOrder.get(b.canonical) ?? 0));
    const bodyOrder = [...spineWork].sort(
      (a, b) => a.baseSem - b.baseSem || b.depth - a.depth || levelOf(catalog, a.canonical) - levelOf(catalog, b.canonical),
    );
    const attempt = (target: number): PlanItemSpec[][] | null => {
      if (target < K) return null;
      const terms: PlanItemSpec[][] = Array.from({ length: target }, () => []);
      const place = new Map<string, number>();
      const credOf = (i: number) => terms[i].reduce((s, it) => s + creditsOf(it, catalog), 0);
      // Capstone occupies the final K terms, one per term, in order — hold that
      // room open while the body packs so the sequence has somewhere to land.
      const capTermOf = new Map<string, number>();
      caps.forEach((w, j) => capTermOf.set(w.canonical, target - K + j));
      const capResAt = (i: number) => caps.reduce((s, w) => s + (capTermOf.get(w.canonical) === i ? w.credits : 0), 0);
      const body = [...bodyOrder];
      const ge = [...geSlots];
      const el = [...elSlots];
      // Gen eds ride ~1 per semester (the bulletin's rhythm and the user's rule:
      // three gen-ed credits every term): spread them across the whole plan, one
      // per term, so no long GE-less run forms and none clump at the front.
      const geEvery = geSlots.length > 0 ? Math.max(1, Math.round(target / geSlots.length)) : Infinity;
      // Fill term by term to the cap: defined core first (earliest prereq-
      // feasible course, multi-pass so a same-term concurrent unlocks its
      // dependents), holding ~3 credits open for this term's gen ed, then the
      // gen ed, then electives top the term off to 19. Packing each term full as
      // we go (rather than an even spread) is what actually minimizes the number
      // of semesters, and the reserved gen-ed slot keeps difficulty from
      // clumping into an all-core wall.
      for (let i = 0; i < target; i++) {
        const wantGe = ge.length > 0 && i % geEvery === 0;
        const geHold = wantGe ? 3 : 0;
        const room = () => capAt(i) - capResAt(i);
        let progressed = true;
        while (progressed) {
          progressed = false;
          const sched = buildSchedFrom(place);
          for (let k = 0; k < body.length; k++) {
            const w = body[k];
            if (!allowedAt(w.canonical, i)) continue;
            if (credOf(i) + w.credits > room() - geHold) continue;
            if (!feasibleAt(w.canonical, i, sched)) continue;
            terms[i].push(w.spec); place.set(w.canonical, i); body.splice(k, 1); k--; progressed = true;
          }
        }
        if (ge.length && credOf(i) + creditsOf(ge[0], catalog) <= room()) terms[i].push(ge.shift()!);
        for (const pool of [el, ge]) {
          while (pool.length && credOf(i) + creditsOf(pool[0], catalog) <= room()) terms[i].push(pool.shift()!);
        }
      }
      // Every body course must have landed in the target term count.
      if (body.length) return null;
      // Capstone into its reserved final terms; must stay prereq-feasible there.
      for (const w of caps) {
        const i = capTermOf.get(w.canonical)!;
        if (!allowedAt(w.canonical, i) || credOf(i) + w.credits > capAt(i) || !feasibleAt(w.canonical, i, buildSchedFrom(place))) return null;
        terms[i].push(w.spec); place.set(w.canonical, i);
      }
      // Any slots that didn't fit during the term-by-term fill (capstone terms
      // held room in reserve) settle into whatever room remains.
      for (const pool of [el, ge]) {
        for (const slot of pool) {
          let placed = false;
          for (let i = 0; i < target; i++) {
            if (credOf(i) + creditsOf(slot, catalog) <= capAt(i)) { terms[i].push(slot); placed = true; break; }
          }
          if (!placed) return null;
        }
      }
      return terms;
    };
    const floorTarget = Math.max(1, Math.ceil(totalCredits / maxCredits), opts.targetSemesters ?? 0);
    for (let target = floorTarget; target < newTerms.length; target++) {
      const packed = attempt(target);
      if (!packed) continue;
      newTerms.length = 0;
      for (const t of packed) newTerms.push(t);
      placedSem.clear();
      packed.forEach((t, i) => { for (const it of t) if ("code" in it) placedSem.set(catalog[it.code]?.code ?? it.code, i); });
      gePool.length = 0; elPool.length = 0; // every slot was placed in the re-pack
      break;
    }
  };
  capReserveFloor();

  // Any slots still unplaced land in the latest terms with room — never
  // silently dropped; fresh trailing terms are appended as a last resort.
  for (const pool of [gePool, elPool]) {
    while (pool.length) {
      let placedOne = false;
      for (let t = newTerms.length - 1; t >= 0 && pool.length; t--) {
        if (creditsOfTerm(newTerms[t]) + creditsOf(pool[0], catalog) <= capAt(t)) {
          newTerms[t].push(pool.shift()!);
          placedOne = true;
          break;
        }
      }
      if (!placedOne) newTerms.push([pool.shift()!]);
    }
  }

  // Light-term rebalance: any non-empty regular term under the 14-credit
  // full-time floor pulls slots (prereq-free, freely movable) from the
  // EARLIEST terms that can spare them — donors stay >= 14 themselves. This
  // fills the remainder tail to full-time and nudges electives later, which is
  // the bulletin's own shape anyway.
  for (let t = 0; t < newTerms.length; t++) {
    if (isSummer(t) || newTerms[t].length === 0) continue;
    while (creditsOfTerm(newTerms[t]) < 14) {
      let moved = false;
      // Direction-aware donor preference, matching the bulletin's shape: a
      // LATE light term pulls electives first (they belong late); an EARLY
      // light term pulls gen eds first (they're front-loaded) so electives
      // aren't dragged forward against the gradient.
      const lateReceiver = t >= newTerms.length / 2;
      for (const wantEl of lateReceiver ? [true, false] : [false, true]) {
        for (let d = 0; d < newTerms.length && !moved; d++) {
          if (d === t) continue;
          const si = newTerms[d].findIndex((it) => "slot" in it && (it.slot === "EL") === wantEl);
          if (si < 0) continue;
          const cr = creditsOf(newTerms[d][si], catalog);
          // Donors may drop to 12 — PSU's actual full-time floor — so the
          // aggregate slack can concentrate where it's needed; receivers aim
          // for the realistic 14+ band.
          if (creditsOfTerm(newTerms[d]) - cr < (isSummer(d) ? 0 : 12)) continue;
          if (creditsOfTerm(newTerms[t]) + cr > capAt(t)) continue;
          const [slot] = newTerms[d].splice(si, 1);
          newTerms[t].push(slot);
          moved = true;
        }
        if (moved) break;
      }
      if (!moved) break;
    }
  }

  // Trim empty trailing terms (the capstone scan may have extended past its
  // landing spot). This is the auto-delete of incidental 0-credit terms; a
  // deliberate gap is spliced in BELOW, after the trim, so it survives.
  while (newTerms.length > 1 && newTerms[newTerms.length - 1].length === 0) newTerms.pop();

  // ---- Splice the intentional gap semesters back in ------------------------
  // Insert an empty term at each requested position (adjusting for gaps already
  // inserted before it), shifting the packed coursework one term later — the
  // student isn't enrolled that term, so graduation moves back by that term.
  const gapTerm = new WeakSet<PlanItemSpec[]>();
  gapPositions.forEach((g, k) => {
    const pos = Math.min(g + k, newTerms.length);
    const empty: PlanItemSpec[] = [];
    gapTerm.add(empty);
    newTerms.splice(pos, 0, empty);
  });

  // ---- Reattach the preserved IUG graduate terms after the undergrad half,
  // then relabel everything through the term sequence (summers included). -----
  const allTerms: PlanTerm[] = [
    ...newTerms.map((items) => ({ label: "", items, ...(gapTerm.has(items) ? { gap: true } : {}) } as PlanTerm)),
    ...gradTerms,
  ];
  plan.terms = allTerms.map((t, i) => ({ ...t, label: seq[i]?.label ?? `Term ${i + 1}` }));
  plan.moves = {}; // positions were re-derived; stale overrides would corrupt
  plan.removed = removed;
  return {
    changed: true,
    semestersBefore,
    semestersAfter: plan.terms.length,
    maxCredits,
    capstoneNote: resolution.note,
    droppedCapstone: resolution.drop,
    targetMissed: opts.targetSemesters ? plan.terms.length > opts.targetSemesters : false,
  };
}

/** Spread `count` indivisible items across `n` buckets in proportion to a
 * per-bucket weight (largest-remainder apportionment). Used to lay elective
 * placeholders onto the mined elective curve. */
function distributeWeighted(count: number, n: number, weight: (s: number) => number): number[] {
  const quota = new Array(n).fill(0);
  if (count <= 0 || n <= 0) return quota;
  const weights = Array.from({ length: n }, (_, s) => Math.max(0, weight(s)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    for (let i = 0; i < count; i++) quota[i % n] += 1;
    return quota;
  }
  const ideal = weights.map((w) => (w / total) * count);
  let assigned = 0;
  for (let s = 0; s < n; s++) { quota[s] = Math.floor(ideal[s]); assigned += quota[s]; }
  const rema = ideal.map((v, s) => ({ s, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  for (let i = 0; assigned < count && i < rema.length; i++) { quota[rema[i].s] += 1; assigned++; }
  for (let s = n - 1; assigned < count && s >= 0; s--) { if (weights[s] > 0) { quota[s]++; assigned++; } }
  return quota;
}
