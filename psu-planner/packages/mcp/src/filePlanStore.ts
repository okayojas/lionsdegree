/** The Plan as a file on the student's own disk.
 *
 * SPLIT OUT OF `planStore.ts`, and not for tidiness. The planner reaches
 * `mutations.ts` to recompute a Candidate tab (#56), and `mutations.ts`
 * imports `MemoryPlanStore` from the store module — so everything in that
 * file was being pulled into a browser bundle. This one reads `node:fs`,
 * which vite externalised with a warning on every single build. A warning
 * printed on every build is how a real one gets missed.
 *
 * Nothing else changed in the move: it is still the local server's store,
 * still the only writer of a plan file, and still the exception to the
 * compare-and-swap rule documented below.
 */
import { exportPlanFile, parsePlanFile, type PlanDoc } from "@psu-planner/engine";
import { PlanUnopenable, type PlanStore, type StoredPlan, type WriteOutcome } from "./planStore.js";

/** The plan file the student exported from the planner. */
export class FilePlanStore implements PlanStore {
  constructor(private readonly path: string) {}

  async read(editions: string[]): Promise<StoredPlan | null> {
    const { default: fs } = await import("node:fs");
    if (!fs.existsSync(this.path)) return null;
    const parsed = parsePlanFile(fs.readFileSync(this.path, "utf-8"), editions);
    if (!parsed.ok) throw new PlanUnopenable(parsed.reason);
    return { plan: parsed.plan, rev: parsed.plan.rev ?? 0, updatedAt: parsed.plan.updatedAt ?? "" };
  }

  async write(plan: PlanDoc, baseRev: number): Promise<WriteOutcome> {
    const { default: fs } = await import("node:fs");

    // A READ THEN A WRITE, which the interface above says a swap must
    // not be — so the exception is stated rather than left to be
    // noticed. A plain file offers no conditional write; the atomic
    // version needs locking that POSIX and Windows disagree about, for
    // a case with one writing process and a human at the keyboard.
    //
    // What it does buy is the case the rule exists for: the student
    // edited in the planner while this server was running, so the
    // revision ON DISK is not the one this process loaded at startup.
    // Reading it back catches that; the surviving window is between
    // these two lines, and the hosted store — where there really are
    // two writers — swaps in the database instead.
    if (fs.existsSync(this.path)) {
      const held = JSON.parse(fs.readFileSync(this.path, "utf-8")) as { plan?: { rev?: number } };
      if ((held.plan?.rev ?? 0) !== baseRev) return "stale";
    } else if (baseRev !== 0) {
      // The file this write was computed from is gone. Recreating it
      // would resurrect a Plan the student may have deleted.
      return "stale";
    }

    fs.writeFileSync(this.path, exportPlanFile(plan), "utf-8");
    return "written";
  }
}
