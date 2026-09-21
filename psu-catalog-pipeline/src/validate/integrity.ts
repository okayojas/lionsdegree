/** Referential-integrity validation: every course code a program references
 * must resolve in the course index. Per-class handling (see the ESC 410
 * investigation, 2026-07-11):
 *  - unique suffix variant exists (ESC 410 -> ESC 410H): resolve, keep
 *    `resolvedFrom`, log for review
 *  - several variants exist (CAS 100 -> 100A/100B/100C): expand — plan entries
 *    get the first variant + the rest as `alternatives`; course rules become
 *    `oneOf`
 *  - nothing resolves (LA 283): mark `unverified: true` so the app renders a
 *    "verify with adviser" state instead of a confident card
 * Course lists inside selectCredits keep unresolved codes but drop provably
 * absent ones from suggestion pools is left to the app (they're advisory). */
import fs from "node:fs";
import path from "node:path";
import type { AstNode } from "../lib/prereq.js";
import type { Course, Program } from "./schemas.js";

export interface CourseIndex {
  known: Set<string>;
  /** "CAS 100" (subject + bare number) -> ["CAS 100A", "CAS 100B", ...] */
  variantsByBase: Map<string, string[]>;
}

export function buildCourseIndex(outDir: string): CourseIndex {
  const known = new Set<string>();
  const variantsByBase = new Map<string, string[]>();
  const dirs = [path.join(outDir, "courses"), path.join(outDir, "courses", "grad")];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const courses = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as { code: string; aliases?: string[] }[];
      for (const c of courses) {
        known.add(c.code);
        for (const a of c.aliases ?? []) known.add(a);
        const m = /^([A-Z]+ \d{1,3})[A-Z]*$/.exec(c.code);
        if (m) {
          const list = variantsByBase.get(m[1]) ?? [];
          if (!list.includes(c.code)) list.push(c.code);
          variantsByBase.set(m[1], list);
        }
      }
    }
  }
  return { known, variantsByBase };
}

export interface IntegrityReport {
  resolved: { program: string; from: string; to: string }[];
  expanded: { program: string; code: string; variants: string[] }[];
  unverified: { program: string; code: string; where: string }[];
}

type Resolution =
  | { kind: "ok" }
  | { kind: "resolve"; to: string }
  | { kind: "expand"; variants: string[] }
  | { kind: "unverified" };

function resolveCode(code: string, index: CourseIndex): Resolution {
  if (index.known.has(code)) return { kind: "ok" };
  const base = /^([A-Z]+ \d{1,3})[A-Z]*$/.exec(code)?.[1] ?? code;
  const variants = index.variantsByBase.get(base) ?? [];
  if (variants.length === 1) return { kind: "resolve", to: variants[0] };
  if (variants.length > 1) return { kind: "expand", variants };
  return { kind: "unverified" };
}

/** Build a CourseIndex from in-memory course lists (used mid-run, before files
 * are written). */
export function indexFromCourses(courses: { code: string; aliases?: string[] }[]): CourseIndex {
  const known = new Set<string>();
  const variantsByBase = new Map<string, string[]>();
  for (const c of courses) {
    known.add(c.code);
    for (const a of c.aliases ?? []) known.add(a);
    const m = /^([A-Z]+ \d{1,3})[A-Z]*$/.exec(c.code);
    if (m) {
      const list = variantsByBase.get(m[1]) ?? [];
      if (!list.includes(c.code)) list.push(c.code);
      variantsByBase.set(m[1], list);
    }
  }
  return { known, variantsByBase };
}

/** Resolve course leaves inside a prereq AST: bulletins' prereq strings carry
 * the same stale codes as their tables (ESC 411's enforced text says
 * "ESC 410"; the course is ESC 410H). Unique variants are rewritten in place;
 * families become or-chains (any variant satisfies); unknowns stay (they
 * evaluate as UNK "verify manually"). Raw `enforced` text is never touched. */
