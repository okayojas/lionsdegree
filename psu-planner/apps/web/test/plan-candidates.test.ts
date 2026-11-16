/** What-if tabs, driven through the real store.
 *
 * A Candidate is a NAMED LIST OF CHANGES kept on the student's own Plan.
 * The planner re-runs it against the plan as it stands to draw the tab,
 * and "keep this one" replays the calls through the ordinary mutation
 * path. Everything worth asserting here is about that distinction:
 *
 *   - the changes are what is stored, and they survive a save and a load;
 *   - deleting one leaves the plan itself alone, observed on the stored
 *     document rather than on what the screen shows;
 *   - a what-if whose change has stopped being possible SAYS SO and draws
 *     nothing, instead of rendering a partial plan;
 *   - candidates never become rows in `plans` — the regression that would
 *     resurrect the second-plan bug #55 spent a whole ticket on.
 *
 * Like `program-merge-wiring.test.ts`, this drives the real store with the
 * catalog read off disk instead of over HTTP: a what-if computed against
 * invented courses proves nothing about the bulletin's own.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCatalog, buildItems, buildSchedule, generatePlan,
  type Candidate, type Course, type PlanDoc, type ProgramTemplate,
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

const { usePlanner, loadSavedPlan } = await import("../src/store");

const ESC = "engineering-engineering-science-bs";

function escTemplate(): ProgramTemplate {
  const p = read(`programs/majors/${ESC}.json`);
  const up = p.suggestedPlans.find((s: { campusLabel: string }) => /University Park/i.test(s.campusLabel)) ?? p.suggestedPlans[0];
  return { slug: p.slug, name: p.name, campusLabel: "", semesters: up.semesters, requirements: p.requirementSections };
}

const codesIn = (plan: PlanDoc) => plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: "c1",
  name: "a term off",
  changes: [{ tool: "skip_term", arguments: { term_index: 3 } }],
  basedOnRev: 9,
  createdAt: "2026-11-01T12:00:00.000Z",
  ...over,
});

function seed(candidates: Candidate[]): PlanDoc {
  const plan = generatePlan([escTemplate()], {
    startTerm: { term: "Fall", year: 2026 },
    completedCourses: ["MATH 140"],
  }, "candidates");
  plan.rev = 9;
  plan.edition = LATEST;
  plan.candidates = candidates;
  let courses: Course[] = [];
  for (const pf of new Set(codesIn(plan).map((c) => c.split(" ")[0]))) {
    if (subjects[pf]) courses = courses.concat(read(subjects[pf]));
  }
  const catalog = buildCatalog(courses);
  const items = buildItems(plan, catalog);
  usePlanner.setState({
    plan, catalog, coverage: {}, items, sched: buildSchedule(plan, items, catalog),
    candidateId: null, candidateView: null, candidateRefusal: null, candidateBusy: false,
  });
  return plan;
}

const storedPlan = () => loadSavedPlan()!;

beforeEach(() => {
  mem.clear();
  pushed.length = 0;
  usePlanner.setState({
    plan: null, catalog: {}, items: [], sched: {},
    candidateId: null, candidateView: null, candidateRefusal: null, candidateBusy: false,
  });
});

describe("a what-if kept beside the student's plan", () => {
  it("survives a save and a load with its changes intact", async () => {
    seed([candidate()]);
    // Any edit persists the whole document, which is the point: a
    // Candidate rides the Plan's own storage rather than needing its own.
    usePlanner.getState().mutatePlan((p) => { p.completed["CHEM 110"] = true; });

    const onDisk = storedPlan();
    expect(onDisk.candidates?.length, "the what-if did not survive being saved").toBe(1);
    expect(onDisk.candidates![0].changes, "the CHANGES are not what was stored").toEqual([
      { tool: "skip_term", arguments: { term_index: 3 } },
    ]);
    expect(JSON.stringify(onDisk.candidates), "a plan document was stored inside the what-if")
      .not.toMatch(/"terms"/);
  });

  it("is pushed inside the one plan document, never as a second plan", async () => {
    // THE REGRESSION #55 PAID FOR. `pullNewerPlan` reads the plans table
    // newest-first and takes one row, so anything plan-shaped written
    // beside the real plan is adopted as the student's plan on their next
    // device. A Candidate is a FIELD, and this is what proves it.
    seed([candidate(), candidate({ id: "c2", name: "abroad junior spring" })]);
    usePlanner.getState().mutatePlan((p) => { p.completed["CHEM 110"] = true; });

    expect(pushed.length, "saving a plan with what-ifs on it pushed more than one document").toBe(1);
    expect(pushed[0].id, "a what-if was pushed as a plan in its own right")
      .toBe(usePlanner.getState().plan!.id);
    expect(pushed[0].candidates?.map((c) => c.name)).toEqual(["a term off", "abroad junior spring"]);
  });

  it("is drawn by recomputing it against the plan as it stands", async () => {
    // RECOMPUTED, NOT REPLAYED. Nothing about the resulting plan is
    // stored, so a tab cannot go stale into a lie.
    seed([candidate()]);
    const before = usePlanner.getState().plan!.terms.length;
    await usePlanner.getState().showCandidate("c1");

    const s = usePlanner.getState();
    expect(s.candidateRefusal, `the what-if was refused: ${s.candidateRefusal?.reason}`).toBeNull();
    expect(s.candidateView, "no plan came back to draw").toBeTruthy();
    expect(s.candidateView!.name).toBe("a term off");
    // Skipping a term keeps it empty and flows the coursework around it,
    // so the plan the tab draws is genuinely a different shape.
    expect(
      s.candidateView!.plan.terms.some((t) => t.gap),
      "the what-if drew a plan with the change missing from it",
    ).toBe(true);
    expect(s.candidateView!.plan.terms.length).toBeGreaterThanOrEqual(before);
    expect(usePlanner.getState().plan!.terms.some((t) => t.gap), "drawing a what-if changed the real plan")
      .toBe(false);
  });

  it("is recomputed when the plan document is written underneath it", async () => {
    // A tab left showing the comparison the student had an hour ago is
    // the stale-into-a-lie case the stored-changes design rules out.
    //
    // DELETING ANOTHER WHAT-IF is the write used here, and it is the only
    // kind left: since #59 the student cannot edit their real plan while
    // a tab is open — those edits are routed into the what-if instead,
    // which is what the next describe is about. What this still proves is
    // that a write to the plan document re-runs the open tab rather than
    // leaving the drawing it had.
    seed([candidate(), candidate({ id: "c2", name: "abroad junior spring" })]);
    await usePlanner.getState().showCandidate("c1");
    const drawn = usePlanner.getState().candidateView;
    expect(drawn, "nothing was drawn to begin with").toBeTruthy();

    usePlanner.getState().deleteCandidate("c2");
    await vi.waitFor(() => {
      expect(
        usePlanner.getState().candidateView,
        "the open tab was not re-run after the plan was written",
      ).not.toBe(drawn);
    });
    expect(
      usePlanner.getState().candidateView!.plan.terms.some((t) => t.gap),
      "the re-run lost the what-if's own change",
    ).toBe(true);
  });
});

describe("a what-if whose change has stopped being possible", () => {
  it("says so and draws nothing", async () => {
    // NO PARTIAL PLAN, EVER. A chart missing one of the changes the
    // student asked about looks exactly like a plan they could have.
    seed([candidate({ changes: [{ tool: "add_course", arguments: { code: "NOPE 999", term_index: 0 } }] })]);
    await usePlanner.getState().showCandidate("c1");

    const s = usePlanner.getState();
    expect(s.candidateView, "a plan was drawn for a what-if that cannot be computed").toBeNull();
    expect(s.candidateRefusal, "the student is told nothing about why").toBeTruthy();
    expect(s.candidateRefusal!.reason, "the refusal does not name what went wrong")
      .toMatch(/NOPE 999/);
    expect(s.candidateRefusal!.nothingChanged).toMatch(/not been changed/i);
  });

  it("refuses to be kept, and the plan is untouched", async () => {
    seed([candidate({ changes: [{ tool: "add_course", arguments: { code: "NOPE 999", term_index: 0 } }] })]);
    const before = JSON.stringify(usePlanner.getState().plan);

    const said = await usePlanner.getState().keepCandidate("c1");
    expect(said).toMatch(/NOPE 999/);
    expect(JSON.stringify(usePlanner.getState().plan), "a what-if that cannot be computed still wrote")
      .toBe(before);
  });
});

describe("keeping a what-if", () => {
  it("replays its changes onto the real plan and takes its tab away", async () => {
    seed([candidate(), candidate({ id: "c2", name: "abroad junior spring" })]);
    await usePlanner.getState().showCandidate("c1");

    const said = await usePlanner.getState().keepCandidate("c1");
    const after = usePlanner.getState().plan!;

    expect(said, "the student is told nothing about what happened").toMatch(/a term off/);
    expect(after.terms.some((t) => t.gap), "keeping the what-if did not make its change").toBe(true);
    expect(after.rev, "the revision did not advance").toBeGreaterThan(9);
    expect(after.candidates?.map((c) => c.id), "the kept what-if is still a tab, or the others went")
      .toEqual(["c2"]);
    expect(usePlanner.getState().candidateId, "the tab is still open on a what-if that is now the plan")
      .toBeNull();
  });

  it("takes a required course out when that is what it says, and names it first", async () => {
    /* THE OWNER'S CALL ON #59. Keeping a what-if that removes a required
       Course is allowed: it is the student's own plan and their own
       click, and the planner already drops a Course from the course card
       with no quote at all. What the gate is for is a MODEL claiming a
       student asked — unchanged, and still enforced over the wire.

       The warning is not what went. `needsConsent` is still computed and
       still shown on the tab BEFORE the student chooses; it stopped being
       a wall and became a sentence. */
    const first = seed([]);
    const code = first.terms
      .flatMap((t) => t.items.flatMap((i) => ("code" in i && i.origin ? [i.code] : [])))[0];
    expect(code, "the seeded plan has no required course, so this proves nothing").toBeTruthy();
    seed([candidate({ changes: [{ tool: "remove_course", arguments: { code } }] })]);
    await usePlanner.getState().showCandidate("c1");

    const view = usePlanner.getState().candidateView;
    expect(view, `the what-if refused itself: ${usePlanner.getState().candidateRefusal?.reason}`).toBeTruthy();
    expect(view!.needsConsent, "the student is not told what keeping takes out").toContain(code);

    const said = await usePlanner.getState().keepCandidate("c1");

    expect(said, `keeping was refused: ${said}`).toMatch(/Kept/);
    expect(codesIn(usePlanner.getState().plan!), "the course the what-if removes is still in the plan")
      .not.toContain(code);
    expect(codesIn(storedPlan())).not.toContain(code);
  });

  it("is refused when the plan moved underneath it, and nothing is overwritten", async () => {
    // ADR 0003 through the planner's own path. The revision each change
    // names is checked against the LIVE plan, which is the entire reason
    // a Candidate stores calls rather than a document — installing a
    // document would have no revision to name.
    seed([candidate()]);
    const snapshotRev = usePlanner.getState().plan!.rev;
    // The assistant edits the plan between the student reading the tab
    // and pressing Keep.
    usePlanner.getState().mutatePlan((p) => { p.completed["PHYS 211"] = true; });
    expect(usePlanner.getState().plan!.rev).toBe(snapshotRev + 1);

    const stale = { ...usePlanner.getState(), plan: { ...usePlanner.getState().plan!, rev: snapshotRev } };
    const { keepCandidate } = await import("../src/data/candidateRun");
    const out = await keepCandidate(
      { plan: stale.plan as PlanDoc, catalog: stale.catalog, items: stale.items, sched: stale.sched },
      candidate(),
      async (next, baseRev) => (usePlanner.getState().plan!.rev === baseRev ? "written" : "stale"),
    );

    expect(out.applied, "a change computed from a revision the plan has moved past was written").toBe(0);
    expect(out.refused, "the write was neither applied nor refused").toBeTruthy();
    expect(usePlanner.getState().plan!.terms.some((t) => t.gap), "a refused keep still changed the plan")
      .toBe(false);
  });
});

