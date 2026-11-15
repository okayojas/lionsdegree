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

  it("follows the real plan when the student edits it", async () => {
    // A tab left showing the comparison the student had an hour ago is
    // the stale-into-a-lie case the stored-changes design rules out.
    seed([candidate()]);
    await usePlanner.getState().showCandidate("c1");
    expect(
      usePlanner.getState().candidateView!.plan.completed["PHYS 211"],
      "the course was already recorded, so this proves nothing",
    ).toBeUndefined();

    usePlanner.getState().mutatePlan((p) => { p.completed["PHYS 211"] = true; });
    // The recompute is kicked off from `mutatePlan`; wait for it to land.
    await vi.waitFor(() => {
      expect(
        usePlanner.getState().candidateView!.plan.completed["PHYS 211"],
        "the tab is still showing the comparison from before the edit",
      ).toBe(true);
    });
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
