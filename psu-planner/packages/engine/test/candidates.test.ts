/** A what-if is an independent copy of the Plan's contents (#69).
 *
 * These are the promises the whole feature rests on, held where no browser
 * and no store is involved: a copy shares nothing with what it was copied
 * from; an edit in view lands in the what-if and nowhere else; and keeping
 * a what-if swaps it with the Plan, so that nothing is lost.
 */
import { describe, it, expect } from "vitest";
import {
  CANDIDATE_NAME_MAX,
  candidatesOf,
  contentsOf,
  foldView,
  isLegacyCandidate,
  keepCandidate,
  makeCandidate,
  nameForReplacedPlan,
  nameThatFits,
  viewOf,
  type LegacyCandidate,
  type PlanDoc,
} from "../src/index.js";

const NOW = "2026-11-16T12:00:00.000Z";

/** A small Plan with something in every kind of field a copy has to carry. */
const plan = (): PlanDoc => ({
  id: "p1",
  rev: 7,
  updatedAt: "2026-11-01T00:00:00.000Z",
  edition: "2026-2027",
  programs: ["computer-science-bs"],
  terms: [
    { label: "Fall 2026", items: [{ code: "CMPSC 131" }, { code: "MATH 140" }] },
    { label: "Spring 2027", items: [{ code: "CMPSC 132" }] },
  ],
  completed: { "MATH 140": true },
  moves: { "CMPSC 132": 1 },
  slotFills: {},
  added: [{ code: "ART 20", sem: 1 }],
  removed: { "ENGL 15": true },
  summerYears: [2027],
  view: { x: 1, y: 2, k: 1 },
});

const withWhatIf = (): PlanDoc => {
  const doc = plan();
  doc.candidates = [makeCandidate("c1", "Abroad", doc, NOW)];
  return doc;
};

describe("a what-if is a copy", () => {
  it("of everything the Plan holds, and of nothing that says which Plan it is", () => {
    const doc = plan();
    const contents = contentsOf(doc);
    expect(contents).not.toHaveProperty("id");
    expect(contents).not.toHaveProperty("rev");
    expect(contents).not.toHaveProperty("updatedAt");
    expect(contents).not.toHaveProperty("candidates");
    const { id: _i, rev: _r, updatedAt: _u, ...rest } = doc;
    expect(contents).toEqual(rest);
  });

  it("that shares nothing with the Plan it was made from", () => {
    const doc = plan();
    const whatIf = makeCandidate("c1", "Abroad", doc, NOW);
    // Change the Plan every way a Plan changes. The copy is what it was.
    const before = structuredClone(whatIf.plan);
    doc.terms[0]!.items.push({ code: "PHYS 211" });
    doc.programs.push("mathematics-minor");
    doc.completed["CMPSC 131"] = true;
    doc.added.length = 0;
    doc.summerYears!.push(2028);
    expect(whatIf.plan).toEqual(before);
    // And the other way.
    const untouched = structuredClone(doc);
    whatIf.plan.terms[1]!.items.length = 0;
    whatIf.plan.programs.length = 0;
    expect(doc).toEqual(untouched);
  });

  it("does not carry the what-ifs beside the Plan inside itself", () => {
    // A copy of a Plan that holds three what-ifs is not four Plans deep.
    const doc = withWhatIf();
    const second = makeCandidate("c2", "Second", doc, NOW);
    expect(second.plan).not.toHaveProperty("candidates");
  });
});

