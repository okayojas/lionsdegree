/** Removing a Course that was chosen for a requirement (#50).
 *
 * THE BUG, and it was shipping. The precondition asked `ctx.items` —
 * the built view, where a Slot-filled Course appears as an ordinary
 * Course with that code — and the mutation then walked `terms[].items`
 * looking for `"code" in i`, where the same Course is a SlotSpec
 * carrying a Slot id and no code at all.
 *
 * So the guard passed, the filter matched nothing, and the commit
 * landed anyway because nothing had errored. The student was told
 * `ok: true, removed: STAT 200`, the Revision advanced, and the Course
 * was still in their plan. Every later compare-and-swap was then
 * against a Plan that was not the one they had been shown.
 *
 * Two things are wrong there and both are tested below: the change did
 * not happen, and the answer said it did.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool, loadContext, type ToolContext } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const SOURCE = path.join(here, "fixtures", "plan.json");

let planPath: string;
let ctx: ToolContext;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-slot-"));
  planPath = path.join(dir, "plan.json");
  fs.copyFileSync(SOURCE, planPath);
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
});

const call = (name: string, args: Record<string, unknown> = {}) =>
  executeTool(name, { based_on_revision: ctx.rev, ...args }, ctx) as Promise<Record<string, unknown>>;

const onDisk = () => JSON.parse(fs.readFileSync(planPath, "utf-8")).plan;
const codesInPlan = (): string[] =>
  (ctx.items as { kind: string; code?: string }[])
    .filter((i) => i.kind === "course" && i.code)
    .map((i) => i.code!);

/** Fill the first open requirement, so there is a Slot-filled Course to
 * try to remove. Derived from the plan rather than hardcoded: a fixture
 * whose Slot ids change should fail loudly here, not silently stop
 * testing anything. */
async function fillFirstSlot(): Promise<{ slotId: string; code: string }> {
  const plan = (await call("get_plan")) as { terms: { open_slots: { slot_id: string }[] }[] };
  const slot = plan.terms.flatMap((t) => t.open_slots)[0];
  expect(slot, "the fixture has no open requirement — this test can prove nothing").toBeTruthy();
  const code = "CMPSC 465";
  const filled = await call("fill_slot", { slot_id: slot.slot_id, code });
  expect(filled.ok, `could not fill the slot to set the test up: ${JSON.stringify(filled)}`).toBe(true);
  return { slotId: slot.slot_id, code };
}

describe("removing a Course that is filling a requirement", () => {
  it("ACTUALLY REMOVES IT", async () => {
    // The headline. Before the fix this passed its guard, wrote a
    // revision, answered `removed: CMPSC 465`, and left the course
    // exactly where it was.
    const { code } = await fillFirstSlot();
    expect(codesInPlan(), "setup failed: the course is not in the plan").toContain(code);

    const r = await call("remove_course", { code });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(codesInPlan(), "remove_course reported success and the course is still in the plan").not.toContain(code);
  });

  it("leaves the requirement OPEN rather than deleting it", async () => {
    // The requirement belongs to the student's Program, not to them.
    // Removing their choice un-chooses it; it does not excuse them
    // from the requirement, and a plan that quietly lost one would
    // under-report what they still need.
    const { slotId, code } = await fillFirstSlot();
    await call("remove_course", { code });

    expect(onDisk().slotFills?.[slotId], "the slot fill was not cleared").toBeUndefined();
    const after = (await call("get_plan")) as { terms: { open_slots: { slot_id: string }[] }[] };
    expect(
      after.terms.flatMap((t) => t.open_slots).map((s) => s.slot_id),
      "the requirement vanished instead of reopening",
    ).toContain(slotId);
  });

  it("says the requirement is open again, so nobody reads it as gone", async () => {
    // "removed: CMPSC 465" on its own is a sentence a model will
    // summarise as "that requirement is dealt with".
    const { slotId, code } = await fillFirstSlot();
    const r = await call("remove_course", { code });
    expect(r.freed_requirement).toBe(slotId);
    expect(String(r.note ?? ""), "nothing told the student the requirement still needs filling").toMatch(
      /open again|still needs/i,
    );
  });

  it("does not write a revision for a change that did not happen", async () => {
    // The quiet half of the bug. A no-op that advances the Revision
    // leaves every later compare-and-swap measured against a Plan the
    // student was never shown.
    const { code } = await fillFirstSlot();
    const revBefore = onDisk().rev as number;
    await call("remove_course", { code });
    const after = onDisk();

    // It genuinely changed something, so a new revision is correct —
    // what must not happen is a bump with an unchanged plan.
    expect(after.rev, "the revision did not move for a change that did happen").toBe(revBefore + 1);
    expect(JSON.stringify(after.slotFills ?? {}), "the plan is unchanged despite a new revision").not.toContain(code);
  });
});

describe("removing an ordinary Course still works", () => {
  it("is unaffected by the slot handling", async () => {
    // The control. A fix that only works for the broken case, by
    // breaking the one that worked, is not a fix.
    const code = (onDisk().terms as { items: { code?: string }[] }[])
      .flatMap((t) => t.items)
      .find((i) => i.code)!.code!;
    const r = await call("remove_course", {
      code,
      user_explicitly_asked: true,
      student_words: "I have decided I do not want that course in my degree",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(codesInPlan()).not.toContain(code);
    expect(r.freed_requirement, "an ordinary course reported freeing a requirement").toBeUndefined();
  });
});
