/** The Plan file: the artifact a student owns.
 *
 * It is the boundary between the web app and anything else that works on the
 * same degree, so its shape is a contract rather than an implementation
 * detail. Everything here is about refusing to half-apply something: a plan
 * read against the wrong bulletin Edition, or a file that is almost right, is
 * worse than a plain refusal. */
import { describe, it, expect } from "vitest";
import {
  PLAN_FILE_FORMAT,
  exportPlanFile,
  parsePlanFile,
  type PlanDoc,
} from "../src/index.js";

const plan: PlanDoc = {
  id: "plan-1",
  rev: 4,
  updatedAt: "2026-10-07T00:00:00.000Z",
  edition: "2025-2026",
  programs: ["engineering-engineering-science-bs"],
  terms: [{ label: "Fall 2026", items: [{ code: "MATH 140" }] }],
  completed: { "MATH 110": true },
  moves: {},
  slotFills: {},
  added: [],
  view: null,
};
const EDITIONS = ["2025-2026", "2026-2027"];
const roundTrip = () => parsePlanFile(exportPlanFile(plan), EDITIONS);

describe("exporting", () => {
  it("writes a file that identifies itself", () => {
    const doc = JSON.parse(exportPlanFile(plan));
    // Anything reading this -- the MCP server, a future importer -- needs to
    // know what it is holding before it trusts the contents.
    expect(doc.format).toBe(PLAN_FILE_FORMAT);
    expect(doc.formatVersion).toBe(1);
    expect(doc.plan.id).toBe("plan-1");
  });

  it("carries nothing beyond the Plan", () => {
    const doc = JSON.parse(exportPlanFile(plan));
    expect(Object.keys(doc).sort()).toEqual(["format", "formatVersion", "plan"]);
    // No timestamp, no device, no identifiers. A plan is coursework; the file
    // should not quietly become a record of when or where a student worked.
    expect(JSON.stringify(doc)).not.toMatch(/userAgent|deviceId|exportedAt/);
  });

  it("survives a round trip unchanged", () => {
    const result = roundTrip();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan).toEqual(plan);
  });
});

describe("importing a plan from an Edition we do not publish", () => {
  it("is refused, naming the Edition", () => {
    const foreign = exportPlanFile({ ...plan, edition: "2019-2020" });
    const result = parsePlanFile(foreign, EDITIONS);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/2019-2020/);
    // Silently reading it against a different Edition would re-plan the
    // student's degree against requirements that do not govern them.
    expect(result.reason).toMatch(/2025-2026|2026-2027/);
  });

  it("is accepted when the Edition is one we have", () => {
    expect(parsePlanFile(exportPlanFile({ ...plan, edition: "2026-2027" }), EDITIONS).ok).toBe(true);
  });

  it("is accepted when the Plan predates Editions, and is pinned to the oldest", () => {
    const { edition: _drop, ...noEdition } = plan;
    const result = parsePlanFile(exportPlanFile(noEdition as PlanDoc), EDITIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // That is the Edition it was in fact generated against.
    expect(result.plan.edition).toBe("2025-2026");
  });
});

describe("importing something malformed", () => {
  const rejected = (text: string) => {
    const r = parsePlanFile(text, EDITIONS);
    expect(r.ok, `expected a refusal for: ${text.slice(0, 40)}`).toBe(false);
    return r.ok ? "" : r.reason;
  };

  it("refuses text that is not JSON", () => {
    expect(rejected("not a plan")).toMatch(/not a LionsDegree plan file|could not be read/i);
  });

  it("refuses JSON that is not a plan file", () => {
    expect(rejected(JSON.stringify({ hello: "world" }))).toMatch(/not a LionsDegree plan file/i);
  });

  it("refuses a format version it does not understand", () => {
    const doc = JSON.parse(exportPlanFile(plan));
    doc.formatVersion = 99;
    // Guessing at a newer format is how a plan gets half-applied.
    expect(rejected(JSON.stringify(doc))).toMatch(/newer version/i);
  });

  it("refuses a plan missing the parts a plan must have", () => {
    for (const drop of ["id", "terms", "programs"] as const) {
      const doc = JSON.parse(exportPlanFile(plan));
      delete doc.plan[drop];
      expect(rejected(JSON.stringify(doc))).toMatch(new RegExp(drop));
    }
  });

  it("refuses a plan whose terms are not terms", () => {
    const doc = JSON.parse(exportPlanFile(plan));
    doc.plan.terms = [{ label: 42 }];
    expect(rejected(JSON.stringify(doc))).toMatch(/term/i);
  });

  it("explains itself without mentioning internals", () => {
    // The message is read by a student, not by whoever wrote the parser.
    const reason = rejected("{");
    expect(reason).not.toMatch(/undefined|JSON\.parse|SyntaxError|at position/);
  });
});

describe("the refusals leave nothing behind", () => {
  it("never returns a partial plan alongside a failure", () => {
    const doc = JSON.parse(exportPlanFile(plan));
    delete doc.plan.terms;
    const result = parsePlanFile(JSON.stringify(doc), EDITIONS);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("plan");
  });
});

describe("a hand-edited file that omits an optional map", () => {
  it("opens, with the map defaulted rather than left undefined", () => {
    // A student may well open this file and edit it. Spreading defaults in the
    // wrong order sets the key to undefined instead of leaving the default
    // standing, which surfaces as a crash much later.
    const doc = JSON.parse(exportPlanFile(plan));
    for (const k of ["completed", "moves", "slotFills", "added"]) delete doc.plan[k];
    const result = parsePlanFile(JSON.stringify(doc), EDITIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan.completed).toEqual({});
    expect(result.plan.added).toEqual([]);
  });
});
