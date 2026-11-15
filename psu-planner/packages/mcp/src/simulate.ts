/** What a change — or a whole list of them — would do, without doing it.
 *
 * "I want out in seven terms, I've got AP calc and transfer stats, and
 * I'd like to study abroad junior spring" is one sentence a student
 * would actually say. The assistant turns it into five explicit changes
 * and previews them TOGETHER, as one candidate plan.
 *
 * TOGETHER IS THE WHOLE POINT. Five separate previews are not an answer
 * to a question about a combination, because the optimiser re-flows the
 * entire plan on every change: the term the third one moved a course
 * into is a term the fourth one may empty. A student handed five
 * previews has to simulate the interaction in their head, which is the
 * work they asked for help with.
 *
 * THE GOVERNING PRINCIPLE (#39): the model interprets, the engine
 * computes. What arrives here is a list of NAMED changes with explicit
 * arguments, never a sentence describing a preference. Turning a
 * rambling into that list is the assistant's job and it is good at it;
 * deciding what a student meant is not something this server may do.
 *
 * THE SECOND DECISION: this does not simulate anything. It runs the REAL
 * mutations, through the real optimiser, against a sandbox copy of the
 * plan. A second scheduling implementation written "just for previews"
 * would drift from the first, and the drift would show up as a student
 * being shown a plan the planner then refuses to produce — a forecast of
 * a system that does not exist.
 *
 * So the only thing this module owns is THE DIFF — the difference
 * between two schedules the engine built. The sandbox and the loop that
 * runs a list of changes through it moved to `sandbox.ts` when the
 * planner needed them too (#56): a Candidate tab is the same list of
 * changes against the same kind of copy, and a second implementation of
 * running them would be a picture of a plan this file then describes
 * differently.
 *
 * And the response is shaped so a model cannot read it as "done". No
 * `ok`, no new revision — the two fields a successful mutation returns
 * and the two a model would quote back to a student as proof.
 */
import { checkCourse, type PlanDoc, type PlanItem } from "@psu-planner/engine";
import { andList } from "./mutations.js";
import { planView } from "./planView.js";
import { readChanges, runChanges, sandbox } from "./sandbox.js";
import { drawPlan } from "./planDiagram.js";
import type { ToolContext } from "./tools.js";

// THE SHAPES MOVED, NOT THE MEANING. Both now live in `sandbox.ts`
// because that is where the refusals carrying them are built; they are
// re-exported from here because this is where every caller looks for
// them and a type that moves house silently breaks importers for no
// reason a reader can see.
export type { PlannedChange, SimulationResult } from "./sandbox.js";
import type { PlannedChange, SimulationResult } from "./sandbox.js";

/** Where a Course sits, by term label, in one schedule. */
type Placement = Map<string, { sem: number; label: string }>;

function placements(plan: PlanDoc, items: PlanItem[]): Placement {
  const at: Placement = new Map();
  for (const i of items) {
    if (i.kind !== "course" || !i.code) continue;
    at.set(i.code, { sem: i.sem, label: plan.terms[i.sem]?.label ?? `term ${i.sem}` });
  }
  return at;
}


/** Violations the change CREATES — a Course scheduled before something
 * it enforces as a prerequisite (CONTEXT.md) — and only the ones it
 * creates.
 *
 * A requirement that was already unverifiable is not something the
 * student's question broke, and reporting it here would blame their
 * question for a gap that predates it. Comparing before against after
 * is what keeps the list honest.
 *
 * Degradation is conservative in the usual direction (iron rule 2):
 * ANY fall counts, including "satisfied" to "cannot be checked" — a
 * student acting on this needs to know the answer stopped being
 * checkable, not just that it stopped being yes. */
function newViolations(
  before: ToolContext,
  after: ToolContext,
): { code: string; term: string; was: string; now: string }[] {
  const word = (v: number) => (v === 2 ? "satisfied" : v === 1 ? "cannot be checked" : "not satisfied");
  const cat = after.data.catalog;
  const wasAt = placements(before.plan!, before.items);

  const out: { code: string; term: string; was: string; now: string }[] = [];
  for (const i of after.items) {
    if (i.kind !== "course" || !i.code) continue;
    // A Course the catalog has no entry for scores SAT, which the
    // optimiser needs and a diff must not repeat (#49): it would mean a
    // change that moves an unknown Course anywhere is reported as
    // breaking nothing, which is a claim about requirements nobody has
    // read. Unknown degrades to "cannot be checked" here.
    const chkNow = checkCourse(cat, i.code, i.sem, after.sched);
    const now = chkNow.known === false ? 1 : chkNow.value;
    if (now === 2) continue;

    const previously = wasAt.get(i.code);
    // A Course the change ADDED has no "before" to compare against, so
    // an unsatisfied prerequisite on it is caused by the change by
    // definition.
    const wasChk = previously
      ? checkCourse(before.data.catalog, i.code, previously.sem, before.sched)
      : null;
    const was = wasChk ? (wasChk.known === false ? 1 : wasChk.value) : 2;
    // ANY DOWNGRADE, not only a fall from "satisfied". The first
    // version tested `was === 2`, which silently dropped a Course going
    // from "cannot be checked" to "not satisfied" — a change turning an
    // open question into a known blocker, reported as nothing at all.
    // That is the inverse of iron rule 2, in the file whose comment
    // claimed to be applying it.
    if (now < was) {
      out.push({
        code: i.code,
        term: after.plan!.terms[i.sem]?.label ?? `term ${i.sem}`,
        was: word(was),
        now: word(now),
      });
    }
  }
  return out;
}

