/** PSU General Education framework: category-aware audit, slot refinement, and
 * double-count-optimized suggestions.
 *
 * Framework (2025-2026 bulletin, "Baccalaureate Degree General Education
 * Program" — bulletins.psu.edu/undergraduate/general-education/): 45 credits =
 *   Foundations 15  — GWS 9 (writing/speaking, C or better), GQ 6 (quantification)
 *   Knowledge Domains 15 — GHW 3, GN 3, GA 3, GH 3, GS 3
 *   Integrative Studies 6 — Inter-domain (N-suffix) courses
 *   Exploration 9 — GN 3, plus 6 from GA/GH/GN/GS or inter-domain
 *
 * Rules encoded (quoted from the bulletin / Faculty Senate 150-00):
 *   - Department restriction: "Students may not meet the General Education
 *     Breadth in Knowledge Domains and Exploration components by taking courses
 *     in the department or program identical to that of the academic major."
 *     Integrative Studies is exempt; Foundations carry no such restriction.
 *     We apply it CONSERVATIVELY: only to courses the student added or
 *     completed on their own — courses the program's own template places are
 *     bulletin-endorsed ("Program requirements that may also satisfy General
 *     Education requirements vary for each program") and always count.
 *   - US/IL overlay: 3 credits United States Cultures + 3 credits International
 *     Cultures, which "may be fulfilled by double-counting with other General
 *     Education courses, courses in the major or minor, electives" — but a
 *     single course may NOT fulfill both US and IL.
 *
 * The audit is deterministic arithmetic over catalog attributes (iron rule 1);
 * BA-specific requirements (BA: Arts etc.) and the world-language Exploration
 * option are out of scope for now (engineering-first) and noted here so the
 * gap is explicit. */
import type { Catalog, Course, PlanDoc, SlotSpec } from "./types.js";

export const INTERDOMAIN_ATTR = "- Integrative: Interdomain";
export const US_ATTR = "United States Cultures: (US)";
export const IL_ATTR = "International Cultures: (IL)";

export interface GenEdBucket {
  key: string;
  label: string;
  credits: number;
  /** genEd attribute values that qualify (interdomain handled separately). */
  domains: string[];
  /** Inter-domain courses qualify ("only" = nothing else does). */
  interdomain: "no" | "also" | "only";
  /** Subject to the own-department restriction (Knowledge Domains + Exploration). */
  deptRestricted: boolean;
}

/** Assignment order = most-specific first, so a course lands where it's
 * genuinely needed before flexible buckets absorb it. */
export const GENED_BUCKETS: GenEdBucket[] = [
  { key: "GWS", label: "Foundations: Writing/Speaking (GWS)", credits: 9, domains: ["GWS"], interdomain: "no", deptRestricted: false },
  { key: "GQ", label: "Foundations: Quantification (GQ)", credits: 6, domains: ["GQ"], interdomain: "no", deptRestricted: false },
  { key: "GHW", label: "Health & Wellness (GHW)", credits: 3, domains: ["GHW"], interdomain: "no", deptRestricted: true },
  { key: "GN", label: "Natural Sciences (GN)", credits: 3, domains: ["GN"], interdomain: "no", deptRestricted: true },
  { key: "GA", label: "Arts (GA)", credits: 3, domains: ["GA"], interdomain: "no", deptRestricted: true },
  { key: "GH", label: "Humanities (GH)", credits: 3, domains: ["GH"], interdomain: "no", deptRestricted: true },
  { key: "GS", label: "Social & Behavioral Sciences (GS)", credits: 3, domains: ["GS"], interdomain: "no", deptRestricted: true },
  { key: "INTER", label: "Integrative Studies: Inter-domain (N)", credits: 6, domains: [], interdomain: "only", deptRestricted: false },
  { key: "EXPGN", label: "Exploration: Natural Sciences (GN)", credits: 3, domains: ["GN"], interdomain: "no", deptRestricted: true },
  { key: "EXP", label: "Exploration (GA/GH/GN/GS or inter-domain)", credits: 6, domains: ["GA", "GH", "GN", "GS"], interdomain: "also", deptRestricted: true },
];
const BUCKET_BY_KEY = new Map(GENED_BUCKETS.map((b) => [b.key, b]));

export function isInterdomain(c: Course): boolean {
  return c.genEd.includes(INTERDOMAIN_ATTR);
}
function domainsOf(c: Course): string[] {
  return c.genEd.filter((g) => g !== INTERDOMAIN_ATTR);
}

/** Can `course` fill `bucket`? (Ignores the department restriction — the
 * caller decides whether that applies to this course.) */
