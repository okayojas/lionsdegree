/** What-if tabs, driven through the real store (#69).
 *
 * A what-if is an INDEPENDENT COPY of the student's Plan, kept beside it in
 * the one stored document. The store's `plan` is the plan IN VIEW: the
 * student's own, or the what-if whose tab is open, and every edit the
 * planner makes edits that. Everything worth asserting here follows:
 *
 *   - a new what-if is an exact copy, and from then on the two do not
 *     affect each other, whichever is edited and however;
 *   - what is SAVED and SYNCED is always the stored document, with the
 *     Plan's own contents at the top, never the what-if on screen;
 *   - keeping a what-if swaps it with the Plan, so nothing is lost;
 *   - a what-if stored the old way, as a list of changes, is converted
 *     once and not thrown away;
 *   - what-ifs never become rows in `plans`: the regression that would
 *     resurrect the second-plan bug #55 spent a whole ticket on.
 *
 * Like `program-merge-wiring.test.ts`, this drives the real store with the
 * catalog read off disk instead of over HTTP: a what-if made of invented
 * courses proves nothing about the bulletin's own.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_CANDIDATES, buildCatalog, buildItems, buildSchedule, candidatesOf, contentsOf, generatePlan, makeCandidate,
  type Candidate, type Course, type LegacyCandidate, type PlanContents, type PlanDoc, type ProgramTemplate,
} from "@psu-planner/engine";

const CATALOG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "catalog");
const LATEST = (JSON.parse(fs.readFileSync(path.join(CATALOG_ROOT, "editions.json"), "utf-8")) as { latest: string }).latest;
const dir = path.join(CATALOG_ROOT, LATEST);
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf-8"));
const subjects = read("subjects_index.json") as Record<string, string>;

// `persist` writes to localStorage on every plan change, and node has none.
// It is the mechanism under test for the round trip, so it is stubbed
// rather than mocked away.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
};

/** Every plan the store pushed, and how. The real `sync` module is
 * replaced because what this file needs to know is not whether Supabase
 * works — `plan-collision.test.ts` covers that — but that a Candidate
 * rides the ONE plan document rather than arriving as a second thing. */
const pushed: PlanDoc[] = [];
vi.mock("../src/data/sync", () => ({
  schedulePush: (p: PlanDoc) => void pushed.push(JSON.parse(JSON.stringify(p))),
  flushPush: async () => {},
  syncConfigured: false,
}));

vi.mock("../src/data/catalogClient", async () => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { buildCatalog: build } = await import("@psu-planner/engine");
  const root = nodePath.resolve(process.cwd(), "public", "catalog");
  const latest = (JSON.parse(nodeFs.readFileSync(nodePath.join(root, "editions.json"), "utf-8")) as { latest: string }).latest;
  const base = nodePath.join(root, latest);
  const readFile = (rel: string) => JSON.parse(nodeFs.readFileSync(nodePath.join(base, rel), "utf-8"));
  const subjectIndex = readFile("subjects_index.json") as Record<string, string>;
  const index = readFile("programs_index.json") as { slug: string; type: "major" | "minor" | "certificate" }[];
  const DIR = { major: "majors", minor: "minors", certificate: "certificates" } as const;
  return {
    // At the catalog ROOT, not inside an edition — the index of which
    // editions exist cannot live inside one of them.
    loadEditions: async () => JSON.parse(nodeFs.readFileSync(nodePath.join(root, "editions.json"), "utf-8")),
    setCatalogEdition: () => {},
    currentEdition: () => latest,
    loadProgramsIndex: async () => index,
    loadProgramBySlug: async (slug: string) => {
      const e = index.find((p) => p.slug === slug);
      return e ? readFile(`programs/${DIR[e.type]}/${slug}.json`) : null;
    },
    loadCatalogFor: async (codes: string[]) => {
      let courses: unknown[] = [];
      for (const pf of new Set(codes.map((c) => c.split(" ")[0]))) {
        if (subjectIndex[pf]) courses = courses.concat(readFile(subjectIndex[pf]));
      }
      return build(courses as never);
    },
    loadCoverage: async () => ({}),
    loadFlowchartPatterns: async () => undefined,
    loadIug: async () => null,
  };
});

const { usePlanner, loadSavedPlan, storedPlan } = await import("../src/store");

const ESC = "engineering-engineering-science-bs";