/** Run an ordered list of changes against one copy of the plan and
 * report what the lot of them would do.
 *
 * `simulateChange` is the one-element case of this and nothing else —
 * there is deliberately no second implementation, because the single
 * and multiple paths would otherwise disagree about what a preview
 * reports and a bug fixed in one would survive in the other. */

export async function simulateChanges(ctx: ToolContext, raw: unknown): Promise<SimulationResult> {
  const read = readChanges(raw);
  if ("refusal" in read) return read.refusal;
  const changes = read.changes;
  const one = changes.length === 1;

  // ONE PATH, AND IT IS NOT THIS FILE'S. `runChanges` applies the list;
  // what is left here is the diff and the report. The Candidate tabs in
  // the planner run the same function against the same kind of sandbox,
  // which is what makes a tab and this preview incapable of disagreeing
  // about the plan a list of changes would leave behind.
  //
  // IMPOSSIBLE IS AN ANSWER, AND A PARTIAL CANDIDATE IS NOT. Returning
  // the plan as it stood after three of five changes would be a plan
  // nobody asked for, handed to a student as the answer to a question
  // about five. The refusal comes back already written, because the
  // words a student reads when a change will not apply must be the same
  // words wherever that happens.
  const before = ctx;
  const run = await runChanges(sandbox(ctx), changes);
  if ("refused" in run) return run.refused;
  const { after, needsConsent } = run;


  const wasAt = placements(before.plan!, before.items);
  const nowAt = placements(after.plan!, after.items);

  // A CHANGE CAN BREAK A DEGREE WITHOUT BREAKING A PREREQUISITE.
  // Removing a Course that was filling a requirement, or re-flowing a
  // Plan so a Slot empties, leaves the student short of graduating with
  // every prerequisite still perfectly satisfied. Reporting only
  // prerequisites would call that candidate clean.
  const openSlots = (c: ToolContext) =>
    new Set(c.items.filter((i) => i.kind === "slot" && i.id).map((i) => i.id!));
  const wasOpen = openSlots(before);
  const unfilled = [...openSlots(after)]
    .filter((id) => !wasOpen.has(id))
    .map((id) => {
      const slot = after.items.find((i) => i.id === id);
      return { slot_id: id, requirement: slot?.slotLabel ?? slot?.slot ?? "a requirement" };
    });

  const moved = [...nowAt.entries()]
    .filter(([code, to]) => wasAt.has(code) && wasAt.get(code)!.sem !== to.sem)
    .map(([code, to]) => ({ code, from: wasAt.get(code)!.label, to: to.label }));

  const violations = newViolations(before, after);
  const names = changes.map((c) => c.tool);

  return {
    simulated: true,
    // THREE WAYS OF SAYING THE SAME THING, because this is the one
    // misreading that costs a student their plan. A model skimming for
    // a success flag finds `applied: false`; one reading prose finds
    // the sentence; one looking for `ok` or a new revision — the two
    // fields a real change returns — finds neither.
    applied: false,
    nothing_changed:
      "This is a preview. The student's stored plan has not been changed. " +
      (one
        ? `To make this change for real, call ${names[0]}, `
        : `To make these ${names.length} changes for real, call ${andList(names)} in that order, `) +
      "or tell them to do it in the planner.",
    possible: true,
    based_on_revision: ctx.rev,
    changes,
    // THE SINGLE-CHANGE ANSWER KEEPS ITS FIELD. A list of one is still a
    // list, so `changes` is always there — but dropping `change` would
    // quietly take a field away from a tool whose callers did nothing
    // wrong.
    ...(one ? { change: changes[0] } : {}),

    // HOW THIS BECOMES REAL, named rather than implied, because the
    // alternative a model reaches for is an id to apply later — and
    // applying a stored candidate is applying a decision made against a
    // plan that may have moved since (#39, out of scope). Re-running
    // the calls against the revision the plan is at THEN is what makes
    // the compare-and-swap mean anything.
    to_make_this_real: {
      in_order: names,
      note:
        "There is no preview to apply later and no id to quote. Call get_plan, then make these " +
        "calls in this order, each stating the revision get_plan returned — so if the student " +
        "edited their plan in the meantime the change is refused rather than overwriting them.",
    },

    // THE CANDIDATE, DRAWN. A student asking "what would happen if I did
    // these five things" is asking about a SHAPE — which term got heavy,
    // what moved next to what — and five sentences about moves is the
    // work they wanted help avoiding.
    //
    // RETURNED FROM THE SIMULATION ITSELF rather than left to a second
    // `plan_diagram` call, for two reasons. The multi-change case could
    // not be drawn at all: `plan_diagram` takes ONE change, so the very
    // preview that most needs a picture was the one that could not have
    // one. And a separate call re-runs the changes against whatever the
    // plan is by then — two futures, shown as one. This draws the exact
    // sandbox the report above describes.
    //
    // Mermaid, not an image: it renders in the clients students use and
    // degrades to legible text where it does not, and a rasteriser has
    // no business in a 128 MB isolate holding the catalog.
    //
    // The revision and timestamp are stripped for the same reason
    // `planDiagram` strips them — the sandbox genuinely advanced, and
    // reporting that outward would tell a student their plan was saved.
    ...(() => {
      const picture = drawPlan(
        { ...after, rev: undefined, updatedAt: undefined },
        { of: one ? "the plan as this change would leave it" : "the plan as these changes would leave it" },
      );
      // THE LEGEND TRAVELS WITH IT. `how_to_show_this` is what tells a
      // model to put the text in a mermaid fence — without it the
      // picture arrives as a wall of graph syntax in the chat — and the
      // colour and edge keys are what stop "cannot be checked" being
      // read back to a student as "fine". Carrying `diagram` alone was
      // the first version, and it rendered as source.
      return picture.diagram
        ? {
            diagram: picture.diagram,
            diagram_format: picture.format,
            how_to_show_this: picture.how_to_show_this,
            what_the_colours_mean: picture.what_the_colours_mean,
            what_an_edge_means: picture.what_an_edge_means,
          }
        : {};
    })(),

    moved,
    added_courses: [...nowAt.keys()].filter((c) => !wasAt.has(c)),
    removed_courses: [...wasAt.keys()].filter((c) => !nowAt.has(c)),
    terms_before: before.plan!.terms.length,
    terms_after: after.plan!.terms.length,

    new_violations: violations,
    newly_unfilled_requirements: unfilled,

    // SAID HERE BECAUSE THE PREVIEW DID NOT ASK FOR IT. The consent
    // gate is relaxed for a simulation — a student asking "what would
    // happen if I dropped this?" has not agreed to drop it — so the
    // answer has to carry the condition the real change will impose,
    // or a model reads "possible: true" and finds out otherwise.
    ...(needsConsent.length
      ? {
          requires_consent: true,
          consent_needed_for: needsConsent,
          // PHRASED TO COVER BOTH, since #47 added a Program to the list.
          // "math-minor is required by the student's degree" is not a
          // sentence about anything, and a model reading it back to a
          // student would be saying something false about their own plan.
          before_doing_this_for_real:
            `Taking ${andList(needsConsent)} out of this student's degree needs them to ask for it ` +
            "in their own words — show them this preview, and pass what they say back as " +
            "student_words if they confirm.",
        }
      : {}),

    // NOT `satisfiable`. That word claims the candidate works, and this
    // only knows that the changes introduced nothing NEW — the fixture
    // alone carries two courses whose prerequisites cannot be checked
    // at all, and a plan with those in it was being reported as
    // satisfiable. Saying what was actually measured is the whole
    // discipline here (ADR 0002).
    introduces_no_problems: violations.length === 0 && unfilled.length === 0,
    ...(violations.length || unfilled.length
      ? {
          reason: [
            violations.length
              ? `This change leaves ${violations.length} course${violations.length === 1 ? "" : "s"} ` +
                "scheduled before a prerequisite it needs"
              : "",
            unfilled.length
              ? `it leaves ${unfilled.length} requirement${unfilled.length === 1 ? "" : "s"} ` +
                "that was filled now open"
              : "",
          ]
            .filter(Boolean)
            .join(", and ") + ". Tell the student before they act on it.",
        }
      : {}),

    // Pinned to the Plan's own Edition because the sandbox carries the
    // same catalog (ADR 0001) — a candidate audited against a different
    // bulletin is a forecast of somebody else's degree.
    //
    // WITH NO REVISION AND NO TIMESTAMP, and this was a live bug. The
    // sandbox commit sets `rev` and `updatedAt` on the copy, so the
    // candidate came back carrying `revision: 2` and a freshness note
    // reading "this is the plan as it was last saved (just now)" — a
    // revision that does not exist and a save that did not happen. The
    // top level said `applied: false` while the object nested inside it
    // described a successful write. A model summarising that tells the
    // student their plan is saved. A list makes it worse, not better:
    // the copy has been committed to once per change by then.
    candidate_plan: planView({ ...after, rev: undefined, updatedAt: undefined }, after.plan!),
  };
}

/** Run `change` against a copy and report what it would do.
 *
 * ONE ELEMENT, THEN THE SAME CODE. This is the whole of the
 * single-change tool: a second implementation would drift from the
 * list's, and the drift would be two tools disagreeing about what a
 * preview of the same change reports. */
export async function simulateChange(
  ctx: ToolContext,
  change: string,
  changeArgs: Record<string, unknown>,
): Promise<SimulationResult> {
  return simulateChanges(ctx, [{ tool: change, arguments: changeArgs }]);
}