export function bucketAccepts(bucket: GenEdBucket, course: Course): boolean {
  const inter = isInterdomain(course);
  if (bucket.interdomain === "only") return inter;
  if (inter && bucket.interdomain === "also") return true;
  if (inter && bucket.interdomain === "no") return false; // inter-domain courses belong to Integrative/Exploration, not single domains or Foundations
  return domainsOf(course).some((d) => bucket.domains.includes(d));
}

export interface CountableCourse {
  code: string;
  /** Placed by the program's own template (bulletin-endorsed) — exempt from
   * the own-department restriction. User-added/completed courses are not. */
  endorsed: boolean;
}

export interface GenEdAudit {
  buckets: { key: string; label: string; need: number; got: number; courses: string[] }[];
  /** Bucket credits still uncovered, in canonical order. */
  remaining: { key: string; label: string; credits: number }[];
  us: { satisfiedBy: string | null; remaining: boolean };
  il: { satisfiedBy: string | null; remaining: boolean };
}

/** Deterministic greedy assignment: each course counts toward at most ONE
 * bucket (a 4-credit course over-fills a 3-credit bucket; surplus does not
 * spill). Courses are processed most-constrained-first so flexible buckets
 * don't steal what a narrow bucket needs. US/IL are an overlay on top — any
 * countable course carries them, one course can't cover both. */
export function auditGenEd(courses: CountableCourse[], catalog: Catalog, majorPrefixes: Set<string>): GenEdAudit {
  const got = new Map<string, { credits: number; courses: string[] }>(
    GENED_BUCKETS.map((b) => [b.key, { credits: 0, courses: [] }]),
  );
  const resolved = courses
    .map((cc) => ({ cc, c: catalog[cc.code] }))
    .filter((x): x is { cc: CountableCourse; c: Course } => !!x.c && x.c.genEd.length > 0);

  const eligibleBuckets = ({ cc, c }: { cc: CountableCourse; c: Course }): GenEdBucket[] =>
    GENED_BUCKETS.filter((b) => {
      if (!bucketAccepts(b, c)) return false;
      if (b.deptRestricted && !cc.endorsed && majorPrefixes.has(c.subject)) return false;
      return true;
    });

  // Most-constrained-first: courses with fewer eligible buckets assign first.
  const queue = resolved
    .map((x) => ({ ...x, options: eligibleBuckets(x) }))
    .filter((x) => x.options.length > 0)
    .sort((a, b) => a.options.length - b.options.length || a.c.code.localeCompare(b.c.code));

  for (const { c, options } of queue) {
    // First still-needy bucket in canonical (most-specific-first) order.
    const target = options.find((b) => got.get(b.key)!.credits < b.credits);
    if (!target) continue; // everything this course could fill is already covered
    const g = got.get(target.key)!;
    g.credits += c.creditsParsed?.min ?? 3;
    g.courses.push(c.code);
  }

  // US/IL overlay: any countable course qualifies (major courses included —
  // the senate rule allows double-counting); one course cannot do both.
  const usCarriers = resolved.filter((x) => x.c.attributes.includes(US_ATTR)).map((x) => x.c.code);
  const ilCarriers = resolved.filter((x) => x.c.attributes.includes(IL_ATTR)).map((x) => x.c.code);
  let us: string | null = null;
  let il: string | null = null;
  // Prefer single-designation carriers so a dual US+IL course stays available
  // for the other requirement.
  us = usCarriers.find((code) => !ilCarriers.includes(code)) ?? null;
  il = ilCarriers.find((code) => code !== us) ?? null;
  if (!us) us = usCarriers.find((code) => code !== il) ?? null;

  const buckets = GENED_BUCKETS.map((b) => ({
    key: b.key, label: b.label, need: b.credits,
    got: got.get(b.key)!.credits, courses: got.get(b.key)!.courses,
  }));
  const remaining = buckets
    .filter((b) => b.got < b.need)
    .map((b) => ({ key: b.key, label: b.label, credits: b.need - b.got }));
  return {
    buckets, remaining,
    us: { satisfiedBy: us, remaining: !us },
    il: { satisfiedBy: il, remaining: !il },
  };
}

/** Own-department prefixes for the plan's programs, derived from the template:
 * subjects with >=2 template courses at the 300 level or above. Deliberately
 * over-strict (it may catch a sibling department like EMCH for ESC) — this set
 * only narrows what we COUNT from user-added courses and what we RECOMMEND,
 * so over-strictness degrades to "one more gen ed / fewer suggestions", never
 * to a falsely-satisfied requirement (iron rule: conservative degradation). */
export function majorDeptPrefixes(plan: PlanDoc): Set<string> {
  const counts = new Map<string, number>();
  for (const t of plan.terms) {
    for (const it of t.items) {
      if ("slot" in it || !it.origin) continue; // template courses only
      const [subj, num] = it.code.split(" ");
      if (parseInt(num, 10) >= 300) counts.set(subj, (counts.get(subj) ?? 0) + 1);
    }
  }
  return new Set([...counts.entries()].filter(([, n]) => n >= 2).map(([s]) => s));
}