function escTemplate(): ProgramTemplate {
  const p = read(`programs/majors/${ESC}.json`);
  const up = p.suggestedPlans.find((s: { campusLabel: string }) => /University Park/i.test(s.campusLabel)) ?? p.suggestedPlans[0];
  return { slug: p.slug, name: p.name, campusLabel: "", semesters: up.semesters, requirements: p.requirementSections };
}

const codesIn = (plan: PlanDoc) => plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));

const NOW = "2026-11-01T12:00:00.000Z";

/** The student's Plan, generated from a real Program, in the store. */
function seed(candidates: (Candidate | LegacyCandidate)[] = []): PlanDoc {
  const plan = generatePlan([escTemplate()], {
    startTerm: { term: "Fall", year: 2026 },
    completedCourses: ["MATH 140"],
  }, "candidates");
  plan.rev = 9;
  plan.edition = LATEST;
  if (candidates.length) plan.candidates = candidates as Candidate[];
  let courses: Course[] = [];
  for (const pf of new Set(codesIn(plan).map((c) => c.split(" ")[0]))) {
    if (subjects[pf]) courses = courses.concat(read(subjects[pf]));
  }
  const catalog = buildCatalog(courses);
  const items = buildItems(plan, catalog);
  usePlanner.setState({
    plan, catalog, coverage: {}, items, sched: buildSchedule(plan, items, catalog),
    candidateId: null, home: null,
  });
  return plan;
}

/** The document as it was last saved to this device. */
const saved = () => loadSavedPlan()!;
/** The student's own Plan's contents, as saved: what a what-if must never change. */
const mine = (): PlanContents => contentsOf(saved());
/** A what-if's contents, as saved. */
const whatIf = (name: string): PlanContents => candidatesOf(saved()).find((c) => c.name === name)!.plan;
const state = () => usePlanner.getState();

/** A Course of the plan in view that is not done, and the Term it is in. */
function aCourse(): { code: string; id: string; term: number } {
  const it = state().items.find((i) => i.kind === "course" && i.code && !state().plan!.completed[i.code]);
  if (!it || !it.code) throw new Error("the plan in view has no course to move");
  return { code: it.code, id: it.id, term: state().sched[it.id] ?? 0 };
}

const MINOR = (read("programs_index.json") as { slug: string; type: string; name: string }[])
  .find((e) => e.type === "minor" && /^Mathematics/i.test(e.name))!.slug;

beforeEach(() => {
  mem.clear();
  pushed.length = 0;
  usePlanner.setState({ plan: null, catalog: {}, items: [], sched: {}, candidateId: null, home: null, repairNote: null });
});

describe("making a what-if", () => {
  it("makes an exact copy of the student's plan, in a new tab, and opens it", async () => {
    const plan = seed();
    const before = contentsOf(plan);
    const said = await state().newCandidate();
    expect(said).toMatch(/What-if 1/);
    expect(said).toMatch(/your plan is untouched/i);
    // THE COPY, on the stored document, beside the Plan it is a copy of.
    expect(candidatesOf(saved()).map((c) => c.name)).toEqual(["What-if 1"]);
    expect(whatIf("What-if 1")).toEqual(before);
    expect(mine()).toEqual(before);
    // OPEN: the plan in view is the copy, under the Plan's own identity.
    expect(state().candidateId).toBe(candidatesOf(saved())[0]!.id);
    expect(contentsOf(state().plan!)).toEqual(before);
    expect(state().plan!.id).toBe(plan.id);
  });

  it("is one write of the one document, and never a second plan", async () => {
    seed();
    await state().newCandidate();
    // THE #55 REGRESSION. A what-if rides the student's own document: one
    // push, one id, and the Plan's contents still at the top of it.
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.id).toBe("candidates");
    expect(pushed[0]!.candidates).toHaveLength(1);
    expect(pushed[0]!.rev).toBe(10);
  });

  it("copies the student's plan, whichever tab the + was pressed from", async () => {
    const plan = seed();
    const before = contentsOf(plan);
    await state().newCandidate();
    await state().deleteTerm(3);
    await state().newCandidate();
    // "What if" is a question about the plan they have, not about the
    // sketch they happened to be looking at.
    expect(whatIf("What-if 2")).toEqual(before);
    expect(whatIf("What-if 1")).not.toEqual(before);
  });

  it("numbers them, and takes a name where one is given", async () => {
    seed();
    await state().newCandidate();
    await state().newCandidate({ name: "Mathematics minor" });
    await state().newCandidate();
    expect(candidatesOf(saved()).map((c) => c.name)).toEqual(["What-if 1", "Mathematics minor", "What-if 2"]);
  });

  it("refuses at the limit, names what is in the way, and writes nothing", async () => {
    seed();
    for (let i = 0; i < MAX_CANDIDATES; i++) await state().newCandidate();
    const rev = saved().rev;
    const said = await state().newCandidate();
    expect(said).toMatch(/the most a plan holds/);
    for (let i = 1; i <= MAX_CANDIDATES; i++) expect(said).toContain(`"What-if ${i}"`);
    expect(candidatesOf(saved())).toHaveLength(MAX_CANDIDATES);
    expect(saved().rev).toBe(rev);
  });
});

