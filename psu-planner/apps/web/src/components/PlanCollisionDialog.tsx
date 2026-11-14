/** Two plans, one student, and a question we are not allowed to answer.
 *
 * The situation: somebody built a plan on this device while signed out,
 * then signed in, and the account already had a different one. That used
 * to be settled by comparing timestamps — and the plan that lost became
 * unreachable, because the sign-in read takes the newest row and never
 * looks further. The student's older work was still in Postgres and still
 * gone as far as they could tell.
 *
 * So it is asked. This is the one place in the feature where a wrong
 * automatic answer feels unrecoverable, and a clock is a bad arbiter — the
 * project already took clocks out of writes for the same reason (ADR 0003).
 */
import { useEffect, useState } from "react";
import type { PlanDoc } from "@psu-planner/engine";
import { Dialog } from "./Dialog";
import { loadProgramsIndex } from "../data/catalogClient";
import { describePlan, type PlanSummary } from "../data/planSummary";

/** Two buttons, each naming the plan it keeps.
 *
 * NOT "Keep this one" twice. Beside the thing it belongs to that reads
 * perfectly well, and in every other way a student meets it — announced by
 * a screen reader, or landed on by keyboard with the label two elements
 * behind — it is two identical buttons with opposite consequences. The
 * accessible name has to carry the choice. */
const ACTIONS = { device: "Keep this device's plan", account: "Keep my account's plan" };

function Choice({ where, summary, action, onPick }: {
  where: string;
  summary: PlanSummary;
  action: string;
  onPick: () => void;
}) {
  return (
    <div className="row pc-choice">
      <span style={{ flex: 1 }}>
        <b>{where}</b>
        <span className="pc-facts">
          {summary.programs} · {summary.terms} terms · last changed {summary.changed}
        </span>
      </span>
      <button type="button" onClick={onPick}>{action}</button>
    </div>
  );
}

export function PlanCollisionDialog({ local, remote, onKeep }: {
  local: PlanDoc;
  remote: PlanDoc;
  /** Which plan to carry on with. Both survive either way; this decides
   * which one is on screen afterwards. */
  onKeep: (which: "device" | "account") => void;
}) {
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    // Best effort, and deliberately not awaited before rendering: the
    // choice is between two plans the student made, and it must be
    // offerable even if the catalog index cannot be fetched. Unknown
    // slugs fall back to themselves rather than to nothing.
    void loadProgramsIndex()
      .then((idx) => setNames(Object.fromEntries(idx.map((p) => [p.slug, p.name]))))
      .catch(() => {});
  }, []);

  const nameFor = (slug: string) => names[slug];

  return (
    // Escape and a click away both mean "keep what is on screen", which is
    // the device's plan. A dialog with no exit but its two buttons would be
    // a trap, and the one exit that changes nothing the student can
    // currently see is the honest default. Both plans survive it.
    <Dialog label="Two plans" onClose={() => onKeep("device")}>
      <h2>Your account already has a plan</h2>
      <p className="desc">
        This device has a different one. Pick the plan to carry on with —{" "}
        <strong>the other one is kept either way</strong>, and you can open it again from
        Menu → Plan history.
      </p>
      <Choice
        where="On this device"
        summary={describePlan(local, nameFor)}
        action={ACTIONS.device}
        onPick={() => onKeep("device")}
      />
      <Choice
        where="In your account"
        summary={describePlan(remote, nameFor)}
        action={ACTIONS.account}
        onPick={() => onKeep("account")}
      />
    </Dialog>
  );
}