/** Gather countable courses from a plan: template courses (endorsed), added
 * courses and slot fills (not endorsed), completed courses (not endorsed). */
export function countableCourses(plan: PlanDoc): CountableCourse[] {
  const removed = plan.removed ?? {};
  const out = new Map<string, CountableCourse>();
  for (const t of plan.terms) {
    for (const it of t.items) {
      if ("slot" in it) continue;
      if (removed[it.code]) continue;
      // origin marks template-placed courses (bulletin-endorsed for gen-ed
      // counting); user-added courses folded into terms by the optimizer have
      // no origin and stay dept-restricted — conservative degradation.
      out.set(it.code, { code: it.code, endorsed: !!it.origin });
    }
  }
  for (const a of plan.added) if (!out.has(a.code)) out.set(a.code, { code: a.code, endorsed: false });
  for (const code of Object.values(plan.slotFills)) if (!out.has(code)) out.set(code, { code, endorsed: false });
  for (const code of Object.keys(plan.completed)) {
    if (plan.completed[code] && !out.has(code)) out.set(code, { code, endorsed: false });
  }
  return [...out.values()];
}

export interface RefineResult {
  /** slot id -> new category key, for slots renamed in place. */
  renamed: Record<string, string>;
  /** Slot ids moved to plan.removed (excess — their category is covered). */
  dropped: string[];
  /** Category keys for slots newly added (framework bucket had no slot). */
  added: string[];
  /** Human note for the toast, or null when nothing changed. */
  note: string | null;
}

const HINT_US = " · pick a course that also carries US";
const HINT_IL = " · pick a course that also carries IL";

/** Rename the plan's generic gen-ed slots to the SPECIFIC categories still
 * needed, drop slots whose category is already covered (restorable — this is
 * the double-count payoff: science/econ courses in the major already cover
 * GN/Exploration/GS), and add labeled slots for uncovered buckets. Annotates
 * slots with US/IL hints when those overlays are unmet. Idempotent. */
export function refineGenEdSlots(plan: PlanDoc, catalog: Catalog): RefineResult {
  const majorPrefixes = majorDeptPrefixes(plan);
  const audit = auditGenEd(countableCourses(plan), catalog, majorPrefixes);
  const removed = (plan.removed ??= {});

  // The plan's live gen-ed slots (anything that isn't an elective placeholder).
  const slots: { spec: SlotSpec; termIdx: number }[] = [];
  plan.terms.forEach((t, i) => {
    for (const it of t.items) {
      if ("slot" in it && it.slot !== "EL" && !removed[it.id] && !plan.slotFills[it.id]) {
        slots.push({ spec: it, termIdx: i });
      }
    }
  });

  // Remaining bucket credits, as a mutable ledger.
  const ledger = new Map(audit.remaining.map((r) => [r.key, r.credits]));

  const renamed: Record<string, string> = {};
  const dropped: string[] = [];
  const strip = (label: string | undefined) =>
    (label ?? "").replace(HINT_US, "").replace(HINT_IL, "");

  // Pass 1: slots that already carry a specific category keep it while that
  // bucket still needs credits (template GHW slots; previously refined slots).
  const generic: { spec: SlotSpec; termIdx: number }[] = [];
  for (const s of slots) {
    const b = BUCKET_BY_KEY.get(s.spec.slot);
    if (b && (ledger.get(b.key) ?? 0) > 0) {
      ledger.set(b.key, (ledger.get(b.key) ?? 0) - (Number(s.spec.credits) || 3));
      s.spec.label = b.label;
      renamed[s.spec.id] = b.key;
    } else if (b) {
      // Specific category already covered elsewhere -> excess, drop restorably.
      removed[s.spec.id] = true;
      dropped.push(s.spec.id);
    } else {
      generic.push(s);
    }
  }

  // Pass 2: generic "GE" slots take the remaining buckets in canonical order.
  for (const s of generic) {
    const next = GENED_BUCKETS.find((b) => (ledger.get(b.key) ?? 0) > 0);
    if (!next) {
      removed[s.spec.id] = true; // every bucket covered -> fewer gen eds to take
      dropped.push(s.spec.id);
      continue;
    }
    ledger.set(next.key, (ledger.get(next.key) ?? 0) - (Number(s.spec.credits) || 3));
    s.spec.slot = next.key;
    s.spec.label = next.label;
    renamed[s.spec.id] = next.key;
  }

  // Pass 3: buckets still uncovered get a labeled slot (the framework is the
  // authority; a template that under-provisions must not hide the requirement).
  const added: string[] = [];
  let seq = 0;
  for (const b of GENED_BUCKETS) {
    let owed = ledger.get(b.key) ?? 0;
    while (owed > 0) {
      const id = `GE-need-${b.key}-${seq++}`;
      if (plan.terms.some((t) => t.items.some((it) => "slot" in it && it.id === id))) { owed -= 3; continue; }
      // Lightest term keeps the load balanced until the next optimize pass.
      let best = 0;
      let bestCount = Infinity;
      plan.terms.forEach((t, i) => { if (t.items.length < bestCount) { bestCount = t.items.length; best = i; } });
      plan.terms[best]?.items.push({ slot: b.key, id, credits: 3, label: b.label });
      added.push(b.key);
      owed -= 3;
    }
  }

  // US/IL hints on the best-fit open slots (inter-domain and GH have the
  // richest US/IL-carrying course lists).
  const live = plan.terms.flatMap((t) => t.items).filter(
    (it): it is SlotSpec => "slot" in it && !removed[it.id] && !plan.slotFills[it.id] && BUCKET_BY_KEY.has(it.slot),
  );
  for (const s of live) s.label = strip(s.label);
  const hintOrder = ["INTER", "GH", "GS", "GA", "EXP"];
  const pickHintSlot = (skip: SlotSpec | null) =>
    hintOrder.map((k) => live.find((s) => s.slot === k && s !== skip)).find(Boolean) ?? live.find((s) => s !== skip) ?? null;
  let ilSlot: SlotSpec | null = null;
  if (audit.il.remaining) {
    ilSlot = pickHintSlot(null);
    if (ilSlot) ilSlot.label = strip(ilSlot.label) + HINT_IL;
  }
  if (audit.us.remaining) {
    const s = pickHintSlot(ilSlot);
    if (s) s.label = strip(s.label) + HINT_US;
  }

  const bits: string[] = [];
  if (Object.keys(renamed).length) bits.push(`named your gen-ed cards by category (${[...new Set(Object.values(renamed))].join(", ")})`);
  if (dropped.length) bits.push(`removed ${dropped.length} gen-ed card${dropped.length > 1 ? "s" : ""} already covered by courses in your plan (restorable)`);
  if (added.length) bits.push(`added ${added.length} required gen-ed card${added.length > 1 ? "s" : ""} (${added.join(", ")})`);
  if (audit.il.remaining) bits.push("pick one gen ed that carries IL (International Cultures)");
  if (audit.us.remaining) bits.push("pick one that carries US (United States Cultures)");
  return { renamed, dropped, added, note: bits.length ? bits.join("; ") : null };
}