describe("the document in view", () => {
  it("is the what-if's contents under the Plan's identity and Revision", () => {
    const doc = withWhatIf();
    candidatesOf(doc)[0]!.plan.programs = ["data-sciences-bs"];
    const view = viewOf(doc, "c1")!;
    expect(view.id).toBe("p1");
    expect(view.rev).toBe(7);
    expect(view.programs).toEqual(["data-sciences-bs"]);
    // The tabs are still there to be listed while one of them is open.
    expect(view.candidates!.map((c) => c.name)).toEqual(["Abroad"]);
  });

  it("is nothing where there is no such what-if", () => {
    expect(viewOf(withWhatIf(), "nope")).toBeNull();
    expect(viewOf(plan(), "c1")).toBeNull();
  });

  it("when edited, changes the what-if and leaves the Plan exactly as it was", () => {
    const doc = withWhatIf();
    const home = contentsOf(doc);
    const view = viewOf(doc, "c1")!;
    // Everything a what-if could not hold before: a Program, a summer.
    view.programs = ["data-sciences-bs"];
    view.summerYears = [2027, 2028];
    view.terms.push({ label: "Fall 2027", items: [{ code: "STAT 200" }] });
    view.rev += 1;
    const stored = foldView(view, "c1", home);
    expect(contentsOf(stored)).toEqual(home);
    expect(stored.rev).toBe(8);
    expect(candidatesOf(stored)[0]!.plan.programs).toEqual(["data-sciences-bs"]);
    expect(candidatesOf(stored)[0]!.plan.summerYears).toEqual([2027, 2028]);
    expect(candidatesOf(stored)[0]!.plan.terms).toHaveLength(3);
  });

  it("when edited, leaves every other what-if alone", () => {
    const doc = withWhatIf();
    doc.candidates!.push(makeCandidate("c2", "Seven terms", doc, NOW));
    const other = structuredClone(doc.candidates![1]);
    const view = viewOf(doc, "c1")!;
    view.terms.length = 1;
    const stored = foldView(view, "c1", contentsOf(doc));
    expect(stored.candidates![1]).toEqual(other);
  });

  it("goes round without changing anything: view, fold, the same document", () => {
    const doc = withWhatIf();
    expect(foldView(viewOf(doc, "c1")!, "c1", contentsOf(doc))).toEqual(doc);
  });

  it("keeps a rename or a deletion made while a what-if was open", () => {
    const doc = withWhatIf();
    doc.candidates!.push(makeCandidate("c2", "Seven terms", doc, NOW));
    const view = viewOf(doc, "c1")!;
    view.candidates = view.candidates!.filter((c) => c.id !== "c2");
    view.candidates[0]!.name = "Abroad, junior spring";
    const stored = foldView(view, "c1", contentsOf(doc));
    expect(stored.candidates!.map((c) => c.name)).toEqual(["Abroad, junior spring"]);
  });
});

describe("keeping a what-if", () => {
  const edited = (): PlanDoc => {
    const doc = withWhatIf();
    candidatesOf(doc)[0]!.plan.programs = ["data-sciences-bs"];
    candidatesOf(doc)[0]!.plan.terms.length = 1;
    return doc;
  };

  it("makes it the Plan, and the Plan it replaces a what-if", () => {
    const doc = edited();
    const was = contentsOf(doc);
    const kept = keepCandidate(doc, "c1", "c9", NOW)!;
    expect(kept.programs).toEqual(["data-sciences-bs"]);
    expect(kept.terms).toHaveLength(1);
    // NOTHING IS LOST: what was the Plan is a tab, whole.
    expect(kept.candidates).toHaveLength(1);
    expect(kept.candidates![0]!.id).toBe("c9");
    expect(kept.candidates![0]!.name).toBe("My plan before Abroad");
    expect(candidatesOf(kept)[0]!.plan).toEqual(was);
  });

  it("can be undone by keeping what it replaced", () => {
    const doc = edited();
    const back = keepCandidate(keepCandidate(doc, "c1", "c9", NOW)!, "c9", "c10", NOW)!;
    expect(contentsOf(back)).toEqual(contentsOf(doc));
  });

  it("never changes how many what-ifs there are, so it never meets the limit", () => {
    const doc = edited();
    for (const id of ["c2", "c3", "c4"]) doc.candidates!.push(makeCandidate(id, id, doc, NOW));
    const kept = keepCandidate(doc, "c1", "c9", NOW)!;
    expect(kept.candidates).toHaveLength(4);
    // In the kept one's place, so the tabs do not move.
    expect(kept.candidates!.map((c) => c.id)).toEqual(["c9", "c2", "c3", "c4"]);
  });

  it("is the same Plan to the sync: its identity, and the Revision left for the writer to advance", () => {
    const kept = keepCandidate(edited(), "c1", "c9", NOW)!;
    expect([kept.id, kept.rev]).toEqual(["p1", 7]);
  });

  it("is nothing where there is no such what-if", () => {
    expect(keepCandidate(plan(), "c1", "c9", NOW)).toBeNull();
  });
});

