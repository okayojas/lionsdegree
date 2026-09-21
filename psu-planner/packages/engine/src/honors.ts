/** Schreyer Honors College requirements: per-window honors-credit audit and
 * honors-section upgrades so a generated schedule MEETS the requirement, not
 * just reports on it.
 *
 * Requirements (shc.psu.edu/academics/requirements/, retrieved 2026-07-16):
 *   First-year admits:  "Complete 21 honors credits during your first and
 *     second years (includes ENGL/CAS 137H/138T)" — the RCL sequence must be
 *     passed (C+) "during your first two semesters" — then "Complete 14 honors
 *     credits during your third and fourth years."
 *   Second-year admits: 9 honors credits in year two, then 14 in years 3-4.
 *   Third-year admits:  14 honors credits in years 3-4.
 *   All: an approved honors thesis; semester + cumulative GPA >= 3.40 (GPA is
 *   not schedulable — surfaced as a note only).
 *
 * What counts, catalog-detectably: courses carrying the "Honors" attribute or
 * an H/M number suffix (ENGL 138T carries the attribute). Honors OPTIONS on
 * regular sections and graduate courses also count in reality but are not
 * visible in the course catalog — shortfalls therefore say "honors options can
 * cover the rest", never silently assume them (conservative degradation).
 *
 * The upgrade pass swaps prescribed courses for their real H-variant twins
 * (MATH 140 -> MATH 140H, EDSGN 100 -> EDSGN 100H...) and, for first-year
 * admits, ENGL 15 -> ENGL/CAS 137H and CAS 100 -> ENGL/CAS 138T (the RCL pair
 * carries GWS, so the gen-ed audit keeps working). Originals are kept as
 * alternatives so one click swaps back. */
import { academicYearOf, parseTermLabel } from "./terms.js";
import type { Catalog, Course, CourseSpec, PlanDoc } from "./types.js";

export const HONORS_ATTR = "Honors";

export function isHonorsCourse(c: Course): boolean {
  return c.attributes.includes(HONORS_ATTR) || /[HM]$/.test(c.number);
}

export interface HonorsWindow {
  /** 1-based academic years this window spans; the last window runs to graduation. */
  years: [number, number];
  credits: number;
  label: string;
}

/** Requirement windows per admit cohort. The 3rd-4th-year window is treated as
 * running to graduation for plans longer than four years. */
export function honorsWindows(admit: 1 | 2 | 3): HonorsWindow[] {
  if (admit === 1) {
    return [
      { years: [1, 2], credits: 21, label: "years 1-2 (21 honors credits, incl. ENGL/CAS 137H-138T)" },
      { years: [3, 99], credits: 14, label: "years 3-4 (14 honors credits)" },
    ];
  }
  if (admit === 2) {
    return [
      { years: [2, 2], credits: 9, label: "year 2 (9 honors credits)" },
      { years: [3, 99], credits: 14, label: "years 3-4 (14 honors credits)" },
    ];
  }
  return [{ years: [3, 99], credits: 14, label: "years 3-4 (14 honors credits)" }];
}

/** Current academic year from completed credits (PSU standing: ~30 cr/year). */
export function academicYearFromCredits(completedCredits: number): number {
  return Math.min(4, 1 + Math.floor(completedCredits / 30));
}

const RCL_I = ["ENGL 137H", "CAS 137H"];
const RCL_II = ["ENGL 138T", "CAS 138T"];
const THESIS_TITLE = /\b(thesis|senior research|senior design)\b/i;

export interface HonorsAudit {
  scholar: boolean;
  currentYear: number;
  windows: { label: string; need: number; have: number; shortfall: number }[];
  /** RCL sequence status (first-year admits only; null otherwise). */
  rcl: { met: boolean; missing: string[] } | null;
  thesis: { met: boolean; by: string | null };
  notes: string[];
}

function creditsOf(catalog: Catalog, code: string): number {
  return catalog[code]?.creditsParsed?.min ?? 3;
}

/** Plan term index -> 1-based academic year, counting from the student's
 * current year (derived from completed credits). Label-aware: PSU academic
 * years run Fall -> Spring -> Summer, so an opt-in summer session counts
 * toward the academic year it closes (Summer 2027 belongs to AY 2026-27) —
 * exactly how Schreyer counts honors-credit years. Falls back to Fall/Spring
 * pairing when labels are unparseable. */
export function planYearOfTerm(termIdx: number, currentYear: number, plan?: PlanDoc): number {
  const firstRef = plan ? parseTermLabel(plan.terms[0]?.label ?? "") : null;
  const ref = plan ? parseTermLabel(plan.terms[termIdx]?.label ?? "") : null;
  if (firstRef && ref) return currentYear - 1 + academicYearOf(ref, firstRef);
  return currentYear + Math.floor(termIdx / 2);
}