describe("a what-if and the plan do not affect each other", () => {
  /** Every kind of edit the planner makes, each as the student would make
   * it. A what-if used to refuse the second half of this list. */
  const EDITS: [string, () => Promise<unknown> | unknown][] = [
    ["moving a course", async () => { const c = aCourse(); await state().moveItem(c.id, c.term + 1); }],
    ["adding a course", () => state().addCourseAt("ART 20", 1)],
    ["skipping a term", () => state().deleteTerm(3)],
    ["adding a term", () => state().addTerm()],
    ["packing the schedule", () => state().optimizeNow()],
    ["marking a course complete", () => state().markCompleted(aCourse().code, true)],
    ["taking a course out", () => state().removeItem(aCourse().id)],
    ["adding a summer", () => state().addSummerSession(2027)],
    ["declaring a minor", () => state().addProgramNow(MINOR)],
  ];

  it.each(EDITS)("%s in a what-if changes the what-if and leaves the plan exactly as it was", async (_what, edit) => {
    const plan = seed();
    const before = contentsOf(plan);
    await state().newCandidate();
    await edit();
    // Anything the edit set going (a re-flow after a completion) has landed.
    await new Promise((r) => setTimeout(r, 0));
    expect(whatIf("What-if 1"), "the edit did not reach the what-if").not.toEqual(before);
    expect(mine(), "an edit in a what-if changed the student's plan").toEqual(before);
    // And on the way to the account: every document pushed has the Plan's
    // own contents at the top of it.
    for (const doc of pushed) expect(contentsOf(doc)).toEqual(before);
  });

  it.each(EDITS)("%s in the plan leaves a what-if exactly as it was", async (_what, edit) => {
    const plan = seed();
    const before = contentsOf(plan);
    await state().newCandidate();
    await state().showCandidate(null);
    await edit();
    await new Promise((r) => setTimeout(r, 0));
    expect(mine(), "the edit did not reach the plan").not.toEqual(before);
    expect(whatIf("What-if 1"), "an edit to the plan changed a what-if").toEqual(before);
  });

  it("an edit in one what-if leaves another alone", async () => {
    const plan = seed();
    const before = contentsOf(plan);
    await state().newCandidate();
    await state().newCandidate();
    await state().deleteTerm(3);
    expect(whatIf("What-if 2")).not.toEqual(before);
    expect(whatIf("What-if 1")).toEqual(before);
    expect(mine()).toEqual(before);
  });

  it("the plan in view is the what-if's own, and going back shows the plan's", async () => {
    const plan = seed();
    await state().newCandidate();
    const id = state().candidateId!;
    await state().addProgramNow(MINOR);
    expect(state().plan!.programs).toContain(MINOR);
    expect(state().items.length).toBeGreaterThan(0);
    await state().showCandidate(null);
    expect(state().plan!.programs).toEqual(plan.programs);
    expect(state().home).toBeNull();
    await state().showCandidate(id);
    expect(state().plan!.programs).toContain(MINOR);
  });

  it("looking writes nothing: switching tabs does not advance the revision", async () => {
    seed();
    await state().newCandidate();
    const id = state().candidateId!;
    const rev = saved().rev;
    const writes = pushed.length;
    await state().showCandidate(null);
    await state().showCandidate(id);
    await state().showCandidate(null);
    expect(saved().rev).toBe(rev);
    expect(pushed).toHaveLength(writes);
  });

  it("what is exported is the stored document, with the plan at the top, whichever tab is open", async () => {
    const plan = seed();
    const before = contentsOf(plan);
    await state().newCandidate();
    await state().deleteTerm(3);
    // On screen: the what-if. For a file, the account or another device:
    // the student's Plan, with the what-if inside it.
    expect(contentsOf(state().plan!)).not.toEqual(before);
    expect(contentsOf(storedPlan()!)).toEqual(before);
    expect(storedPlan()).toEqual(saved());
  });
});