describe("what the replaced Plan is called", () => {
  it("fits in a name, and is not a name already taken", () => {
    expect(nameForReplacedPlan("Abroad", [])).toBe("My plan before Abroad");
    expect(nameForReplacedPlan("Abroad", ["my plan before abroad"])).toBe("My plan before Abroad (2)");
    // Cut at a word, like every name here: never "My plan before Mechanical Engin".
    expect(nameForReplacedPlan("Mechanical Engineering, B.S.", [])).toBe("My plan before Mechanical Engineering,".replace(/,$/, ""));
    const long = nameForReplacedPlan("x".repeat(CANDIDATE_NAME_MAX), []);
    expect(long.length).toBeLessThanOrEqual(CANDIDATE_NAME_MAX);
    const again = nameForReplacedPlan("x".repeat(CANDIDATE_NAME_MAX), [long]);
    expect(again.length).toBeLessThanOrEqual(CANDIDATE_NAME_MAX);
    expect(again).not.toBe(long);
  });
});

describe("a name cut to fit a tab", () => {
  it("is left alone where it fits", () => {
    expect(nameThatFits("Mathematics, Minor (Science)")).toBe("Mathematics, Minor (Science)");
  });

  it("loses a trailing note in brackets first, then whole words, and never ends mid-word", () => {
    expect(nameThatFits("Mechanical Engineering, B.S. (Engineering)")).toBe("Mechanical Engineering, B.S.");
    const long = nameThatFits("Recreation, Park, and Tourism Management, B.S. (Health and Human Development)");
    expect(long).toBe("Recreation, Park, and Tourism");
    expect(long.length).toBeLessThanOrEqual(CANDIDATE_NAME_MAX);
    // One word longer than a tab is cut, because there is nothing else to do.
    expect(nameThatFits("x".repeat(50))).toHaveLength(CANDIDATE_NAME_MAX);
  });
});

describe("a what-if stored the old way", () => {
  const legacy: LegacyCandidate = {
    id: "old",
    name: "Skip a term",
    changes: [{ tool: "skip_term", arguments: { term_index: 3 } }],
    basedOnRev: 4,
    createdAt: NOW,
  };

  it("is told apart from a copy", () => {
    expect(isLegacyCandidate(legacy)).toBe(true);
    expect(isLegacyCandidate(makeCandidate("c1", "Abroad", plan(), NOW))).toBe(false);
  });

  it("survives the keeping of another what-if: it is not shown yet, and it is still the student's", () => {
    // It is waiting to be converted (the catalog did not load). Keeping a
    // different what-if must not be what deletes it.
    const doc = plan();
    doc.candidates = [legacy, makeCandidate("c1", "Abroad", doc, NOW)];
    const kept = keepCandidate(doc, "c1", "c9", NOW)!;
    expect(kept.candidates!.map((c) => c.id)).toEqual(["old", "c9"]);
    expect(kept.candidates![0]).toEqual(legacy);
    // And an edit made with a what-if open leaves it alone too.
    const view = viewOf(doc, "c1")!;
    view.terms.length = 1;
    expect(foldView(view, "c1", contentsOf(doc)).candidates![0]).toEqual(legacy);
  });

  it("is told apart by the version a copy carries, not by which fields happen to be there", () => {
    const copy = makeCandidate("c1", "Abroad", plan(), NOW);
    expect(copy.v).toBe(2);
    // Something with a `plan` and no version is not a copy this code wrote.
    const { v: _v, ...unversioned } = copy;
    expect(isLegacyCandidate(unversioned as never)).toBe(true);
  });

  it("is not drawn or listed as a copy until it has been converted", () => {
    const doc = plan();
    doc.candidates = [legacy as never];
    expect(candidatesOf(doc)).toEqual([]);
    expect(viewOf(doc, "old")).toBeNull();
    expect(keepCandidate(doc, "old", "c9", NOW)).toBeNull();
  });
});
