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

/** A code as the BULLETIN writes it: subject in capitals.
 *
 * `normDisplayCode` above is deliberately case-insensitive and is ported
 * verbatim from the demo — the client engine must normalise identically, so
 * it is not touched. But applied to the text of a link in a requirement
 * table it reads prose: "Select 12 credits" becomes `SELECT 12`, "the 400
 * level" becomes `THE 400`. 120 rows in the shipped catalog were sentences
 * wearing a course code's shape.
 *
 * Case is the discriminator. The bulletin writes codes in capitals, and
 * `CODE_TOKEN` in programRequirements.ts already relies on exactly that.
 * Requiring it here needs no hand-maintained list of English words, which
 * would be wrong the first time a subject looked like one — ART, BA and LER
 * are all real subjects.
 *
 * This is the third time a case-insensitive code regex has read prose as a
 * code in this project; "credits" once parsed as a subject named REDITS
 * (DECISIONS 2.4).
 */
const BULLETIN_CODE_RE = /^([A-Z]{1,6}(?:-[A-Z])?)\s*(\d{1,3}[A-Z]{0,2})\b/;

export function normBulletinCode(display: string): string | null {
  const m = BULLETIN_CODE_RE.exec(display.replace(/ /g, " ").trim());
  return m ? normCode(m[1], m[2]) : null;
}
