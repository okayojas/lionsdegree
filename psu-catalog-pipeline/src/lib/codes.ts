/** Course-code helpers. normCode/CODE_RE are ported verbatim from the demo app
 * (the original demo L240-241) — the client engine must produce
 * identical normalization, so do not "improve" these in one place only. */

export const CODE_RE = /([A-Za-z]{1,6}(?:-[A-Za-z])?)\s*(\d{1,3}[A-Za-z]{0,2})\b/g;

export function normCode(subj: string, num: string): string {
  return subj.toUpperCase().replace(/-/g, "") + " " + num.toUpperCase();
}

/** "CMPSC 465" -> {subject:"CMPSC", number:"465"}; returns null if not a code. */
export function splitCode(code: string): { subject: string; number: string } | null {
  const m = /^([A-Z]+)\s+(\d{1,3}[A-Z]{0,2})$/.exec(code);
  return m ? { subject: m[1], number: m[2] } : null;
}

/** Normalize a display code like "A-I 100" or "CMPSC 101" to "AI 100". */
export function normDisplayCode(display: string): string | null {
  const cleaned = display.replace(/ /g, " ").trim();
  CODE_RE.lastIndex = 0;
  const m = CODE_RE.exec(cleaned);
  if (!m || m.index !== 0) return null;
  return normCode(m[1], m[2]);
}
