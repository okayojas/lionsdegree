/** Moving a Plan between this app and anywhere else.
 *
 * The format and all the validation live in the engine, because the MCP
 * server reads and writes the same files and two readers would be two ideas
 * of what a valid plan is. This file is only the browser plumbing: a download
 * and a file picker. */
import { exportPlanFile, parsePlanFile, planFileName, type PlanDoc } from "@psu-planner/engine";
import { loadEditions } from "./catalogClient";

export function downloadPlan(plan: PlanDoc): void {
  const blob = new Blob([exportPlanFile(plan)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = planFileName(plan);
  // In the document, and revoked on a later task: Firefox has wanted the
  // anchor attached for a programmatic click, and revoking synchronously can
  // abort the transfer before it starts.
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

/** Pick a file and open it, or explain why not.
 *
 * Nothing is applied unless the whole plan parsed: a plan read against the
 * wrong bulletin edition silently changes which requirements govern a
 * student, which is worse than refusing. */
export async function openPlanFile(
  setPlan: (plan: PlanDoc) => Promise<void> | void,
  onMessage: (message: string) => void,
): Promise<void> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      onMessage("That file couldn't be read.");
      return;
    }
    const { editions } = await loadEditions();
    const result = parsePlanFile(text, editions);
    if (!result.ok) {
      onMessage(result.reason);
      return;
    }
    await setPlan(result.plan);
    onMessage(`Opened your plan for ${result.plan.programs.join(" + ") || "your degree"}.`);
  };
  input.click();
}