/** The student's degree, with the what-ifs taken off.
 *
 * WHAT "THE REAL PLAN IS UNTOUCHED" HAS TO MEAN, and it is asserted as
 * bytes rather than as a field or two: every part of the document that is
 * the student's degree is identical. `candidates` is excluded because
 * that is precisely where a what-if's changes are stored, and `rev` and
 * `updatedAt` because storing one advances them — the test would then be
 * asserting that nothing was saved, which is a different and wrong claim.
 */
const degree = (p: PlanDoc): string => {
  const { candidates: _c, rev: _r, updatedAt: _u, ...rest } = p;
  return JSON.stringify(rest);
};

/** Make a what-if and open it, the way the `+` does. */
async function plusButton(): Promise<string> {
  const said = await usePlanner.getState().newCandidate();
  const id = usePlanner.getState().candidateId;
  if (!id) throw new Error(`the + did not open a what-if: ${said}`);
  return id;
}

const openChanges = () => {
  const s = usePlanner.getState();
  return (s.plan!.candidates ?? []).find((c) => c.id === s.candidateId)!.changes;
};

describe("a what-if the student makes themselves", () => {
  it("starts as the plan as it stands, with nothing in it", async () => {
    // AN EMPTY CHANGE LIST, not a copy of the document. A frozen PlanDoc
    // is exactly what #56 refused: it would go stale against the real
    // plan without saying so, and keeping it would have no revision to
    // name (ADR 0003).
    seed([]);
    const before = degree(usePlanner.getState().plan!);

    const said = await usePlanner.getState().newCandidate();
    const s = usePlanner.getState();
    const made = s.plan!.candidates![0];
    expect(s.candidateId, "the what-if was made but not opened").toBe(made.id);

    expect(made.changes, "the new what-if was not empty").toEqual([]);
    expect(made.name, "the student was made to name it before drawing").toBe("What-if 1");
    expect(made.basedOnRev, "it does not record which plan it was made from").toBe(9);
    expect(degree(s.plan!), "making a what-if changed the plan it was made from").toBe(before);
    expect(degree(storedPlan()), "the stored plan was changed").toBe(before);
    expect(said).toMatch(/What-if 1/);
  });

  it("opens, and draws the plan exactly as it stands", async () => {
    seed([]);
    await plusButton();
    const s = usePlanner.getState();
    expect(s.candidateRefusal, `the empty what-if refused itself: ${s.candidateRefusal?.reason}`).toBeNull();
    expect(s.candidateView, "nothing was drawn").toBeTruthy();
    // The same terms and the same courses: no changes means no changes.
    expect(s.candidateView!.plan.terms.map((t) => t.label)).toEqual(s.plan!.terms.map((t) => t.label));
    expect(codesIn(s.candidateView!.plan)).toEqual(codesIn(s.plan!));
  });

  it("numbers the next one past the ones already there", async () => {
    seed([candidate({ name: "What-if 1" })]);
    await plusButton();
    expect(usePlanner.getState().plan!.candidates![1].name).toBe("What-if 2");
  });

  it("refuses past the cap and names which ones are in the way", async () => {
    // NOT A SILENT FAILURE AND NOT A SILENT DROP. Deleting the oldest
    // would take away a comparison the student is in the middle of
    // making, with nothing to say which one went.
    seed([
      candidate({ id: "a", name: "seven terms" }),
      candidate({ id: "b", name: "abroad" }),
      candidate({ id: "c", name: "co-op" }),
      candidate({ id: "d", name: "summer" }),
    ]);
    const before = degree(usePlanner.getState().plan!);

    const said = await usePlanner.getState().newCandidate();

    expect(usePlanner.getState().plan!.candidates, "a fifth what-if was made past the cap")
      .toHaveLength(4);
    for (const name of ["seven terms", "abroad", "co-op", "summer"]) {
      expect(said, "the refusal does not say which what-ifs are in the way").toContain(name);
    }
    expect(degree(usePlanner.getState().plan!)).toBe(before);
  });

  it("can be renamed, and will not take a name another one has", async () => {
    seed([candidate({ id: "c1", name: "abroad" })]);
    await plusButton();
    const id = usePlanner.getState().candidateId!;

    expect(usePlanner.getState().renameCandidate(id, "abroad")).toMatch(/already have/i);
    expect(usePlanner.getState().plan!.candidates![1].name, "a duplicate name was taken anyway")
      .toBe("What-if 1");

    expect(usePlanner.getState().renameCandidate(id, "  finish in 7 terms  ")).toMatch(/finish in 7 terms/);
    expect(usePlanner.getState().plan!.candidates![1].name).toBe("finish in 7 terms");
    expect(storedPlan().candidates![1].name, "the new name was not saved").toBe("finish in 7 terms");
    expect(
      usePlanner.getState().candidateView!.name,
      "the view still carries the old name, so the list view would say the wrong one",
    ).toBe("finish in 7 terms");
  });
});