export function resolveAst(n: AstNode, index: CourseIndex, stats?: { resolved: number; expanded: number }): AstNode {
  switch (n.op) {
    case "course": {
      if (index.known.has(n.code)) return n;
      const base = /^([A-Z]+ \d{1,3})[A-Z]*$/.exec(n.code)?.[1] ?? n.code;
      const variants = index.variantsByBase.get(base) ?? [];
      if (variants.length === 1) {
        if (stats) stats.resolved++;
        return { op: "course", code: variants[0] };
      }
      if (variants.length > 1) {
        if (stats) stats.expanded++;
        return variants
          .map((v): AstNode => ({ op: "course", code: v }))
          .reduce((a, b) => ({ op: "or", a, b }));
      }
      return n;
    }
    case "and":
    case "or":
      return { op: n.op, a: resolveAst(n.a, index, stats), b: resolveAst(n.b, index, stats) };
    case "concurrent":
      return { op: "concurrent", a: resolveAst(n.a, index, stats) };
    default:
      return n;
  }
}

/** Second pass over all parsed courses: resolve every prereq/concurrent AST
 * against the full index. */
export function resolveCourseAsts(courses: Course[], index: CourseIndex): { resolved: number; expanded: number } {
  const stats = { resolved: 0, expanded: 0 };
  for (const c of courses) {
    if (c.prereqAst) c.prereqAst = resolveAst(c.prereqAst as AstNode, index, stats);
    if (c.concurrentAst) c.concurrentAst = resolveAst(c.concurrentAst as AstNode, index, stats);
  }
  return stats;
}

export function validateProgram(program: Program, index: CourseIndex, report: IntegrityReport): void {
  for (const sp of program.suggestedPlans) {
    for (const sem of sp.semesters) {
      for (const e of sem.entries) {
        if (e.type !== "course") continue;
        const r = resolveCode(e.code, index);
        if (r.kind === "resolve") {
          report.resolved.push({ program: program.slug, from: e.code, to: r.to });
          e.resolvedFrom = e.code;
          e.code = r.to;
        } else if (r.kind === "expand") {
          report.expanded.push({ program: program.slug, code: e.code, variants: r.variants });
          e.resolvedFrom = e.code;
          e.code = r.variants[0];
          e.alternatives = [...new Set([...(e.alternatives ?? []), ...r.variants.slice(1)])];
        } else if (r.kind === "unverified") {
          report.unverified.push({ program: program.slug, code: e.code, where: `plan:${sem.label}` });
          e.unverified = true;
        }
        // Alternatives that don't resolve are dropped silently only if others remain.
        if (e.alternatives?.length) {
          const kept = e.alternatives.filter((a) => resolveCode(a, index).kind !== "unverified");
          if (kept.length || e.alternatives.length === 0) e.alternatives = kept;
        }
      }
    }
  }
  for (const section of program.requirementSections) {
    for (let i = 0; i < section.rules.length; i++) {
      const rule = section.rules[i];
      if (rule.type === "course") {
        const r = resolveCode(rule.code, index);
        if (r.kind === "resolve") {
          report.resolved.push({ program: program.slug, from: rule.code, to: r.to });
          rule.resolvedFrom = rule.code;
          rule.code = r.to;
        } else if (r.kind === "expand") {
          report.expanded.push({ program: program.slug, code: rule.code, variants: r.variants });
          section.rules[i] = { type: "oneOf", options: r.variants, credits: rule.credits };
        } else if (r.kind === "unverified") {
          report.unverified.push({ program: program.slug, code: rule.code, where: `req:${section.heading}` });
          rule.unverified = true;
        }
      } else if (rule.type === "oneOf" || rule.type === "chooseN") {
        rule.options = rule.options.flatMap((o) => {
          const r = resolveCode(o, index);
          if (r.kind === "resolve") return [r.to];
          if (r.kind === "expand") return r.variants;
          if (r.kind === "unverified") {
            report.unverified.push({ program: program.slug, code: o, where: `req-opt:${section.heading}` });
            return [o]; // keep — shows raw, app renders unverified
          }
          return [o];
        });
      }
    }
  }
}
