/** Mine DIRECTIONAL course-coverage relations from bulletin descriptions.
 * The catalog itself declares when one course subsumes another:
 *   - "Students who have passed MATH 251 may not schedule this course for
 *     credit" (in MATH 250's description)  =>  MATH 251 covers MATH 250
 *   - "This course is a combination of E MCH 211 and E MCH 213" (in EMCH 210)
 *     =>  EMCH 210 covers EMCH 211 and EMCH 213
 *   - "Students taking E MCH 210 may not take E MCH 211 or 213 for credit"
 *     =>  same direction
 * Direction matters: MATH 251 satisfies a MATH 250 requirement, never the
 * reverse. Symmetric "may not receive credit for both A and B" sentences are
 * recorded as exclusions (informational) — no direction is claimed.
 *
 * Output: data/out/<edition>/coverage.json
 * Run: npx tsx scripts/mineCoverage.ts [--edition X]
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const edition = arg("edition") ?? config.edition;
const outDir = config.outDir(edition);

interface Course { code: string; subject: string; description: string }

/* Load all courses + known prefixes. */
const courses: Course[] = [];
const prefixes = new Set<string>();
for (const dir of ["courses", "courses/grad"]) {
  const d = path.join(outDir, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".json"))) {
    for (const c of JSON.parse(fs.readFileSync(path.join(d, f), "utf-8")) as Course[]) {
      courses.push(c);
      prefixes.add(c.subject);
    }
  }
}
const known = new Set(courses.map((c) => c.code));

/** Normalize spaced/hyphenated subject forms in prose ("E MCH 211", "A-I 100")
 * to canonical codes, using the known prefix set. */
function extractCodes(text: string, selfSubject: string): string[] {
  const t = text.replace(/ /g, " ");
  const out: string[] = [];
  // Try 3 shapes at each code-ish spot: "AB CD 123", "ABCD 123", bare "123"
  const re = /(?:([A-Z]{1,4})[ -]([A-Z]{1,4})|([A-Z]{2,6}))\s?(\d{1,3}[A-Z]{0,2})\b|(?<=[,\s(])(\d{1,3}[A-Z]{0,2})\b/g;
  let lastSubject: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    if (m[5]) {
      // bare number ("211 or 213") inherits the previous subject
      if (lastSubject) out.push(`${lastSubject} ${m[5].replace(/^0+(?=\d)/, "")}`);
      continue;
    }
    const num = m[4].replace(/^0+(?=\d)/, "");
    let subj: string | null = null;
    if (m[3] && prefixes.has(m[3])) subj = m[3];
    else if (m[1] && m[2] && prefixes.has(m[1] + m[2])) subj = m[1] + m[2];
    else if (m[2] && prefixes.has(m[2])) subj = m[2]; // "of E MCH" mis-split
    if (!subj) continue;
    lastSubject = subj;
    out.push(`${subj} ${num}`);
  }
  void selfSubject;
  return [...new Set(out)];
}

const coveredBy: Record<string, { by: string; evidence: string }[]> = {};
const exclusions: { a: string; b: string; evidence: string }[] = [];
const addCover = (covered: string, by: string, evidence: string) => {
  if (covered === by || !known.has(covered) || !known.has(by)) return;
  coveredBy[covered] = coveredBy[covered] ?? [];
  if (!coveredBy[covered].some((x) => x.by === by)) {
    coveredBy[covered].push({ by, evidence: evidence.slice(0, 180) });
  }
};

const PASSED_RE = /students? who (?:have|has) (?:passed|completed|taken|received credit for)\s+([^.]*?)\s+may not\s+(?:schedule|enroll in|take|register for|receive credit for)\s+(this course|[^.]*?)(?:\s+for credit)?[.,]/gi;
const TAKING_RE = /students? (?:taking|enrolled in)\s+(this course|[^.,]*?)\s+may not\s+(?:take|schedule|enroll in)\s+([^.]*?)\s+for credit/gi;
const COMBO_RE = /this course is a combination of\s+([^.]*?)\./gi;
const BOTH_RE = /may not (?:receive|earn|be awarded) credit (?:towards graduation )?for both\s+([^.]*?)\./gi;

for (const c of courses) {
  const d = c.description;
  if (!d || !/may not|combination of/i.test(d)) continue;

  PASSED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PASSED_RE.exec(d)) !== null) {
    const supersets = extractCodes(m[1], c.subject);
    const targets = /this course/i.test(m[2]) ? [c.code] : extractCodes(m[2], c.subject);
    for (const t of targets) for (const s of supersets) addCover(t, s, m[0]);
  }

  TAKING_RE.lastIndex = 0;
  while ((m = TAKING_RE.exec(d)) !== null) {
    const takers = /this course/i.test(m[1]) ? [c.code] : extractCodes(m[1], c.subject);
    const blocked = extractCodes(m[2], c.subject);
    for (const taker of takers) for (const b of blocked) addCover(b, taker, m[0]);
  }

  COMBO_RE.lastIndex = 0;
  while ((m = COMBO_RE.exec(d)) !== null) {
    for (const part of extractCodes(m[1], c.subject)) addCover(part, c.code, m[0]);
  }

  BOTH_RE.lastIndex = 0;
  while ((m = BOTH_RE.exec(d)) !== null) {
    const codes = extractCodes(m[1], c.subject);
    for (let i = 0; i < codes.length; i++) {
      for (let j = i + 1; j < codes.length; j++) {
        exclusions.push({ a: codes[i], b: codes[j], evidence: m[0].slice(0, 160) });
      }
    }
  }
}

fs.writeFileSync(path.join(outDir, "coverage.json"), JSON.stringify({
  note: "Directional: coveredBy[X] lists courses whose content subsumes X (per bulletin descriptions). A requirement for X is satisfiable by any of coveredBy[X]; never the reverse.",
  minedFrom: "bulletin course descriptions, deterministic sentence patterns",
  coveredBy,
  exclusions,
}, null, 1), "utf-8");

console.log(`coverage: ${Object.keys(coveredBy).length} covered courses, ${exclusions.length} exclusion pairs`);
for (const probe of ["MATH 250", "MATH 252", "EMCH 211", "EMCH 213", "MATH 22"]) {
  console.log(` ${probe} coveredBy:`, (coveredBy[probe] ?? []).map((x) => x.by).join(", ") || "(none)");
}