export function auditHonors(plan: PlanDoc, catalog: Catalog): HonorsAudit {
  if (!plan.honors) {
    return { scholar: false, currentYear: 1, windows: [], rcl: null, thesis: { met: false, by: null }, notes: [] };
  }
  const removed = plan.removed ?? {};
  const completedCodes = Object.keys(plan.completed).filter((c) => plan.completed[c]);
  const completedCredits = completedCodes.reduce((s, c) => s + creditsOf(catalog, c), 0);
  const currentYear = academicYearFromCredits(completedCredits);
  const windows = honorsWindows(plan.honors.admit).map((w) => ({ ...w, have: 0 }));

  // Planned honors courses count toward the window their plan year falls in.
  const planned: { code: string; year: number }[] = [];
  plan.terms.forEach((t, i) => {
    for (const it of t.items) {
      if ("slot" in it) {
        const fill = plan.slotFills[it.id];
        if (fill && !removed[it.id]) planned.push({ code: fill, year: planYearOfTerm(i, currentYear, plan) });
      } else if (!removed[it.code]) {
        planned.push({ code: it.code, year: planYearOfTerm(i, currentYear, plan) });
      }
    }
  });
  for (const a of plan.added) planned.push({ code: a.code, year: planYearOfTerm(a.sem, currentYear, plan) });
  for (const { code, year } of planned) {
    const c = catalog[code];
    if (!c || !isHonorsCourse(c)) continue;
    const w = windows.find((w) => year >= w.years[0] && year <= w.years[1]);
    if (w) w.have += c.creditsParsed?.min ?? 3;
  }

  // Completed honors credits pool into windows chronologically (fill the
  // earliest window first, spill forward). We can't know which past year a
  // completed course was taken in; earliest-first matches how SHC would have
  // already reviewed past years and is exact for the common cases (a Gateway
  // junior's prior honors work fills the years-1-2 window before 3-4).
  let pool = completedCodes
    .map((code) => catalog[code])
    .filter((c): c is Course => !!c && isHonorsCourse(c))
    .reduce((s, c) => s + (c.creditsParsed?.min ?? 3), 0);
  for (const w of windows) {
    const take = Math.min(pool, w.credits - Math.min(w.have, w.credits));
    if (take > 0) { w.have += take; pool -= take; }
  }

  // RCL sequence (first-year admits): the rule is "during your first two
  // semesters" — completed counts; a scheduled course only counts if it sits
  // in the first two plan terms (presence alone isn't enough; the optimizer
  // could have drifted it later).
  let rcl: HonorsAudit["rcl"] = null;
  if (plan.honors.admit === 1) {
    const termOf = new Map<string, number>();
    plan.terms.forEach((t, i) => {
      for (const it of t.items) if (!("slot" in it) && !removed[it.code] && !termOf.has(it.code)) termOf.set(it.code, i);
    });
    const has = (group: string[]) =>
      group.some((code) => plan.completed[code]) ||
      group.some((code) => (termOf.get(code) ?? 99) <= 1);
    const missing = [
      ...(has(RCL_I) ? [] : ["ENGL/CAS 137H"]),
      ...(has(RCL_II) ? [] : ["ENGL/CAS 138T"]),
    ];
    rcl = { met: missing.length === 0, missing };
  }

  // Thesis vehicle: an honors course whose title reads thesis/senior research/
  // senior design, or a 494H research course, planned or completed.
  let thesisBy: string | null = null;
  for (const code of [...planned.map((p) => p.code), ...completedCodes]) {
    const c = catalog[code];
    if (!c || !isHonorsCourse(c)) continue;
    if (THESIS_TITLE.test(c.title) || /494H$/.test(c.code)) { thesisBy = c.code; break; }
  }

  const notes: string[] = [];
  const out = windows.map((w) => ({
    label: w.label, need: w.credits, have: Math.round(w.have * 10) / 10,
    shortfall: Math.max(0, Math.round((w.credits - w.have) * 10) / 10),
  }));
  for (const w of out) {
    if (w.shortfall > 0) {
      notes.push(`${w.label}: ${w.shortfall} honors credits short — honors options on regular courses and graduate courses also count (arrange with the instructor; not shown in the catalog).`);
    }
  }
  if (rcl && !rcl.met) notes.push(`Schedule ${rcl.missing.join(" and ")} in your first two semesters (C or better required).`);
  if (!thesisBy) notes.push("No honors thesis vehicle detected — plan thesis credits (e.g. a 494H) with your honors adviser.");
  notes.push("Maintain a 3.40 semester and cumulative GPA (Schreyer good standing).");
  return { scholar: true, currentYear, windows: out, rcl, thesis: { met: !!thesisBy, by: thesisBy }, notes };
}

export interface HonorsUpgradeResult {
  upgrades: { from: string; to: string }[];
  note: string | null;
}

