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
  const res: CheckResult = { value: SAT, leaves: [], known: true };
  // NO ENTRY IS NOT A PASS, it is an absence — and the two have to be
  // told apart by anyone reporting to a student (#49). The verdict
  // stays SAT because the optimiser needs a Course it cannot describe
  // to remain placeable; `known: false` is how a reader learns not to
  // repeat it as a finding. See the note on `CheckResult.known`.
  if (!c) return { ...res, known: false };

  // A Course whose prerequisite structure was never READ cannot be
  // reported satisfied.
  //
  // `astComplete: false` with nothing parsed means exactly that: the
  // Course came from the audit index, which carries no prerequisite
  // fields at all, and its subject file has not been loaded. The fall
  // through below would have returned SAT -- "no prerequisites found,
  // therefore none" -- which is the confident wrong answer iron rule 2
  // exists to forbid. It is the difference between "anyone can take this"
  // and "we have not looked".
  //
  // Only when nothing was parsed. A Course with `astComplete: false`
  // because part of its prerequisite TEXT defeated the parser still gets
  // evaluated on the part that did parse, and the unparsed phrase already
  // surfaces as its own UNK leaf.
  const nothingParsed = !c.prereqAst && !c.enforced && !c.concurrentAst && !c.concurrent;
  if (nothingParsed && c.astComplete === false) {
    return {
      value: UNK,
      leaves: [{ kind: "phrase", text: `${code}: prerequisites not loaded — verify manually`, v: UNK }],
    };
  }

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
