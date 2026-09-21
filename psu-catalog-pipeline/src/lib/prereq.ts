/** Prerequisite boolean-expression parser.
 * Ported from the original demo (L243-279 there) with three
 * deliberate deviations, each caught by the regression corpus (catalogs/*.json):
 *  1. "[" / "]" are treated as parens (EE 200 uses brackets; the demo dropped
 *     everything after the stray "]").
 *  2. A label phrase directly before "(" — e.g. "One of: (A or B)" — is skipped
 *     instead of becoming the whole expression (CAS 472).
 *  3. Tokens left unconsumed after parsing are joined with an implicit AND, so
 *     unparsed remainders degrade to UNK ("verify manually"), never to
 *     falsely-satisfied.
 * The client engine evaluates ASTs produced here and must use this same module
 * for any runtime parsing; keep semantics identical across both. */
import { CODE_RE, normCode } from "./codes.js";

export type AstNode =
  | { op: "true" }
  | { op: "course"; code: string }
  | { op: "phrase"; text: string }
  | { op: "and"; a: AstNode; b: AstNode }
  | { op: "or"; a: AstNode; b: AstNode }
  /** Subtree evaluated with concurrent-enrollment semantics — produced when a
   * bulletin string embeds "... or Enforced Concurrent at Enrollment: X". */
  | { op: "concurrent"; a: AstNode };

type Token =
  | { t: "(" | ")" | "and" | "or" }
  | { t: "course"; code: string }
  | { t: "phrase"; text: string };

export function tokenize(text: string): Token[] {
  const t = " " + text.replace(/C\s+or\s+better\s+in/gi, " ").replace(/Prerequisites?\s*:/gi, " ") + " ";
  const parts = t.split(/(\(|\)|\[|\]|\band\b|\bor\b)/i);
  const toks: Token[] = [];
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    if (s === "(" || s === "[") toks.push({ t: "(" });
    else if (s === ")" || s === "]") toks.push({ t: ")" });
    else if (/^and$/i.test(s)) toks.push({ t: "and" });
    else if (/^or$/i.test(s)) toks.push({ t: "or" });
    else {
      let m: RegExpExecArray | null;
      let found = false;
      CODE_RE.lastIndex = 0;
      const codes: string[] = [];
      while ((m = CODE_RE.exec(s)) !== null) {
        codes.push(normCode(m[1], m[2]));
        found = true;
      }
      if (found) codes.forEach((c, i) => {
        if (i > 0) toks.push({ t: "and" });
        toks.push({ t: "course", code: c });
      });
      else toks.push({ t: "phrase", text: s });
    }
  }
  return toks;
}

export function parseExpr(toks: Token[]): AstNode {
  let i = 0;
  function expr(): AstNode {
    let n = term();
    while (i < toks.length && toks[i].t === "or") { i++; n = { op: "or", a: n, b: term() }; }
    return n;
  }
  function term(): AstNode {
    let n = factor();
    while (i < toks.length && toks[i].t === "and") { i++; n = { op: "and", a: n, b: factor() }; }
    return n;
  }
  function factor(): AstNode {
    if (i >= toks.length) return { op: "true" };
    const tk = toks[i];
    if (tk.t === "(") {
      i++;
      const n = expr();
      if (i < toks.length && toks[i].t === ")") i++;
      return n;
    }
    // Label phrase directly before a group — "One of: (A or B)" — is
    // descriptive, not an operand; the group carries the semantics.
    if (tk.t === "phrase" && i + 1 < toks.length && toks[i + 1].t === "(") {
      i++;
      return factor();
    }
    i++;
    if (tk.t === "course") return { op: "course", code: tk.code };
    if (tk.t === "phrase") return { op: "phrase", text: tk.text };
    return factor();
  }

  let node = expr();
  // Consume any remainder the demo parser silently dropped: stray closers are
  // skipped; trailing and/or continue the expression; anything else joins with
  // an implicit AND so it can only lower the status (UNK), never raise it.
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.t === ")") { i++; continue; }
    if (tk.t === "or") { i++; node = { op: "or", a: node, b: term() }; continue; }
    if (tk.t === "and") { i++; node = { op: "and", a: node, b: term() }; continue; }
    node = { op: "and", a: node, b: term() };
  }
  return node;
}

export function parsePrereqText(text: string): AstNode {
  return parseExpr(tokenize(text));
}

const EMBEDDED_LABEL_RE = /(?:\b(and|or)\s+)?Enforced\s+(Prerequisites?|Concurrents?)(?:\s+at\s+Enrollment)?\s*:\s*/gi;

/** Parse a bulletin prereq string that may embed mode-switching labels, e.g.
 * "MATH 110 or Enforced Concurrent at Enrollment: MATH 140". Each segment is
 * parsed separately; concurrent segments are wrapped in a `concurrent` node
 * and joined with the connector word that preceded the label (default "and"). */
export function parseMixedPrereqText(text: string, startsConcurrent: boolean): AstNode | null {
  EMBEDDED_LABEL_RE.lastIndex = 0;
  interface Seg { text: string; concurrent: boolean; conn: "and" | "or" }
  const segs: Seg[] = [];
  let lastEnd = 0;
  let mode = startsConcurrent;
  let conn: "and" | "or" = "and";
  let m: RegExpExecArray | null;
  while ((m = EMBEDDED_LABEL_RE.exec(text)) !== null) {
    const before = text.slice(lastEnd, m.index).trim();
    if (before) segs.push({ text: before, concurrent: mode, conn });
    conn = (m[1]?.toLowerCase() as "and" | "or") ?? "and";
    mode = m[2].toLowerCase().startsWith("concurrent");
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd).trim();
  if (tail) segs.push({ text: tail, concurrent: mode, conn });
  if (!segs.length) return null;

  let ast: AstNode | null = null;
  for (const s of segs) {
    let node = parsePrereqText(s.text);
    if (s.concurrent) node = { op: "concurrent", a: node };
    ast = ast === null ? node : { op: s.conn, a: ast, b: node };
  }
  return ast;
}

/** True when the AST contains no `phrase` nodes, i.e. it is fully machine-evaluable. */
export function astComplete(n: AstNode): boolean {
  switch (n.op) {
    case "phrase": return false;
    case "and":
    case "or": return astComplete(n.a) && astComplete(n.b);
    case "concurrent": return astComplete(n.a);
    default: return true;
  }
}

/** All course codes referenced by the AST (for referential-integrity checks). */
export function astCourses(n: AstNode, acc: string[] = []): string[] {
  switch (n.op) {
    case "course": acc.push(n.code); break;
    case "and":
    case "or": astCourses(n.a, acc); astCourses(n.b, acc); break;
    case "concurrent": astCourses(n.a, acc); break;
  }
  return acc;
}
