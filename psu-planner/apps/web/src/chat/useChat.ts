/** Client-owned chat loop: POST messages to the proxy, stream the SSE
 * completion, execute any tool calls locally, append results, repeat.
 *
 * Undo is a STACK of pre-turn snapshots, pushed only when a turn actually
 * mutated the plan. (The original single-snapshot design was destroyed by a
 * real incident: a destructive turn was followed by an innocent "what
 * happened?" question, which overwrote the only good snapshot with the
 * wrecked plan — undo then "restored" the wreckage.) Chat history and the
 * wire log persist to localStorage so a reload doesn't cause amnesia. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanDoc } from "@psu-planner/engine";
import { usePlanner } from "../store";
import { accessToken } from "../data/sync";
import { executeTool, resetTurnGuards } from "./tools";
import { chatEndpoint } from "./config";

export interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  toolNotes?: string[];
}

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface WireMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

const MAX_TOOL_ROUNDS = 10;
/** Trim old exchanges when the wire log grows: keep the most recent messages,
 * always starting at a `user` message so assistant/tool-call groups are never
 * split (OpenAI rejects orphaned tool messages). */
function trimWire(messages: WireMessage[], keep = 80): WireMessage[] {
  if (messages.length <= keep) return messages;
  let start = messages.length - keep;
  while (start < messages.length && messages[start].role !== "user") start++;
  return messages.slice(start);
}

/** Hard ceiling on a single model round-trip. A stalled stream (dead upstream,
 * a model looping without emitting) must fail with a message, never hang the
 * whole chat. */
const REQUEST_TIMEOUT_MS = 45_000;

async function streamCompletion(
  messages: WireMessage[],
  onDelta: (text: string) => void,
): Promise<{ content: string; toolCalls: WireToolCall[]; error?: string }> {
  // Belt and braces: the UI does not render a way to reach this when the
  // advisor is unconfigured, but a direct caller must not fetch `null`.
  if (!chatEndpoint) {
    return { content: "", toolCalls: [], error: "The advisor is not configured in this build." };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  // S1 identity gate: the server rate-limits on the JWT's `sub` when present and
  // (with REQUIRE_AUTH set) rejects anonymous calls outright. Omitted when
  // Supabase isn't configured, which keeps local dev working IP-keyed.
  const token = await accessToken();
  let res: Response;
  try {
    res = await fetch(chatEndpoint!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messages }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return { content: "", toolCalls: [], error: aborted ? "the request took too long and was stopped — try again, or use the Optimize button on the toolbar" : String(e) };
  }
  if (!res.ok) {
    clearTimeout(timer);
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    return { content: "", toolCalls: [], error: (err as { error?: string }).error ?? `HTTP ${res.status}` };
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const calls: { id?: string; name?: string; args: string }[] = [];

  try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      let chunk: { choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
      try { chunk = JSON.parse(payload); } catch { continue; }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onDelta(content);
      }
      for (const tc of delta.tool_calls ?? []) {
        calls[tc.index] = calls[tc.index] ?? { args: "" };
        if (tc.id) calls[tc.index].id = tc.id;
        if (tc.function?.name) calls[tc.index].name = tc.function.name;
        if (tc.function?.arguments) calls[tc.index].args += tc.function.arguments;
      }
    }
  }
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    if (aborted) return { content, toolCalls: [], error: "the request took too long and was stopped — try again, or use the Optimize button on the toolbar" };
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return {
    content,
    toolCalls: calls
      .filter((c) => c.id && c.name)
      .map((c) => ({ id: c.id!, type: "function" as const, function: { name: c.name!, arguments: c.args || "{}" } })),
  };
}

const CHAT_LS_KEY = "psu-planner-chat-v1";
const UNDO_STACK_MAX = 20;

interface PersistedChat {
  messages: DisplayMessage[];
  wire: WireMessage[];
}
function loadPersistedChat(): PersistedChat {
  try {
    const raw = localStorage.getItem(CHAT_LS_KEY);
    if (raw) return JSON.parse(raw) as PersistedChat;
  } catch { /* corrupt/absent — start fresh */ }
  return { messages: [], wire: [] };
}