describe("editing inside a what-if", () => {
  /* THE PROPERTY THIS TICKET TURNS ON. Every edit the planner accepts
     while a tab is open must land on THAT what-if's change list and not
     on the student's plan — a mutation that forgot the routing would
     change the degree they believe they are experimenting away from.
     Asserted for every mutation the what-if accepts, on the STORED
     document as well as the one in memory, because the stored one is
     what their other devices read. */

  const courseOnChart = () => {
    const it = usePlanner.getState().candidateView!.items.find((i) => i.kind === "course" && !!i.code);
    if (!it) throw new Error("the what-if drew no courses to move");
    return it;
  };

  it("records a move as a change, and moves nothing in the plan", async () => {
    seed([]);
    await plusButton();
    const before = degree(usePlanner.getState().plan!);
    const it = courseOnChart();
    const to = it.sem === 2 ? 3 : 2;

    await usePlanner.getState().moveItem(it.id, to);

    expect(openChanges(), "the move is not on the what-if's change list").toEqual([
      { tool: "move_course", arguments: { code: it.code, term_index: to } },
    ]);
    expect(degree(usePlanner.getState().plan!), "moving a course inside a what-if moved it in the real plan")
      .toBe(before);
    expect(degree(storedPlan()), "the stored plan was changed").toBe(before);
    expect(
      usePlanner.getState().candidateView!.items.find((i) => i.code === it.code)!.sem,
      "the what-if does not show the move",
    ).toBe(to);
  });

  it("records an added term as a change, and adds none to the plan", async () => {
    seed([]);
    await plusButton();
    const before = degree(usePlanner.getState().plan!);
    const terms = usePlanner.getState().plan!.terms.length;

    const idx = await usePlanner.getState().addTerm();

    expect(openChanges()).toEqual([{ tool: "add_term", arguments: {} }]);
    expect(idx, "the new term's index is not the one the what-if now has").toBe(terms);
    expect(usePlanner.getState().candidateView!.plan.terms.length).toBe(terms + 1);
    expect(usePlanner.getState().plan!.terms.length, "a term was added to the real plan").toBe(terms);
    expect(degree(storedPlan()), "the stored plan was changed").toBe(before);
  });

  it("records a skipped term as a change, and skips none in the plan", async () => {
    seed([]);
    await plusButton();
    const before = degree(usePlanner.getState().plan!);

    await usePlanner.getState().deleteTerm(3);

    expect(openChanges()).toEqual([{ tool: "skip_term", arguments: { term_index: 3 } }]);
    expect(usePlanner.getState().candidateView!.plan.terms.some((t) => t.gap)).toBe(true);
    expect(usePlanner.getState().plan!.terms.some((t) => t.gap), "a term was skipped in the real plan")
      .toBe(false);
    expect(degree(storedPlan()), "the stored plan was changed").toBe(before);
  });

  it("records un-skipping a term as a change, and the plan never had one", async () => {
    seed([]);
    await plusButton();
    const before = degree(usePlanner.getState().plan!);

    await usePlanner.getState().deleteTerm(3);
    await usePlanner.getState().restoreTerm(3);

    expect(openChanges()).toEqual([
      { tool: "skip_term", arguments: { term_index: 3 } },
      { tool: "restore_term", arguments: { term_index: 3 } },
    ]);
    expect(usePlanner.getState().candidateView!.plan.terms.some((t) => t.gap), "the un-skip did not take")
      .toBe(false);
    expect(degree(usePlanner.getState().plan!)).toBe(before);
    expect(degree(storedPlan())).toBe(before);
  });

  it("records an optimize as a change, and leaves the plan's own schedule alone", async () => {
    seed([]);
    await plusButton();
    const before = degree(usePlanner.getState().plan!);

    const said = await usePlanner.getState().optimizeNow();

    expect(openChanges()).toEqual([{ tool: "optimize_schedule", arguments: {} }]);
    expect(said, "the student is not told which plan the optimize went to").toMatch(/What-if 1/);
    expect(degree(usePlanner.getState().plan!), "optimizing inside a what-if repacked the real plan")
      .toBe(before);
    expect(degree(storedPlan())).toBe(before);
  });

  it("records an added course as a change, and adds it to no plan", async () => {
    seed([]);
    await plusButton();
    const before = degree(usePlanner.getState().plan!);
    const code = "CHEM 112";
    expect(
      usePlanner.getState().items.some((i) => i.code === code),
      "the course is already on the plan, so this proves nothing",
    ).toBe(false);

    const said = await usePlanner.getState().addCourseAt(code, 1);

    expect(openChanges()).toEqual([
      { tool: "add_course", arguments: { code, term_index: 1 } },
    ]);
    expect(said).toMatch(/What-if 1/);
    expect(
      usePlanner.getState().candidateView!.items.some((i) => i.code === code),
      "the what-if does not show the course it recorded",
    ).toBe(true);
    expect(degree(usePlanner.getState().plan!), "a course added inside a what-if landed on the real plan")
      .toBe(before);
    expect(degree(storedPlan())).toBe(before);
  });

  it("keeps one impossible edit out of the list rather than bricking the tab", async () => {
    // A change that cannot be made is not appended, so the what-if still
    // draws and the student can try something else. A list with a
    // refusal in it would be a tab that opens on an error from then on,
    // with their work behind it.
    seed([]);
    await plusButton();
    await usePlanner.getState().deleteTerm(3);

    const said = await usePlanner.getState().addCourseAt("NOPE 999", 0);

    expect(said, "the connector's own words about the refusal are not shown").toMatch(/NOPE 999/);
    expect(openChanges(), "the impossible change was written into the what-if").toHaveLength(1);
    expect(usePlanner.getState().candidateView, "the tab stopped drawing").toBeTruthy();
    expect(usePlanner.getState().candidateRefusal).toBeNull();
  });
});

