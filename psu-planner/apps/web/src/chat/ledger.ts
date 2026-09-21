/** Durable action ledger: every plan-mutating tool call is recorded to
 * localStorage — the AI's authoritative memory of what IT did. Motivated by a
 * real incident: the assistant removed required courses, the user's undo
 * failed, and when asked, the model DENIED having done it (the chat wire log
 * is in-memory and trimmed, so it had no ground truth). The ledger survives
 * reloads and trimming; `get_action_history` exposes it to the model, and the
 * system prompt forbids contradicting it. */

export interface LedgerEntry {
  ts: string; // ISO timestamp
  tool: string;
  summary: string; // human-readable, e.g. "removed AI 100 from the plan"
  planRevBefore: number | null;
  planRevAfter: number | null;
}

const LS_KEY = "psu-planner-action-log-v1";
const MAX_ENTRIES = 300;

function read(): LedgerEntry[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as LedgerEntry[];
  } catch {
    return [];
  }
}

export function appendAction(entry: Omit<LedgerEntry, "ts">): void {
  try {
    const log = read();
    log.push({ ts: new Date().toISOString(), ...entry });
    localStorage.setItem(LS_KEY, JSON.stringify(log.slice(-MAX_ENTRIES)));
  } catch {
    // Quota/serialization failures must never break the tool itself.
  }
}

export function getActions(limit = 30): LedgerEntry[] {
  return read().slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)));
}

export function clearActions(): void {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}