/** Swap prescribed courses for their catalog-verified honors twins until each
 * requirement window is met (or no more twins exist). First-year admits also
 * get the RCL swap (ENGL 15 -> ENGL/CAS 137H, CAS 100 -> 138T). Originals stay
 * in `alternatives` for one-click swap-back. Idempotent: already-honors
 * courses and already-met windows are left alone. */
export function applyHonorsUpgrades(plan: PlanDoc, catalog: Catalog): HonorsUpgradeResult {
  if (!plan.honors) return { upgrades: [], note: null };
  const upgrades: { from: string; to: string }[] = [];
  const removed = plan.removed ?? {};

  const swapSpec = (spec: CourseSpec, to: string) => {
    const from = spec.code;
    spec.alternatives = [from, ...(spec.alternatives ?? []).filter((a) => a !== to && a !== from)];
    spec.code = to;
    upgrades.push({ from, to });
  };

  // RCL first (it's a named requirement, not just credits). The rule says
  // "during your first two semesters", so the swapped course is PINNED there:
  // moved into term 0/1 and given a first-year template origin so the
  // flow-rank optimizer keeps it early on every future re-pack.
  if (plan.honors.admit === 1) {
    const rclSwaps: [RegExp, string, number][] = [
      [/^ENGL (15|30)$/, "ENGL 137H", 0],
      [/^CAS 100[A-C]?$/, "CAS 138T", 1],
    ];
    const findTerm = (codes: string[]): number => {
      for (let i = 0; i < plan.terms.length; i++) {
        if (plan.terms[i].items.some((it) => !("slot" in it) && codes.includes(it.code))) return i;
      }
      return -1;
    };
    for (const [re, to, pinTerm] of rclSwaps) {
      if (!catalog[to]) continue;
      const twinCodes = [to, to.replace("ENGL", "CAS"), to.replace("CAS", "ENGL")];
      if (twinCodes.some((c) => plan.completed[c])) continue;
      const existingAt = findTerm(twinCodes);
      let spec: CourseSpec | null = null;
      let fromTerm = -1;
      if (existingAt >= 0) {
        // Already swapped on a previous run — just re-pin if it drifted late.
        if (existingAt <= 1) continue;
        fromTerm = existingAt;
        spec = plan.terms[existingAt].items.find((it): it is CourseSpec => !("slot" in it) && twinCodes.includes(it.code)) ?? null;
      } else {
        for (let i = 0; i < plan.terms.length && !spec; i++) {
          const hit = plan.terms[i].items.find((it): it is CourseSpec => !("slot" in it) && !removed[it.code] && re.test(it.code));
          if (hit) { spec = hit; fromTerm = i; }
        }
        if (spec) swapSpec(spec, to);
      }
      if (!spec || fromTerm < 0) continue;
      // Pin to the first two semesters (requirement wording), physically and
      // via origin so future optimizes keep it there.
      const target = Math.min(pinTerm, Math.max(0, plan.terms.length - 1));
      if (fromTerm !== target) {
        const src = plan.terms[fromTerm].items;
        src.splice(src.indexOf(spec), 1);
        plan.terms[target].items.push(spec);
        // Keep the credit balance: send one open slot back the other way so a
        // packed target term doesn't blow the 19-credit cap.
        const slotIdx = plan.terms[target].items.findIndex((it) => "slot" in it && !removed[it.id] && !plan.slotFills[it.id]);
        if (slotIdx >= 0) {
          const [slot] = plan.terms[target].items.splice(slotIdx, 1);
          plan.terms[fromTerm].items.push(slot);
        }
      }
      spec.origin = { program: spec.origin?.program ?? plan.programs[0] ?? "", templateSem: pinTerm };
    }
  }

  // Credit windows: upgrade non-honors courses to existing H-twins, earliest
  // term first, until the window's need is met.
  const audit0 = auditHonors(plan, catalog);
  const currentYear = audit0.currentYear;
  const windows = honorsWindows(plan.honors.admit);
  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    let shortfall = audit0.windows[wi]?.shortfall ?? 0;
    if (shortfall <= 0) continue;
    for (let ti = 0; ti < plan.terms.length && shortfall > 0; ti++) {
      const year = planYearOfTerm(ti, currentYear, plan);
      if (year < w.years[0] || year > w.years[1]) continue;
      for (const it of plan.terms[ti].items) {
        if (shortfall <= 0) break;
        if ("slot" in it || removed[it.code]) continue;
        const c = catalog[it.code];
        if (!c || isHonorsCourse(c)) continue;
        const twin = catalog[it.code + "H"];
        if (!twin || !isHonorsCourse(twin)) continue;
        swapSpec(it, twin.code);
        shortfall -= twin.creditsParsed?.min ?? 3;
      }
    }
  }

  const note = upgrades.length
    ? `switched ${upgrades.length} course${upgrades.length > 1 ? "s" : ""} to honors sections (${upgrades.map((u) => u.to).join(", ")}) toward your Schreyer credit requirement — originals are one click away under each card's alternatives`
    : null;
  return { upgrades, note };
}
