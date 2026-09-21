/** Generate a personalized PlanDoc from pipeline suggested-plan templates.
 * Merging rule for multi-program: union by term index, dedupe shared courses
 * (first program wins the card; both get credit via sourcePrograms tags). */
import { codeMatchesPool, resolveSlotPool, type ReqSection } from "./requirements.js";
import type { PlanDoc, PlanItemSpec, PlanTerm } from "./types.js";

export interface TemplateEntry {
  type: "course" | "genEd" | "placeholder";
  code?: string;
  label?: string;
  domain?: string | null;
  credits: number | null;
  alternatives?: string[];
  unverified?: boolean;
}
export interface TemplateSemester {
  year: number;
  term: string;
  label: string;
  credits: number | null;
  entries: TemplateEntry[];
}
export interface ProgramTemplate {
  slug: string;
  name: string;
  campusLabel: string;
  semesters: TemplateSemester[];
  /** Structured requirement sections from the pipeline — used to fulfill one
   * program's elective slots with another program's courses, and to derive a
   * plan for minors/certificates that have no suggested-plan grid. */
  requirements?: ReqSection[];
}

export interface GenPlanOptions {
  /** e.g. { term: "Fall", year: 2026 } — first not-yet-completed semester. */
  startTerm: { term: "Fall" | "Spring"; year: number };
  /** Ground truth of progress: courses taken (incl. AP/transfer credit). The
   * template is walked in full and satisfied entries drop out; semesters that
   * end up empty are compacted away. */
  completedCourses: string[];
  /** Legacy escape hatch: skip the first N template semesters wholesale.
   * Course-based onboarding passes 0 (or omits). */
  semestersCompleted?: number;
  /** code -> gen-ed domains (from the catalog). When provided, completed
   * courses carrying gen-ed attributes consume matching gen-ed slots, so a
   * transfer GHW course removes a GHW slot from the generated plan. */
  genEdTags?: Record<string, string[]>;
  /** DIRECTIONAL coverage mined from bulletin descriptions: coveredBy[X] lists
   * courses whose content subsumes X (MATH 250 -> [MATH 251]). A completed
   * covering course satisfies the requirement for X; never the reverse. */
  coveredBy?: Record<string, string[]>;
}

function termLabels(start: GenPlanOptions["startTerm"], count: number): string[] {
  const labels: string[] = [];
  let term = start.term;
  let year = start.year;
  for (let i = 0; i < count; i++) {
    labels.push(`${term} ${year}`);
    if (term === "Fall") { term = "Spring"; year += 1; }
    else term = "Fall";
  }
  return labels;
}

/** Slot dedupe key: gen-ed slots collapse by domain, electives by normalized
 * label — parenthetical qualifiers, hyphens, and plurals are ignored so
 * "Technical Elective (400-level)" and "Technical Electives" share one set
 * across a double major. */
function normSlotLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/s$/, ""))
    .join(" ");
}
function slotKind(e: TemplateEntry): string {
  if (e.type === "genEd") return "genEd:" + (e.domain ?? "GE");
  return "ph:" + normSlotLabel(e.label ?? "Elective");
}