export function useChat() {
  const persisted = useRef(loadPersistedChat());
  const [messages, setMessages] = useState<DisplayMessage[]>(persisted.current.messages);
  const [busy, setBusy] = useState(false);
  const wireRef = useRef<WireMessage[]>(persisted.current.wire);
  /** Undo STACK: one entry per plan-MUTATING turn (never overwritten by
   * read-only turns), popped one turn at a time. */
  const undoStackRef = useRef<{ snapshot: PlanDoc; label: string }[]>([]);
  const [canUndo, setCanUndo] = useState(false);

  // Persist chat after every turn so a reload keeps the conversation.
  useEffect(() => {
    if (busy) return;
    try {
      localStorage.setItem(CHAT_LS_KEY, JSON.stringify({ messages, wire: trimWire(wireRef.current) } satisfies PersistedChat));
    } catch { /* quota — drop persistence, never break chat */ }
  }, [messages, busy]);

  const send = useCallback(async (text: string) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    resetTurnGuards(); // per-turn tool guards (removal limits)
    const planBefore = usePlanner.getState().plan;
    const preTurnSnapshot = planBefore ? (structuredClone(planBefore) as PlanDoc) : null;

    wireRef.current = trimWire(wireRef.current);
    wireRef.current.push({ role: "user", content: text });
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    const toolNotes: string[] = [];

    try {
      let finished = false;
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const updateAssistant = (partial: string) =>
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { role: "assistant", content: partial, toolNotes: [...toolNotes] };
            return copy;
          });

        const { content, toolCalls, error } = await streamCompletion(wireRef.current, updateAssistant);
        if (error) {
          updateAssistant(content || `⚠ ${error}`);
          finished = true;
          break;
        }
        if (!toolCalls.length) {
          wireRef.current.push({ role: "assistant", content });
          updateAssistant(content || "(no response)");
          finished = true;
          break;
        }
        wireRef.current.push({ role: "assistant", content: content || null, tool_calls: toolCalls });
        for (const tc of toolCalls) {
          let result: unknown;
          try {
            result = await executeTool(tc.function.name, JSON.parse(tc.function.arguments || "{}"));
          } catch (e) {
            result = { error: String(e) };
          }
          toolNotes.push(tc.function.name);
          updateAssistant(content);
          wireRef.current.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 12_000) });
        }
      }
      // Ran out of tool rounds without the model giving a final answer — say so
      // rather than leaving a dead, empty assistant bubble.
      if (!finished) {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = {
            role: "assistant",
            content: (last?.content ? last.content + "\n\n" : "") +
              "⚠ I took too many steps on that and stopped. Try asking more specifically, or use the toolbar's Optimize button for schedule changes.",
            toolNotes: [...toolNotes],
          };
          return copy;
        });
      }
    } finally {
      // Push an undo point ONLY if this turn actually changed the plan — a
      // read-only follow-up question can never clobber a good snapshot again.
      const after = usePlanner.getState().plan;
      if (preTurnSnapshot && JSON.stringify(after) !== JSON.stringify(preTurnSnapshot)) {
        undoStackRef.current.push({
          snapshot: preTurnSnapshot,
          label: toolNotes.filter((t) => !/^(get_|search_|check_|audit_)/.test(t)).join(", ") || text.slice(0, 60),
        });
        if (undoStackRef.current.length > UNDO_STACK_MAX) undoStackRef.current.shift();
      }
      setCanUndo(undoStackRef.current.length > 0);
      setBusy(false);
    }
  }, [busy]);

  /** Step back one plan-mutating turn at a time (up to the stack depth). */
  const undo = useCallback(async () => {
    const top = undoStackRef.current.pop();
    if (!top) return;
    await usePlanner.getState().setPlan(top.snapshot);
    setCanUndo(undoStackRef.current.length > 0);
    setMessages((m) => [...m, {
      role: "assistant",
      content: `↩ Reverted the plan to before: ${top.label}.${undoStackRef.current.length ? ` (${undoStackRef.current.length} earlier change${undoStackRef.current.length > 1 ? "s" : ""} can still be undone.)` : ""}`,
    }]);
  }, []);

  const reset = useCallback(() => {
    wireRef.current = [];
    setMessages([]);
    undoStackRef.current = [];
    setCanUndo(false);
    try { localStorage.removeItem(CHAT_LS_KEY); } catch { /* ignore */ }
  }, []);

  return { messages, busy, send, undo, canUndo, reset };
}