describe("what a what-if cannot hold", () => {
  /* THE BACKSTOP. An edit that is not routed must be refused, never
     applied to the plan the student is comparing against — so a mutation
     added later and forgotten here fails loudly rather than silently
     writing the degree. */

  it("refuses a plain plan edit and says which plan is open", async () => {
    seed([]);
    await plusButton();
    const before = degree(usePlanner.getState().plan!);

    const wrote = usePlanner.getState().mutatePlan((p) => { p.completed["PHYS 211"] = true; });

    expect(wrote, "an unrouted edit reported success").toBe(false);
    expect(degree(usePlanner.getState().plan!), "an unrouted edit wrote the student's real plan")
      .toBe(before);
    expect(degree(storedPlan())).toBe(before);
    expect(usePlanner.getState().repairNote, "nothing was said about it").toMatch(/What-if 1/);
  });

  for (const [what, run] of [
    ["marking a course complete", () => usePlanner.getState().markCompleted("PHYS 211", true)],
    ["a bulk completion", () => usePlanner.getState().bulkComplete(["PHYS 211"])],
    ["removing an item", () => usePlanner.getState().removeItem("CHEM 110")],
    ["restoring an item", () => usePlanner.getState().restoreItem("CHEM 110")],
    ["swapping an alternative", () => usePlanner.getState().swapAlternative("CMPSC 121", "CMPSC 131")],
    ["adding a summer", () => usePlanner.getState().addSummerSession(2028)],
    ["declaring a program", () => usePlanner.getState().addProgramNow("physics-bs")],
    ["dropping a program", () => usePlanner.getState().removeProgramNow(ESC)],
    ["attaching a master's", () => usePlanner.getState().attachIugNow("anything")],
    ["detaching a master's", () => usePlanner.getState().detachIugNow()],
    ["an import", () => usePlanner.getState().applyImport(["PHYS 211"], [])],
  ] as const) {
    it(`leaves the real plan alone when ${what} is tried inside one`, async () => {
      seed([]);
      await plusButton();
      const before = degree(usePlanner.getState().plan!);

      await run();

      expect(degree(usePlanner.getState().plan!), `${what} inside a what-if edited the real plan`)
        .toBe(before);
      expect(degree(storedPlan()), `${what} inside a what-if wrote the stored plan`).toBe(before);
      expect(openChanges(), `${what} was recorded as a change it cannot be`).toEqual([]);
    });
  }
});