export interface GenEdPick {
  course: Course;
  /** Why this pick is efficient — shown as chips ("also IL", "covers GA+GH"). */
  bonuses: string[];
  score: number;
}

/** Category-filtered, double-count-ranked suggestions for a gen-ed slot.
 * Excludes the student's own-department courses for restricted buckets, and
 * ranks courses that also knock out an unmet US/IL overlay (or span two
 * domains) to the top — the fewest-total-gen-eds ordering. */
export function rankGenEdPicks(
  catalog: Catalog,
  bucketKey: string,
  opts: { majorPrefixes: Set<string>; needUS: boolean; needIL: boolean; exclude: Set<string>;
    /** Schreyer scholars: honors gen eds earn honors credits with the same card. */
    preferHonors?: boolean },
): GenEdPick[] {
  const bucket = BUCKET_BY_KEY.get(bucketKey);
  if (!bucket) return [];
  const seen = new Set<string>();
  const picks: GenEdPick[] = [];
  for (const c of Object.values(catalog)) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    if (c.level !== "undergraduate" || opts.exclude.has(c.code)) continue;
    if (!bucketAccepts(bucket, c)) continue;
    if (bucket.deptRestricted && opts.majorPrefixes.has(c.subject)) continue;
    const bonuses: string[] = [];
    let score = 0;
    if (opts.needIL && c.attributes.includes(IL_ATTR)) { bonuses.push("also fulfills IL"); score += 4; }
    else if (opts.needUS && c.attributes.includes(US_ATTR)) { bonuses.push("also fulfills US"); score += 4; }
    if (opts.preferHonors && (c.attributes.includes("Honors") || /[HM]$/.test(c.number))) {
      bonuses.push("honors credits");
      score += 2;
    }
    const doms = domainsOf(c);
    if (isInterdomain(c) && doms.length >= 2) { bonuses.push(`inter-domain: ${doms.join("+")}`); score += 1; }
    picks.push({ course: c, bonuses, score });
  }
  picks.sort((a, b) =>
    b.score - a.score ||
    a.course.subject.localeCompare(b.course.subject) ||
    a.course.number.localeCompare(b.course.number, undefined, { numeric: true }),
  );
  return picks;
}
