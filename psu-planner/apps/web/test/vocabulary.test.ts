/** The word a student reads for one scheduled period of their plan.
 *
 * `psu-planner/CONTEXT.md` defines it as a **Term** and rejects "semester",
 * for a reason that is not stylistic: a summer is a Term and is not a
 * semester, and this planner lets a student opt into summers. "Skip semester"
 * is simply the wrong sentence once a summer is in the plan.
 *
 * It is also what the student already sees. LionPATH's own glossary defines
 * Term as "a period of study in an academic year (e.g., spring, summer,
 * fall)" -- summer included, by Penn State's own registrar. So "term" is not
 * an invented house word the interface has to teach; it is the one the
 * student enrolled through.
 *
 * This guard reads STRINGS AND JSX TEXT only. `plan.semesters` is the
 * serialized shape of a saved plan file and of the catalog's suggested plans;
 * renaming that would break every plan a student has saved, and no student
 * ever sees it. The distinction this test draws is exactly that one.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(f));
    else if (/\.tsx?$/.test(e.name)) out.push(f);
  }
  return out;
}

/** Quoted literals and JSX text -- the text that reaches a screen. Comments
 * are stripped first: prose explaining why the word is wrong would otherwise
 * trip the guard, and that is the one place it should be written. */
export function userFacingText(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const out: string[] = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    // A literal inside brackets is a key, not copy: `ProgramTemplate
    // ["semesters"]` is an indexed-access type naming the saved plan shape.
    if (code[m.index! - 1] === "[" && code[m.index! + m[0].length] === "]") continue;
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  // JSX text: between a tag close and the next tag open, with real letters.
  for (const m of code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) out.push(m[1]);
  return out;
}

/** The word, standing alone. `addSemester` and `semestersAfter` do not match
 * -- there is no word boundary inside camelCase -- and a leading `.` is
 * excluded so `plan.semesters` stays a property access rather than prose. */
const SEMESTER = /(^|[^.\w])semesters?\b/i;

describe("the interface calls a scheduled period a Term", () => {
  const files = sourceFiles(srcDir);

  it("has source to scan", () => {
    // A walker pointed at the wrong directory reports clean.
    expect(files.length, `no .ts/.tsx under ${srcDir}`).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("PlanCanvas.tsx"))).toBe(true);
  });

  it("finds the word when it is there", () => {
    // The guard is only worth its line count if it would actually fire, so it
    // is run against a planted occurrence of each shape it must catch, and
    // against the identifiers it must NOT catch.
    const planted = [
      `<button aria-label="Skip semester">x</button>`,
      `const msg = "Your courses move to later semesters";`,
      `<p>Add a semester</p>`,
      "const t = `${n} semesters remaining`;",
    ];
    for (const p of planted) {
      expect(userFacingText(p).some((s) => SEMESTER.test(s)), `missed: ${p}`).toBe(true);
    }
    const allowed = [
      `plan.semesters.map((s) => s.sem)`,
      `const { semestersAfter } = optimizeSchedule(plan);`,
      `store.addSemester(3)`,
      `// a summer is a Term and is not a semester`,
      `/** semesters here is the saved plan shape */`,
    ];
    for (const a of allowed) {
      expect(userFacingText(a).some((s) => SEMESTER.test(s)), `false positive: ${a}`).toBe(false);
    }
  });

  it("says term, not semester, in every string the student reads", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const s of userFacingText(fs.readFileSync(f, "utf-8"))) {
        if (SEMESTER.test(s)) offenders.push(`${path.relative(srcDir, f)}: ${s.trim().slice(0, 70)}`);
      }
    }
    expect(offenders, `user-facing copy still says "semester"`).toEqual([]);
  });
});

describe("the tools a model is handed", () => {
  /** A model mirrors the vocabulary of its own tool schema straight back to
   * the student, so this surface decides the copy as much as the components
   * do. It is also where the two surfaces had drifted: the MCP server already
   * said `add_term` / `skip_term` / `term_index` while the chat API said
   * `add_semester` / `delete_semester` / `semester_index` for the same engine
   * operations. */
  const api = fs.readFileSync(path.resolve(srcDir, "..", "..", "..", "apps", "api", "src", "tools.ts"), "utf-8");

  it("has the tool definitions to scan", () => {
    expect(api).toMatch(/TOOL_DEFS/);
    expect(api.match(/name: "/g)?.length ?? 0).toBeGreaterThan(15);
  });

  it("names no tool or parameter after a semester", () => {
    // Names only. Descriptions are checked separately because two of them
    // legitimately quote the student.
    const names = [...api.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]);
    const params = [...api.matchAll(/^\s*([a-z_]+): \{ type:/gm)].map((m) => m[1]);
    expect([...names, ...params].filter((n) => /semester/.test(n))).toEqual([]);
    // The walker found the real list, not an empty one.
    expect(names).toContain("skip_term");
    expect(params).toContain("term_index");
  });

  it("says semester only where it is quoting the student", () => {
    // "I'm taking a semester off" is how the request actually arrives. The
    // model needs the phrasing to RECOGNISE the intent; stripping it would
    // make the advisor worse at the exact request it matters most for. These
    // are inputs to match, never output to copy -- so they are pinned here
    // rather than merely tolerated, and any third occurrence has to justify
    // itself in this test.
    const lines = api.split("\n").filter((l) => /semester/i.test(l) && !l.trimStart().startsWith("*"));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l, `not a student quotation: ${l.trim().slice(0, 80)}`).toMatch(/semester\/year off|semester off/);
  });
});
