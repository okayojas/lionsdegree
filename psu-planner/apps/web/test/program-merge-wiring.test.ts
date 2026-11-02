/** The planner actually uses the engine's Program merge.
 *
 * Thin on purpose. The merge itself is an engine property and is tested there,
 * against a Plan carrying completed Courses, student additions, filled Slots
 * and Constraints — observing it through this layer as well would be observing
 * it through transport. What is NOT covered there, and is the whole reason the
 * connector tool is blocked on this ticket, is that the WEBSITE can do it: a
 * change an assistant can make and a student cannot is a worse product than a
 * missing feature.
 *
 * So this drives the real store, with the catalog read off disk instead of over
 * HTTP, and checks that the student's own work is still there afterwards —
 * including through the re-optimize the store runs, which the engine test
 * deliberately does not include.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, generatePlan, type Course, type PlanDoc, type ProgramTemplate } from "@psu-planner/engine";

const CATALOG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "catalog");
const LATEST = (JSON.parse(fs.readFileSync(path.join(CATALOG_ROOT, "editions.json"), "utf-8")) as { latest: string }).latest;
const dir = path.join(CATALOG_ROOT, LATEST);
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf-8"));
const subjects = read("subjects_index.json") as Record<string, string>;

// `persist` writes to localStorage on every plan change, and node has none.
// Without this the store throws "localStorage is not defined", which looks
// nothing like the bug this file is for.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
};

vi.mock("../src/data/sync", () => ({
  schedulePush: () => {},
  flushPush: async () => {},
  syncConfigured: false,
}));

// The catalog, read off disk instead of over HTTP. A stub must not be more
// permissive than the real dependency, so this serves the SAME files the
// deployed app fetches rather than a hand-written fixture: a merge that works
// against invented programs proves nothing about the bulletin's own.
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
    loadEditions: async () => readFile("editions.json"),
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

const { usePlanner } = await import("../src/store");

const ESC = "engineering-engineering-science-bs";
const IST_MINOR = "eberly-science-information-sciences-technology-mathematics-minor";

function escTemplate(): ProgramTemplate {
  const p = read(`programs/majors/${ESC}.json`);
  const up = p.suggestedPlans.find((s: { campusLabel: string }) => /University Park/i.test(s.campusLabel)) ?? p.suggestedPlans[0];
  return { slug: p.slug, name: p.name, campusLabel: "", semesters: up.semesters, requirements: p.requirementSections };
}

const codesIn = (plan: PlanDoc) => plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));

function seedPlan(): { plan: PlanDoc; filledSlotId: string } {
  const plan = generatePlan([escTemplate()], {
    startTerm: { term: "Fall", year: 2026 },
    completedCourses: ["MATH 140", "CHEM 110"],
  }, "wiring");
  plan.rev = 9;
  plan.edition = "2025-2026";
  plan.added.push({ code: "CMPSC 131", sem: 1 });
  plan.constraints = [{ code: "PHYS 212", type: "not-in", termIndex: 2 }];
  const slot = plan.terms.flatMap((t) => t.items).find((i) => "slot" in i)!;
  const filledSlotId = (slot as { id: string }).id;
  plan.slotFills[filledSlotId] = "STAT 200";
  let courses: Course[] = [];
  for (const pf of new Set(codesIn(plan).concat(["CMPSC 131", "STAT 200", "IST 110"]).map((c) => c.split(" ")[0]))) {
    if (subjects[pf]) courses = courses.concat(read(subjects[pf]));
  }
  usePlanner.setState({ plan, catalog: buildCatalog(courses), coverage: {}, items: [], sched: {} });
  return { plan, filledSlotId };
}

describe("the planner can declare a Program on a Plan that already exists", () => {
  beforeEach(() => {
    usePlanner.setState({ plan: null, catalog: {}, items: [], sched: {} });
  });

  it("adds the Program without starting over", async () => {
    const { filledSlotId } = seedPlan();
    const note = await usePlanner.getState().addProgramNow(IST_MINOR);
    const after = usePlanner.getState().plan!;

    expect(after.programs, "the planner did not add the minor to the plan").toContain(IST_MINOR);
    expect(after.programs, "the major the student already had was dropped").toContain(ESC);
    expect(codesIn(after), "the minor's prescribed course never reached the plan").toContain("IST 110");
    expect(note, "the student is told nothing about what changed").toBeTruthy();

    // Everything "Start over" used to destroy, checked through the store's own
    // path — which also re-optimizes, so this covers the re-flow too.
    expect(after.completed["MATH 140"], "a completed course was reset by adding a minor").toBe(true);
    expect(after.completed["CHEM 110"], "a completed course was reset by adding a minor").toBe(true);
    expect(codesIn(after), "the course the student added themselves is gone").toContain("CMPSC 131");
    expect(after.slotFills[filledSlotId], "the slot the student filled lost its course").toBe("STAT 200");
    expect(after.constraints, "a rule the student set was lost").toEqual([
      { code: "PHYS 212", type: "not-in", termIndex: 2 },
    ]);
    expect(after.edition, "the plan was re-based onto another bulletin edition").toBe("2025-2026");
    expect(after.rev, "the revision did not advance by exactly one edit").toBe(10);
    expect(usePlanner.getState().items.length, "the chart was not rebuilt after the merge").toBeGreaterThan(0);
  });

  it("refuses a second add rather than duplicating the Program", async () => {
    seedPlan();
    await usePlanner.getState().addProgramNow(IST_MINOR);
    const rev = usePlanner.getState().plan!.rev;
    const note = await usePlanner.getState().addProgramNow(IST_MINOR);
    expect(note, "a repeat add was not recognised").toMatch(/already/i);
    expect(usePlanner.getState().plan!.rev, "a no-op add still advanced the revision").toBe(rev);
  });

  it("shows what dropping a Program would do before doing it", async () => {
    seedPlan();
    await usePlanner.getState().addProgramNow(IST_MINOR);
    const snapshot = structuredClone(usePlanner.getState().plan!);

    const preview = await usePlanner.getState().previewDropProgram(IST_MINOR);
    expect(preview, "the planner cannot preview a withdrawal at all").toBeTruthy();
    expect(preview!.refusal, "a legitimate withdrawal was refused").toBeNull();
    expect(preview!.remainingChecked, "the preview did not check the major being kept").toContain(ESC);
    expect(preview!.coursesRemoved, "the preview does not name what it would remove").toContain("IST 110");
    expect(usePlanner.getState().plan, "previewing changed the stored plan").toEqual(snapshot);
  });

  it("drops the Program and the Courses nothing else requires", async () => {
    seedPlan();
    await usePlanner.getState().addProgramNow(IST_MINOR);
    const note = await usePlanner.getState().removeProgramNow(IST_MINOR);
    const after = usePlanner.getState().plan!;

    expect(note, "the student is told nothing about the withdrawal").toBeTruthy();
    expect(after.programs, "the minor is still on the plan").not.toContain(IST_MINOR);
    expect(codesIn(after), "a course only the dropped minor needed was stranded").not.toContain("IST 110");
    expect(after.completed["MATH 140"], "dropping a program un-completed a course").toBe(true);
    expect(after.edition, "the plan was re-based onto another bulletin edition").toBe("2025-2026");
  });

  it("refuses to leave the Plan with no Program", async () => {
    seedPlan();
    const before = structuredClone(usePlanner.getState().plan!);
    const note = await usePlanner.getState().removeProgramNow(ESC);
    expect(note, "dropping the only program was allowed").toMatch(/only program/i);
    expect(usePlanner.getState().plan, "a refused withdrawal still changed the plan").toEqual(before);
  });
});