describe("keeping a what-if", () => {
  it("makes it the plan, and keeps the plan it replaces as a what-if", async () => {
    const plan = seed();
    const before = contentsOf(plan);
    await state().newCandidate();
    await state().deleteTerm(3);
    const sketch = whatIf("What-if 1");
    const said = await state().keepCandidate(state().candidateId!);
    expect(mine()).toEqual(sketch);
    // NOTHING IS LOST. What was the Plan is a tab, whole, and the message
    // says where it went.
    expect(candidatesOf(saved()).map((c) => c.name)).toEqual(["My plan before What-if 1"]);
    expect(whatIf("My plan before What-if 1")).toEqual(before);
    expect(said).toMatch(/It's your plan now/);
    expect(said).toContain('"My plan before What-if 1"');
    // The student is looking at their Plan again, which is the kept one.
    expect(state().candidateId).toBeNull();
    expect(contentsOf(state().plan!)).toEqual(sketch);
  });

  it("can be undone by keeping what it replaced", async () => {
    const plan = seed();
    const before = contentsOf(plan);
    await state().newCandidate();
    await state().deleteTerm(3);
    await state().keepCandidate(state().candidateId!);
    const replaced = candidatesOf(saved())[0]!;
    await state().keepCandidate(replaced.id);
    expect(mine()).toEqual(before);
  });

  it("works at the limit, because it does not change how many there are", async () => {
    seed();
    for (let i = 0; i < MAX_CANDIDATES; i++) await state().newCandidate();
    const said = await state().keepCandidate(state().candidateId!);
    expect(said).toMatch(/It's your plan now/);
    expect(candidatesOf(saved())).toHaveLength(MAX_CANDIDATES);
  });

  it("is one write, of the same plan", async () => {
    seed();
    await state().newCandidate();
    const rev = saved().rev;
    pushed.length = 0;
    await state().keepCandidate(state().candidateId!);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.id).toBe("candidates");
    expect(pushed[0]!.rev).toBe(rev + 1);
  });

  it("says so where the what-if is no longer there", async () => {
    seed();
    expect(await state().keepCandidate("gone")).toMatch(/no longer on this plan/);
  });
});

describe("renaming and deleting a what-if", () => {
  it("renames one, and refuses a name that is empty, too long or taken", async () => {
    seed();
    await state().newCandidate();
    await state().newCandidate();
    const [first, second] = candidatesOf(saved());
    expect(state().renameCandidate(first!.id, "Abroad")).toMatch(/Renamed it to "Abroad"/);
    expect(candidatesOf(saved())[0]!.name).toBe("Abroad");
    expect(state().renameCandidate(second!.id, "abroad")).toMatch(/already have a what-if called/);
    expect(state().renameCandidate(second!.id, "  ")).toMatch(/needs a name/);
    expect(state().renameCandidate(second!.id, "x".repeat(41))).toMatch(/41 characters/);
    expect(candidatesOf(saved())[1]!.name).toBe("What-if 2");
  });

  it("a rename made with a what-if open keeps that what-if's edits", async () => {
    const plan = seed();
    await state().newCandidate();
    await state().deleteTerm(3);
    const edited = whatIf("What-if 1");
    state().renameCandidate(state().candidateId!, "A term off");
    expect(whatIf("A term off")).toEqual(edited);
    expect(mine()).toEqual(contentsOf(plan));
  });

  it("deleting the open one goes back to the plan, which is untouched", async () => {
    const plan = seed();
    await state().newCandidate();
    await state().deleteTerm(3);
    state().deleteCandidate(state().candidateId!);
    expect(candidatesOf(saved())).toEqual([]);
    expect(state().candidateId).toBeNull();
    expect(mine()).toEqual(contentsOf(plan));
    expect(contentsOf(state().plan!)).toEqual(contentsOf(plan));
  });

  it("deleting another one leaves the open one open, with its edits", async () => {
    seed();
    await state().newCandidate();
    await state().newCandidate();
    await state().deleteTerm(3);
    const open = state().candidateId!;
    const edited = whatIf("What-if 2");
    state().deleteCandidate(candidatesOf(saved())[0]!.id);
    expect(state().candidateId).toBe(open);
    expect(candidatesOf(saved()).map((c) => c.name)).toEqual(["What-if 2"]);
    expect(whatIf("What-if 2")).toEqual(edited);
  });
});

describe("a what-if stored the old way, as a list of changes", () => {
  const legacy = (over: Partial<LegacyCandidate> = {}): LegacyCandidate => ({
    id: "c1",
    name: "a term off",
    changes: [{ tool: "skip_term", arguments: { term_index: 3 } }],
    basedOnRev: 9,
    createdAt: NOW,
    ...over,
  });

  it("is converted when the plan loads: the copy its changes come to", async () => {
    const plan = structuredClone(seed([legacy()]));
    // Read now: the store works on the document it is handed.
    const rev = plan.rev;
    await state().setPlan(plan);
    const copies = candidatesOf(saved());
    expect(copies.map((c) => [c.id, c.name])).toEqual([["c1", "a term off"]]);
    // The change is in the copy, and not in the Plan.
    expect(copies[0]!.plan.terms[3]?.gap).toBe(true);
    expect(saved().terms[3]?.gap).toBeUndefined();
    // Nothing of the old shape is left to replay.
    expect(saved().candidates![0]).not.toHaveProperty("changes");
    // And the conversion is saved as an ordinary write, so it reaches the
    // account and is not done again on every device.
    expect(saved().rev).toBe(rev + 1);
    expect(state().repairNote ?? "").not.toMatch(/no longer fit/);
  });

  it("is kept, as a copy of the plan, where its changes no longer apply, and the student is told", async () => {
    const plan = structuredClone(seed([legacy({ name: "impossible", changes: [{ tool: "skip_term", arguments: { term_index: 99 } }] })]));
    await state().setPlan(plan);
    // AN UPDATE MUST NOT DELETE THEIR WORK. The tab is still there, under
    // its name; what it holds is said.
    expect(candidatesOf(saved()).map((c) => c.name)).toEqual(["impossible"]);
    expect(whatIf("impossible")).toEqual(mine());
    expect(state().repairNote).toMatch(/"impossible" was a what-if made of changes that no longer fit your plan/);
  });

  it("leaves a what-if that is already a copy exactly as it is", async () => {
    const plan = seed();
    const copy = makeCandidate("c2", "already a copy", plan, NOW);
    copy.plan.terms[2]!.gap = true;
    const mixed = structuredClone(seed([legacy(), copy]));
    await state().setPlan(mixed);
    expect(candidatesOf(saved()).map((c) => c.name)).toEqual(["a term off", "already a copy"]);
    expect(whatIf("already a copy")).toEqual(copy.plan);
  });

  it("is not listed or opened until it has been converted", async () => {
    seed([legacy()]);
    expect(candidatesOf(state().plan)).toEqual([]);
    await state().showCandidate("c1");
    expect(state().candidateId).toBeNull();
    expect(state().repairNote).toMatch(/no longer on this plan/);
  });
});

const ME = "engineering-mechanical-engineering-bs";
const ME_ENTRY = { slug: ME, name: "Mechanical Engineering, B.S.", type: "major" as const };

describe("changing one program for another", () => {
  it("shows what it would do first, and changes nothing by showing it", async () => {
    const plan = seed();
    const preview = await state().previewChangeProgram(ESC, ME);
    expect(preview!.refusal).toBeNull();
    expect(preview!.removed!.coursesRemoved.length, "nothing is said to leave, between two different majors").toBeGreaterThan(0);
    expect(preview!.added!.coursesAdded.length).toBeGreaterThan(0);
    // A PREVIEW. Not saved, not pushed, not on screen.
    expect(loadSavedPlan(), "the preview was saved").toBeNull();
    expect(pushed).toHaveLength(0);
    expect(state().plan!.programs).toEqual(plan.programs);
    expect(state().plan!.rev).toBe(plan.rev);
  });

  it("does it in one step: the new program in the old one's place, and what the preview said left is gone", async () => {
    seed();
    const preview = await state().previewChangeProgram(ESC, ME);
    const said = await state().changeProgramNow(ESC, ME);
    expect(said).toContain("Changed to Mechanical Engineering");
    expect(saved().programs).toEqual([ME]);
    expect(saved().rev).toBe(10);
    const now = codesIn(saved());
    for (const code of preview!.removed!.coursesRemoved) expect(now, `${code} was to leave`).not.toContain(code);
    // What the student had done is still theirs.
    expect(saved().completed["MATH 140"]).toBe(true);
  });

  it("can be tried in a what-if, which is what a what-if could not hold before", async () => {
    const plan = seed();
    const before = contentsOf(plan);
    await state().newCandidate();
    await state().changeProgramNow(ESC, ME);
    expect(whatIf("What-if 1").programs).toEqual([ME]);
    expect(mine(), "changing the program in a what-if changed the student's plan").toEqual(before);
    expect(saved().programs).toEqual([ESC]);
  });

  it("refuses a program the plan does not have, and writes nothing", async () => {
    seed();
    expect(await state().changeProgramNow(MINOR, ME)).toMatch(/not one of this plan's programs/);
    expect(loadSavedPlan()).toBeNull();
  });
});

describe("a link to a program, followed by a student who already has a plan", () => {
  it("opens it as a what-if: a copy of their plan with that major in place of theirs, and the plan untouched", async () => {
    const plan = seed();
    const before = contentsOf(plan);
    const said = await state().openProgramAsWhatIf(ME_ENTRY);
    expect(said).toMatch(/Opened Mechanical Engineering, B\.S\. as a what-if/);
    expect(said).toMatch(/Your plan is untouched/);
    // The what-if is named for the Program, is open, and has it.
    expect(candidatesOf(saved()).map((c) => c.name)).toEqual(["Mechanical Engineering, B.S."]);
    expect(whatIf("Mechanical Engineering, B.S.").programs).toEqual([ME]);
    expect(state().candidateId).toBe(candidatesOf(saved())[0]!.id);
    expect(state().plan!.programs).toEqual([ME]);
    // THE POINT. The link used to be ignored; the alternative that was
    // never acceptable is that it changes the plan they have.
    expect(mine()).toEqual(before);
  });

  it("adds a minor or a certificate beside the major, in the what-if", async () => {
    const plan = seed();
    await state().openProgramAsWhatIf({ slug: MINOR, name: "Mathematics Minor", type: "minor" });
    expect(whatIf("Mathematics Minor").programs).toEqual([ESC, MINOR]);
    expect(mine()).toEqual(contentsOf(plan));
  });

  it("followed twice, opens the what-if it made the first time and makes no second", async () => {
    seed();
    await state().openProgramAsWhatIf(ME_ENTRY);
    await state().deleteTerm(3);
    const edited = whatIf("Mechanical Engineering, B.S.");
    await state().showCandidate(null);
    const said = await state().openProgramAsWhatIf(ME_ENTRY);
    expect(said).toMatch(/Showing the what-if "Mechanical Engineering, B\.S\."/);
    expect(candidatesOf(saved())).toHaveLength(1);
    expect(whatIf("Mechanical Engineering, B.S."), "the student's edits in it were lost").toEqual(edited);
    expect(state().candidateId).toBe(candidatesOf(saved())[0]!.id);
  });

  it("at the limit says so, names the what-ifs in the way, and changes nothing", async () => {
    seed();
    for (let i = 0; i < MAX_CANDIDATES; i++) await state().newCandidate();
    await state().showCandidate(null);
    const was = saved();
    const said = await state().openProgramAsWhatIf(ME_ENTRY);
    expect(said).toMatch(/the most a plan holds/);
    expect(said).toContain('"What-if 1"');
    expect(saved()).toEqual(was);
    expect(state().candidateId).toBeNull();
  });

  it("says so where the program is already on their plan, and makes nothing", async () => {
    seed();
    const said = await state().openProgramAsWhatIf({ slug: ESC, name: "Engineering Science, B.S.", type: "major" });
    expect(said).toMatch(/already on your plan/);
    expect(loadSavedPlan()).toBeNull();
  });

  it("leaves no empty what-if behind where the program will not load", async () => {
    const plan = seed();
    const said = await state().openProgramAsWhatIf({ slug: "no-such-program", name: "No Such Program", type: "major" });
    expect(said).toMatch(/No what-if was made, and your plan is untouched/);
    expect(candidatesOf(saved())).toEqual([]);
    expect(state().candidateId).toBeNull();
    expect(mine()).toEqual(contentsOf(plan));
  });
});
