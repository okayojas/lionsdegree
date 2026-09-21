/** Deterministic degree audit: evaluate a program's requirement sections
 * against the student's pool of completed + planned courses. Single-use
 * within a program (a course fills one rule); each program audits against its
 * own pool copy, so major/minor double-counting is allowed. Unstructured and
 * note rules are surfaced as "manual" — never guessed. */
import { splitCode } from "./codes.js";
import type { ReqRule, ReqSection } from "./requirements.js";
import type { Catalog, PlanDoc } from "./types.js";

export interface PoolCourse {
  code: string;
  credits: number;
  completed: boolean;
}

export type RuleStatus = "done" | "in-progress" | "todo" | "partial" | "manual";

export interface RuleResult {
  rule: ReqRule;
  status: RuleStatus;
  used: string[];
  creditsApplied: number;
  creditsNeeded: number | null;
  label: string;
}

export interface SectionResult {
  heading: string;
  kind: string;
  rules: RuleResult[];
  done: number;
  todo: number;
  manual: number;
}

export interface AuditResult {
  sections: SectionResult[];
  totals: { done: number; todo: number; manual: number };
}

/** Pool from the current plan + completed map. Planned-but-not-completed
 * courses count as "in progress" toward requirements. */
export function buildPool(plan: PlanDoc, catalog: Catalog): PoolCourse[] {
  const seen = new Set<string>();
  const pool: PoolCourse[] = [];
  const add = (code: string, completed: boolean) => {
    if (seen.has(code)) return;
    seen.add(code);
    const c = catalog[code];
    pool.push({ code: c?.code ?? code, credits: c?.creditsParsed?.min ?? 3, completed });
  };
  for (const code of Object.keys(plan.completed)) if (plan.completed[code]) add(code, true);
  const removed = plan.removed ?? {};
  plan.terms.forEach((t) => {
    for (const it of t.items) {
      if ("code" in it && !removed[it.code]) add(it.code, false);
      else if ("slot" in it && plan.slotFills[it.id] && !removed[it.id]) add(plan.slotFills[it.id], false);
    }
  });
  for (const a of plan.added) add(a.code, false);
  return pool;
}

function matchesPattern(code: string, subject: string, minLevel: number | null): boolean {
  const s = splitCode(code);
  if (!s || s.subject !== subject) return false;
  return minLevel === null || parseInt(s.number, 10) >= minLevel;
}

export function auditProgram(
  sections: ReqSection[],
  pool: PoolCourse[],
  catalog: Catalog,
  coveredBy?: Record<string, string[]>,
): AuditResult {
  const available = new Map(pool.map((p) => [p.code, p]));
  const inPool = new Map(pool.map((p) => [p.code, p]));
  const consume = (code: string): PoolCourse | null => {
    const p = available.get(code);
    if (p) available.delete(code);
    return p ?? null;
  };
  /** Content coverage (MATH 251 covers MATH 250): non-consuming — one covering
   * course may satisfy several subsumed requirements. */
  const coverage = (code: string): PoolCourse | null => {
    for (const sup of coveredBy?.[code] ?? []) {
      const p = inPool.get(sup);
      if (p) return p;
    }
    return null;
  };
  const out: SectionResult[] = [];

  // Exact course rules first (across all sections), then choices, then credit
  // filters — so a course isn't eaten by a broad filter before its exact rule.
  const results = new Map<ReqRule, RuleResult>();
  const allRules = sections.flatMap((s) => s.rules);

  for (const rule of allRules) {
    if (rule.type !== "course") continue;
    let got = consume(rule.code);
    let viaCoverage = false;
    if (!got) {
      got = coverage(rule.code);
      viaCoverage = !!got;
    }
    results.set(rule, {
      rule,
      status: got ? (got.completed ? "done" : "in-progress") : "todo",
      used: got ? [viaCoverage ? `${got.code} (covers ${rule.code})` : got.code] : [],
      creditsApplied: got?.credits ?? 0,
      creditsNeeded: rule.credits,
      label: rule.code,
    });
  }
  for (const rule of allRules) {
    if (rule.type !== "oneOf" && rule.type !== "chooseN") continue;
    const n = rule.type === "chooseN" ? rule.n : 1;
    const used: PoolCourse[] = [];
    for (const opt of rule.options) {
      if (used.length >= n) break;
      const got = consume(opt);
      if (got) used.push(got);
    }
    results.set(rule, {
      rule,
      status: used.length >= n ? (used.every((u) => u.completed) ? "done" : "in-progress") : used.length ? "partial" : "todo",
      used: used.map((u) => u.code),
      creditsApplied: used.reduce((s, u) => s + u.credits, 0),
      creditsNeeded: rule.credits,
      label: rule.type === "oneOf" ? rule.options.join(" or ") : `${rule.n} of: ${rule.options.slice(0, 4).join(", ")}${rule.options.length > 4 ? "…" : ""}`,
    });
  }
  for (const rule of allRules) {
    if (rule.type !== "selectCredits") continue;
    const need = rule.credits ?? 0;
    const used: PoolCourse[] = [];
    let got = 0;
    const matches = (code: string): boolean => {
      if (!rule.from) return false;
      if (rule.from.kind === "courses") return rule.from.courses.includes(code);
      if (rule.from.kind === "pattern") return matchesPattern(code, rule.from.subject, rule.from.minLevel);
      if (rule.from.kind === "genEd") {
        const domain = rule.from.domain;
        return catalog[code]?.genEd.includes(domain) ?? false;
      }
      return false;
    };
    if (rule.from) {
      for (const code of [...available.keys()]) {
        if (got >= need) break;
        if (matches(code)) {
          const p = consume(code)!;
          used.push(p);
          got += p.credits;
        }
      }
    }
    results.set(rule, {
      rule,
      status: !rule.from ? "manual" : got >= need && need > 0 ? (used.every((u) => u.completed) ? "done" : "in-progress") : got > 0 ? "partial" : "todo",
      used: used.map((u) => u.code),
      creditsApplied: got,
      creditsNeeded: need || null,
      label: rule.commentRaw.slice(0, 90),
    });
  }
  for (const rule of allRules) {
    if (results.has(rule) || rule.type === "note") continue;
    results.set(rule, {
      rule,
      status: "manual",
      used: [],
      creditsApplied: 0,
      creditsNeeded: rule.type === "genEd" ? rule.credits : null,
      label: "commentRaw" in rule ? rule.commentRaw.slice(0, 90) : "",
    });
  }

  for (const s of sections) {
    const rr = s.rules.filter((r) => r.type !== "note").map((r) => results.get(r)!).filter(Boolean);
    out.push({
      heading: s.heading,
      kind: s.kind,
      rules: rr,
      done: rr.filter((r) => r.status === "done" || r.status === "in-progress").length,
      todo: rr.filter((r) => r.status === "todo" || r.status === "partial").length,
      manual: rr.filter((r) => r.status === "manual").length,
    });
  }
  return {
    sections: out,
    totals: {
      done: out.reduce((s, x) => s + x.done, 0),
      todo: out.reduce((s, x) => s + x.todo, 0),
      manual: out.reduce((s, x) => s + x.manual, 0),
    },
  };
}