export function generatePlan(programs: ProgramTemplate[], opts: GenPlanOptions, planId: string): PlanDoc {
  const completedSet = new Set(opts.completedCourses);
  const semsDone = opts.semestersCompleted ?? 0;
  const numSems = Math.max(...programs.map((p) => p.semesters.length), 1);
  const remainingSems: PlanTerm[] = [];
  const seenCourses = new Set<string>();
  let slotSeq = 0;

  // A course entry is satisfied if its code OR any listed alternative
  // ("CMPSC 121 or 131") was completed / already placed, a completed course
  // COVERS it (MATH 251 covers MATH 250 — directional), or the student
  // completed its honors section (MATH 140H satisfies MATH 140 — one way,
  // never the reverse).
  const coverSatisfied = (code: string): boolean =>
    (opts.coveredBy?.[code] ?? []).some((sup) => completedSet.has(sup));
  const honorsTwinDone = (code: string): boolean =>
    completedSet.has(code + "H") || completedSet.has(code + "M");
  const entrySatisfied = (e: TemplateEntry): boolean => {
    const codes = [e.code!, ...(e.alternatives ?? [])];
    return codes.some((c) => completedSet.has(c) || seenCourses.has(c) || coverSatisfied(c) || honorsTwinDone(c));
  };

  // ---- Cross-program requirement fulfillment ------------------------------
  // Pass 1: which concrete courses will each program place? A slot in program
  // A (e.g. ESC's "Foundational Elective") can be fulfilled by a course that
  // program B's curriculum places anyway (e.g. an AIE prescribed course), or
  // by a completed/imported course. Each fulfilling course is consumed once.
  const coursesByProgram = new Map<string, Set<string>>();
  const allTemplateCodes = new Set<string>();
  {
    const placed = new Set<string>();
    for (const prog of programs) {
      const mine = new Set<string>();
      for (let si = 0; si < prog.semesters.length; si++) {
        for (const e of prog.semesters[si].entries) {
          if (e.type !== "course" || !e.code) continue;
          allTemplateCodes.add(e.code);
          for (const a of e.alternatives ?? []) allTemplateCodes.add(a);
          if (si < semsDone) continue;
          const codes = [e.code, ...(e.alternatives ?? [])];
          if (codes.some((c) => completedSet.has(c) || placed.has(c) || coverSatisfied(c))) continue;
          placed.add(e.code);
          mine.add(e.code);
        }
      }
      coursesByProgram.set(prog.slug, mine);
    }
  }
  const consumedForSlots = new Set<string>();
  /** Course pool that may fulfill `prog`'s slot: other programs' planned
   * courses + completed courses (each usable once across all slots). */
  const slotFulfilledBy = (prog: ProgramTemplate, label: string): string | null => {
    if (!prog.requirements?.length) return null;
    const pool = resolveSlotPool(label, prog.requirements);
    if (!pool.courses.size && !pool.patterns.length) return null;
    for (const [slug, codes] of coursesByProgram) {
      if (slug === prog.slug) continue;
      for (const code of codes) {
        if (!consumedForSlots.has(code) && codeMatchesPool(code, pool)) {
          consumedForSlots.add(code);
          return code;
        }
      }
    }
    for (const code of completedSet) {
      if (!consumedForSlots.has(code) && !seenCourses.has(code) && codeMatchesPool(code, pool)) {
        consumedForSlots.add(code);
        return code;
      }
    }
    return null;
  };

  // Gen-ed and elective requirements are university-wide, not per-program: a
  // double major needs the MAX slot count of any single program per kind, not
  // the sum. Slots completed semesters would have consumed are subtracted.
  const slotBudget = new Map<string, number>();
  for (const prog of programs) {
    const mine = new Map<string, number>();
    for (let si = semsDone; si < prog.semesters.length; si++) {
      for (const e of prog.semesters[si].entries) {
        if (e.type === "course") continue;
        const k = slotKind(e);
        mine.set(k, (mine.get(k) ?? 0) + 1);
      }
    }
    for (const [k, n] of mine) slotBudget.set(k, Math.max(slotBudget.get(k) ?? 0, n));
  }

  // Completed courses carrying gen-ed attributes (AP credit, transfer, extra
  // courses) consume matching gen-ed slots — a done GHW course means one fewer
  // GHW card. Template courses are excluded: they satisfy their own named
  // requirement, not the generic slots. Specific domains first, generic GE as
  // the fallback.
  if (opts.genEdTags) {
    for (const code of completedSet) {
      if (allTemplateCodes.has(code) || consumedForSlots.has(code)) continue;
      const domains = opts.genEdTags[code];
      if (!domains?.length) continue;
      let key = domains.map((d) => "genEd:" + d).find((k) => (slotBudget.get(k) ?? 0) > 0);
      if (!key && (slotBudget.get("genEd:GE") ?? 0) > 0) key = "genEd:GE";
      if (key) {
        slotBudget.set(key, slotBudget.get(key)! - 1);
        consumedForSlots.add(code);
      }
    }
  }
  const slotUsed = new Map<string, number>();

  const remainingCount = numSems - semsDone;
  const labels = termLabels(opts.startTerm, Math.max(remainingCount, 1));

  for (let si = semsDone; si < numSems; si++) {
    const items: PlanItemSpec[] = [];
    for (const prog of programs) {
      const sem = prog.semesters[si];
      if (!sem) continue;
      for (const e of sem.entries) {
        if (e.type === "course" && e.code) {
          if (entrySatisfied(e)) continue;
          seenCourses.add(e.code);
          items.push({
            code: e.code, alternatives: e.alternatives ?? [], unverified: e.unverified,
            origin: { program: prog.slug, templateSem: si },
          });
        } else {
          const k = slotKind(e);
          const used = slotUsed.get(k) ?? 0;
          if (used >= (slotBudget.get(k) ?? 0)) continue; // covered by the other program's slots
          slotUsed.set(k, used + 1);
          // Elective slot already satisfied by another program's course or a
          // completed course? Then it needs no card at all.
          if (e.type === "placeholder" && e.label && slotFulfilledBy(prog, e.label)) continue;
          const slot = e.type === "genEd" ? (e.domain ?? "GE") : "EL";
          items.push({
            slot,
            id: `${slot}-${si}-${slotSeq++}`,
            credits: e.credits,
            label: e.label ?? (e.type === "genEd" ? "General Education" : "Elective"),
            program: prog.slug,
            origin: { program: prog.slug, templateSem: si },
          });
        }
      }
    }
    remainingSems.push({ label: labels[si - semsDone] ?? `Semester ${si + 1}`, items });
  }

  // Courses from completed semesters that the student has NOT ticked off get
  // pulled forward into the first remaining semester (they still owe them).
  const owed: PlanItemSpec[] = [];
  for (const prog of programs) {
    for (let si = 0; si < Math.min(semsDone, prog.semesters.length); si++) {
      for (const e of prog.semesters[si].entries) {
        if (e.type === "course" && e.code && !entrySatisfied(e)) {
          seenCourses.add(e.code);
          owed.push({
            code: e.code, alternatives: e.alternatives ?? [], unverified: e.unverified,
            origin: { program: prog.slug, templateSem: si },
          });
        }
      }
    }
  }
  if (owed.length) {
    // A student past the template's last semester still needs a term to hold
    // what they owe.
    if (!remainingSems.length) remainingSems.push({ label: labels[0] ?? "Next semester", items: [] });
    remainingSems[0].items.unshift(...owed);
  }

  // ---- Minors & certificates without a suggested-plan grid ----------------
  // Their requirements still shape the plan: prescribed courses get scheduled,
  // choice groups check for overlap with what's already planned/completed
  // ("assume the overlap, only add if necessary"), and any shortfall becomes
  // labeled slots. Additions spread across the back half of the plan.
  const allPlanned = new Set<string>([...seenCourses, ...completedSet]);
  const planlessAdds: PlanItemSpec[] = [];
  for (const prog of programs) {
    if (prog.semesters.length > semsDone || !prog.requirements?.length) continue;
    for (const section of prog.requirements) {
      for (const rule of section.rules) {
        if (rule.type === "course") {
          if (allPlanned.has(rule.code) || coverSatisfied(rule.code)) continue;
          allPlanned.add(rule.code);
          seenCourses.add(rule.code);
          planlessAdds.push({ code: rule.code });
        } else if (rule.type === "oneOf" || rule.type === "chooseN") {
          const n = rule.type === "chooseN" ? rule.n : 1;
          const satisfied = rule.options.filter((c) => allPlanned.has(c) || coverSatisfied(c)).length;
          for (let i = 0; i < Math.max(0, n - satisfied); i++) {
            planlessAdds.push({
              slot: "EL",
              id: `EL-${prog.slug}-${slotSeq++}`,
              credits: rule.credits,
              label: `${section.heading} (${prog.name})`,
              program: prog.slug,
            });
          }
        } else if (rule.type === "selectCredits" && rule.credits) {
          const options = rule.from?.kind === "courses" ? rule.from.courses : [];
          const overlap = options.filter((c) => allPlanned.has(c)).length;
          const needed = Math.max(0, Math.ceil(rule.credits / 3) - overlap);
          for (let i = 0; i < needed; i++) {
            planlessAdds.push({
              slot: "EL",
              id: `EL-${prog.slug}-${slotSeq++}`,
              credits: 3,
              label: `${section.heading} (${prog.name})`,
              program: prog.slug,
            });
          }
        }
      }
    }
  }
  if (planlessAdds.length) {
    if (!remainingSems.length) remainingSems.push({ label: labels[0] ?? "Next semester", items: [] });
    // Round-robin into the back half so minors don't pile onto semester 1.
    const start = Math.floor(remainingSems.length / 2);
    planlessAdds.forEach((it, i) => {
      const sem = start + (i % Math.max(1, remainingSems.length - start));
      // Anchor the optimizer to the same back-half placement (semsDone offset
      // keeps it comparable with template-derived origins, which are absolute).
      it.origin = { program: it.origin?.program ?? ("slot" in it ? it.program : undefined) ?? programs[0]?.slug ?? "", templateSem: semsDone + sem };
      remainingSems[sem].items.push(it);
    });
  }

  // ---- Compaction: course-based progress empties some template semesters
  // (everything in them already taken) — drop them and relabel sequentially,
  // so a major-switcher's plan starts at their actual next semester with the
  // early courses they still owe pulled to the front.
  const compacted = remainingSems.filter((t) => t.items.length > 0);
  const finalTerms = compacted.length ? compacted : remainingSems.slice(0, 1);
  const finalLabels = termLabels(opts.startTerm, finalTerms.length);
  finalTerms.forEach((t, i) => { t.label = finalLabels[i] ?? t.label; });

  const completed: Record<string, boolean> = {};
  for (const c of opts.completedCourses) completed[c] = true;

  return {
    id: planId,
    rev: 1,
    updatedAt: new Date().toISOString(),
    programs: programs.map((p) => p.slug),
    terms: finalTerms,
    completed,
    moves: {},
    slotFills: {},
    added: [],
    removed: {},
    view: null,
  };
}
