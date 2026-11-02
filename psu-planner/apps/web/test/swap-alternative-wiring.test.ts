/** The planner carries the same things across a swap as the connector (#54).
 *
 * Thin on purpose, like `program-merge-wiring.test.ts`. What follows a
 * swap is an engine property and is tested there against each field in
 * turn. What is NOT covered there, and is the whole point of the ticket,
 * is that the WEBSITE does it too: before this, the planner carried the
 * manual move and nothing else, so a student who set "not that term" in
 * the browser and then swapped the course lost the preference silently
 * while the same two actions through the connector kept it. One student
 * action, two outcomes depending on which surface they used.
 *
 * So this drives the real store with the catalog read off disk, and
 * checks the constraint still applies to whatever is now in the slot.
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

// The same files the deployed app fetches, not a hand-written fixture: a
// swap that works against invented alternatives proves nothing about the
// bulletin's own.
vi.mock("../src/data/catalogClient", async () => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { buildCatalog: build } = await import("@psu-planner/engine");
  const root = nodePath.resolve(process.cwd(), "public", "catalog");
  const latest = (JSON.parse(nodeFs.readFileSync(nodePath.join(root, "editions.json"), "utf-8")) as { latest: string }).latest;
  const base = nodePath.join(root, latest);
  const readFile = (rel: string) => JSON.parse(nodeFs.readFileSync(nodePath.join(base, rel), "utf-8"));
  const subjectIndex = readFile("subjects_index.json") as Record<string, string>;
  return {
    loadEditions: async () => readFile("editions.json"),
    setCatalogEdition: () => {},
    currentEdition: () => latest,
    loadProgramsIndex: async () => readFile("programs_index.json"),
    loadProgramBySlug: async () => null,
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

function escTemplate(): ProgramTemplate {
  const p = read(`programs/majors/${ESC}.json`);
  const up = p.suggestedPlans.find((s: { campusLabel: string }) => /University Park/i.test(s.campusLabel)) ?? p.suggestedPlans[0];
  return { slug: p.slug, name: p.name, campusLabel: "", semesters: up.semesters, requirements: p.requirementSections };
}

const codesIn = (plan: PlanDoc) => plan.terms.flatMap((t) => t.items.flatMap((i) => ("code" in i ? [i.code] : [])));

/** A real Course in a real Program that really does offer a choice.
 *
 * Discovered rather than named, because which requirement reads "X or Y"
 * is the bulletin's business and changes between editions. The caller
 * asserts one was found, so an edition that offered no choice anywhere
 * fails loudly instead of passing vacuously. */
function seedWithAlternative(): { code: string; alt: string; term: number } | null {
  const plan = generatePlan([escTemplate()], { startTerm: { term: "Fall", year: 2026 }, completedCourses: [] }, "swap-wiring");
  let found: { code: string; alt: string; term: number } | null = null;
  plan.terms.forEach((t, ti) => {
    for (const it of t.items) {
      if (found) return;
      if ("code" in it && it.alternatives?.length) found = { code: it.code, alt: it.alternatives[0], term: ti };
    }
  });
  if (!found) return null;

  let courses: Course[] = [];
  for (const pf of new Set(codesIn(plan).concat([found.alt]).map((c) => c.split(" ")[0]))) {
    if (subjects[pf]) courses = courses.concat(read(subjects[pf]));
  }
  usePlanner.setState({ plan, catalog: buildCatalog(courses), coverage: {}, items: [], sched: {} });
  return found;
}

describe("swapping a course for its alternative in the browser", () => {
  beforeEach(() => {
    usePlanner.setState({ plan: null, catalog: {}, items: [], sched: {} });
  });

  it("carries the student's scheduling constraint onto the new course", async () => {
    // THE DIVERGENCE. The connector carried the constraint; the planner
    // dropped it. The optimiser then had nothing stopping it putting the
    // replacement in the very term the student ruled out.
    const picked = seedWithAlternative();
    expect(picked, `no course in ${ESC} offers an alternative in the ${LATEST} edition, so this test cannot detect the bug`).toBeTruthy();
    const { code, alt, term } = picked!;

    usePlanner.setState({
      plan: { ...usePlanner.getState().plan!, constraints: [{ code, type: "not-in", termIndex: term }] },
    });

    await usePlanner.getState().swapAlternative(code, alt);
    const after = usePlanner.getState().plan!;

    expect(codesIn(after), `${alt} is not in the plan, so the swap itself did not happen`).toContain(alt);
    expect(
      (after.constraints ?? []).map((c) => `${c.code} ${c.type} ${c.termIndex}`),
      "the constraint still names the course that left the plan, so it applies to nothing",
    ).toEqual([`${alt} not-in ${term}`]);
  });

  it("carries a completion the student had recorded", async () => {
    const picked = seedWithAlternative();
    expect(picked, "no alternative to swap").toBeTruthy();
    const { code, alt } = picked!;

    usePlanner.setState({ plan: { ...usePlanner.getState().plan!, completed: { [code]: true } } });
    await usePlanner.getState().swapAlternative(code, alt);
    const after = usePlanner.getState().plan!;

    expect(after.completed[alt], "the student lost credit for a requirement they had already satisfied").toBe(true);
    expect(after.completed[code], "a course no longer in the plan is still marked complete").toBeUndefined();
  });

  it("still carries the manual move it always did", async () => {
    // Asserted so the shared implementation cannot quietly lose the one
    // thing the planner already got right.
    const picked = seedWithAlternative();
    expect(picked, "no alternative to swap").toBeTruthy();
    const { code, alt } = picked!;

    usePlanner.setState({ plan: { ...usePlanner.getState().plan!, moves: { [code]: 5 } } });
    await usePlanner.getState().swapAlternative(code, alt);

    const after = usePlanner.getState().plan!;
    expect(after.moves[alt], "the swap orphaned the manual move, so the course snapped back to its template term").toBe(5);
    expect(after.moves[code], "the outgoing code's move override was left behind").toBeUndefined();
  });
});
