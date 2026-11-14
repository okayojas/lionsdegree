/** A preview comes back with a picture of itself.
 *
 * THE GAP. `simulate_changes` answered a question about a COMBINATION —
 * "out in seven terms, I've got AP calc, and abroad junior spring" — in
 * prose: a list of courses that moved and a count of terms. The shape is
 * the answer, though. Which term got heavy, what ended up next to what,
 * whether the last year emptied out. Reading five move-sentences and
 * assembling the shape mentally is the work the student asked for help
 * with.
 *
 * `plan_diagram` could draw a candidate, but only for ONE change: its
 * `change`/`arguments` pair is singular. So the preview that most needed
 * a picture — several changes interacting, where the optimiser re-flows
 * the whole plan each time — was exactly the one that could not have
 * one.
 *
 * WHY THE SIMULATION DRAWS ITSELF rather than the model making a second
 * call. A separate `plan_diagram` re-runs the changes against whatever
 * the plan is by then. Two futures, presented as one, with nothing
 * saying they might differ. This draws the same sandbox the report
 * describes, in the same call.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanDoc } from "@psu-planner/engine";
import { executeTool, loadContext, type ToolContext } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "plan.json"), "utf-8"));

let planPath: string;
let ctx: ToolContext;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-simdiag-"));
  planPath = path.join(dir, "plan.json");
  fs.writeFileSync(planPath, JSON.stringify(JSON.parse(JSON.stringify(FIXTURE))));
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
});

const call = (name: string, args: Record<string, unknown> = {}) =>
  executeTool(name, { based_on_revision: ctx.rev, ...args }, ctx);

interface Preview {
  possible?: boolean;
  applied?: boolean;
  diagram?: string;
  diagram_format?: string;
  how_to_show_this?: string;
  what_the_colours_mean?: string;
  what_an_edge_means?: string;
  revision?: unknown;
  ok?: unknown;
  error?: string;
  reason?: string;
}

const onDisk = (): PlanDoc => JSON.parse(fs.readFileSync(planPath, "utf-8")).plan;

describe("previewing several changes at once", () => {
  it("comes back with the candidate drawn", async () => {
    // THE HEADLINE, and the case that could not be drawn at all before:
    // `plan_diagram` takes one change, and this is three.
    const r = (await call("simulate_changes", {
      changes: [
        { tool: "add_summer_session", arguments: { year: 2027, based_on_revision: ctx.rev } },
        { tool: "move_course", arguments: { code: "CHEM 110", term_index: 2, based_on_revision: ctx.rev } },
        { tool: "optimize_schedule", arguments: { based_on_revision: ctx.rev } },
      ],
    })) as Preview;

    expect(r.possible, `the preview failed: ${JSON.stringify(r).slice(0, 300)}`).toBe(true);
    expect(r.diagram, "a multi-change preview came back with no picture of itself").toBeTruthy();
    expect(r.diagram_format).toBe("mermaid");
    expect(r.diagram!, "the diagram is not a flowchart").toMatch(/^\s*flowchart/m);
  });

  it("carries the legend, or the picture arrives as source", async () => {
    // `how_to_show_this` is what tells a model to put the text in a
    // mermaid fence. The first version returned the diagram alone and it
    // rendered as a wall of graph syntax in the chat.
    const r = (await call("simulate_changes", {
      changes: [{ tool: "optimize_schedule", arguments: { based_on_revision: ctx.rev } }],
    })) as Preview;
    expect(r.how_to_show_this, "nothing tells the model how to render it").toMatch(/mermaid/i);
    // The colour key is not decoration: it is what stops "cannot be
    // checked" being read back to a student as "fine" (iron rule 2).
    expect(r.what_the_colours_mean, "the colour key is missing").toMatch(/cannot be checked/i);
    expect(r.what_an_edge_means, "nothing says what an arrow claims").toBeTruthy();
  });

  it("draws the plan the report describes, not the one on disk", async () => {
    // The candidate, not the current plan. Adding a summer session is
    // visible in the term boxes, so the drawing can be checked against
    // the change rather than taken on trust.
    const before = onDisk().terms.length;
    const r = (await call("simulate_changes", {
      changes: [{ tool: "add_summer_session", arguments: { year: 2027, based_on_revision: ctx.rev } }],
    })) as Preview & { terms_after?: number };

    expect(r.possible).toBe(true);
    expect(r.terms_after, "the report does not show a term being added").toBeGreaterThan(before);
    const boxes = (r.diagram!.match(/subgraph/g) ?? []).length;
    expect(boxes, `the drawing has ${boxes} term boxes, the plan on disk has ${before}`).toBeGreaterThan(before);
    expect(onDisk().terms.length, "a preview wrote to the student's plan").toBe(before);
  });

  it("still cannot be mistaken for a change that happened", async () => {
    // The picture is the most convincing thing in the response, so the
    // fields that say "this is not real" matter more now, not less.
    const r = (await call("simulate_changes", {
      changes: [{ tool: "optimize_schedule", arguments: { based_on_revision: ctx.rev } }],
    })) as Preview;
    expect(r.applied, "a drawn preview reported itself as applied").toBe(false);
    expect(r.ok, "a preview carries the success flag a real change returns").toBeUndefined();
    expect(r.revision, "a preview carries a revision, which a model reads as saved").toBeUndefined();
  });
});

describe("previewing one change", () => {
  it("gets a picture too, through the same path", async () => {
    // `simulate_change` is the one-element call of `simulate_changes`,
    // so this is free — asserted anyway, because "free" is a claim about
    // an implementation that could stop being true.
    const r = (await call("simulate_change", {
      change: "optimize_schedule",
      arguments: { based_on_revision: ctx.rev },
    })) as Preview;
    expect(r.possible, JSON.stringify(r).slice(0, 200)).toBe(true);
    expect(r.diagram, "a single-change preview came back with no picture").toBeTruthy();
  });
});

describe("a preview that cannot happen", () => {
  it("draws nothing when the changes were refused", async () => {
    // A picture beside a refusal is a plan the student cannot have,
    // rendered convincingly. The refusal says what went wrong; there is
    // no candidate to draw.
    const r = (await call("simulate_changes", {
      changes: [{ tool: "move_course", arguments: { code: "NOPE 999", term_index: 1, based_on_revision: ctx.rev } }],
    })) as Preview;
    expect(r.possible, "a change against a course that is not in the plan was reported possible").toBe(false);
    expect(r.diagram, "a refused preview came back with a drawing of a plan nobody can have").toBeUndefined();
  });

  it("draws nothing when the revision is stale", async () => {
    const r = (await executeTool(
      "simulate_changes",
      {
        changes: [{ tool: "optimize_schedule", arguments: { based_on_revision: (ctx.rev ?? 0) - 1 } }],
      },
      ctx,
    )) as Preview;
    expect(r.possible).toBe(false);
    expect(r.diagram, "a preview built from a revision that no longer exists was still drawn").toBeUndefined();
  });
});