describe("deleting a what-if", () => {
  it("leaves the plan itself exactly as it was", async () => {
    // Tidying the rail must never be a risk to the degree. Asserted on
    // the STORED document, because that is the copy the student's other
    // devices will read.
    const plan = seed([candidate(), candidate({ id: "c2", name: "abroad junior spring" })]);
    usePlanner.getState().mutatePlan((p) => { p.completed["CHEM 110"] = true; });
    const before = storedPlan();

    usePlanner.getState().deleteCandidate("c1");
    const after = storedPlan();

    expect(after.candidates?.map((c) => c.id), "the wrong what-if went, or none did").toEqual(["c2"]);
    expect(after.terms, "deleting a what-if rescheduled the plan").toEqual(before.terms);
    expect(after.completed, "deleting a what-if lost a completed course").toEqual(before.completed);
    expect(after.slotFills).toEqual(before.slotFills);
    expect(after.programs).toEqual(plan.programs);
  });

  it("closes the tab when the one being deleted is the one on screen", async () => {
    seed([candidate()]);
    await usePlanner.getState().showCandidate("c1");
    expect(usePlanner.getState().candidateView, "nothing was open to begin with").toBeTruthy();

    usePlanner.getState().deleteCandidate("c1");
    expect(usePlanner.getState().candidateId, "the chart is still showing a what-if that is gone").toBeNull();
    expect(usePlanner.getState().candidateView).toBeNull();
  });
});
