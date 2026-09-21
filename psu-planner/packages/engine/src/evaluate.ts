/** Prereq evaluation against a schedule.
 * Port of the original demo's evalNode/checkCourse (L280-310 there),
 * parameterized on catalog instead of the DATA global. Prefers the
 * pipeline's pre-parsed ASTs; falls back to runtime parsing for live-fetched
 * courses. */
import { parsePrereqText, type AstNode } from "./prereq.js";
import { SAT, UNK, UNSAT, type Catalog, type CheckResult, type EvalValue, type Leaf, type Schedule } from "./types.js";

export function evalNode(n: AstNode, sched: Schedule, mySem: number, concurrent: boolean, leaves: Leaf[]): EvalValue {
  switch (n.op) {
    case "true":
      return SAT;
    case "or":
      return Math.max(
        evalNode(n.a, sched, mySem, concurrent, leaves),
        evalNode(n.b, sched, mySem, concurrent, leaves),
      ) as EvalValue;
    case "and":
      return Math.min(
        evalNode(n.a, sched, mySem, concurrent, leaves),
        evalNode(n.b, sched, mySem, concurrent, leaves),
      ) as EvalValue;
    case "phrase":
      leaves.push({ kind: "phrase", text: n.text, v: UNK });
      return UNK;
    case "concurrent":
      // Subtree carries its own enrollment mode (mixed bulletin strings like
      // "MATH 110 or Enforced Concurrent at Enrollment: MATH 140").
      return evalNode(n.a, sched, mySem, true, leaves);
    case "course": {
      const e = sched[n.code];
      if (!e) {
        leaves.push({ kind: "external", code: n.code, v: UNK });
        return UNK;
      }
      let v: EvalValue;
      if (e.completed) v = SAT;
      else if (e.sem < mySem) v = SAT;
      else if (e.sem === mySem) v = concurrent ? SAT : UNSAT;
      else v = UNSAT;
      leaves.push({ kind: "inplan", code: n.code, sem: e.sem, v, concurrent });
      return v;
    }
  }
}

export function checkCourse(catalog: Catalog, code: string, mySem: number, sched: Schedule): CheckResult {
  const c = catalog[code];
  const res: CheckResult = { value: SAT, leaves: [] };
  if (!c) return res;
  const prereqAst = c.prereqAst ?? (c.enforced ? parsePrereqText(c.enforced) : null);
  const concAst = c.concurrentAst ?? (c.concurrent ? parsePrereqText(c.concurrent) : null);
  if (prereqAst) {
    res.value = Math.min(res.value, evalNode(prereqAst, sched, mySem, false, res.leaves)) as EvalValue;
  }
  if (concAst) {
    res.value = Math.min(res.value, evalNode(concAst, sched, mySem, true, res.leaves)) as EvalValue;
  }
  return res;
}
