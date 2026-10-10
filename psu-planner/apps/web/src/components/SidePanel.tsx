/** Right-hand side panel: AI advisor chat + degree audit tabs. */
import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { auditProgram, buildPool, type AuditResult, type ReqSection } from "@psu-planner/engine";
import { useChat } from "../chat/useChat";
import { ChatMarkdown } from "../chat/ChatMarkdown";
import { loadCoverage, loadFullCatalog, loadProgramBySlug } from "../data/catalogClient";
import { currentUser, onAuthChange, signIn, syncConfigured } from "../data/sync";
import { usePlanner } from "../store";
import { useMediaQuery, PHONE_QUERY } from "../hooks/useMediaQuery";
import { chatConfigured } from "../chat/config";

function ChatTab({ chat }: { chat: ReturnType<typeof useChat> }) {
  const { messages, busy, send, undo, canUndo } = chat;
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Grow the textarea upward with content so long questions stay visible.
  const autosize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  };

  const submit = () => {
    const t = input.trim();
    if (!t || busy) return;
    setInput("");
    requestAnimationFrame(autosize);
    void send(t);
  };

  return (
    <>
      <div className="chat-messages" aria-live="polite" aria-label="Advisor conversation" tabIndex={0}>
        {messages.length === 0 && (
          <div className="chat-empty">
            Ask me anything about your plan — try:
            <ul>
              <li>"What should I still take for my gen eds?"</li>
              <li>"Move PHYS 212 one term later"</li>
              <li>"Suggest a technical elective about machine learning"</li>
              <li>"What am I still missing to graduate?"</li>
            </ul>
            I’m an AI assistant — I can read and edit your flowchart (undo any time), but verify important decisions with your adviser.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.toolNotes && m.toolNotes.length > 0 && (
              <div className="chat-tools">🔧 {[...new Set(m.toolNotes)].join(" · ")}</div>
            )}
            <div className="chat-bubble">
              {m.content
                ? (m.role === "assistant" ? <ChatMarkdown text={m.content} /> : m.content)
                : (busy && i === messages.length - 1 ? "…" : "")}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {canUndo && (
        <button className="chat-undo" onClick={() => void undo()}>↩ Undo AI changes to my plan</button>
      )}
      <div className="chat-input">
        <textarea
          ref={inputRef}
          aria-label="Message the AI advisor"
          rows={1}
          value={input}
          placeholder={busy ? "Thinking…" : "Ask about courses, requirements, your plan… (Shift+Enter for a new line)"}
          disabled={busy}
          onChange={(e) => { setInput(e.target.value); autosize(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="primary" disabled={busy || !input.trim()} onClick={submit}>Send</button>
      </div>
    </>
  );
}

/** Shown instead of the chat input when Supabase auth is configured but nobody
 * is signed in. The server would reject the call anyway (401 under
 * REQUIRE_AUTH); pre-empting it here turns an error into an empty state with a
 * primary action. Deterministic features stay free and unauthenticated. */
function ChatLocked() {
  return (
    <div className="chat-empty">
      <p style={{ margin: "0 0 12px" }}>
        <strong>Sign in to use the advisor.</strong> The AI advisor costs real money per
        message, so it needs an account. Everything else — your flowchart, the optimizer,
        the degree audit, and catalog search — works without one.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 260 }}>
        <button className="primary" onClick={() => void signIn("azure")}>
          Continue with Microsoft (PSU account)
        </button>
        <button onClick={() => void signIn("google")}>Continue with Google</button>
      </div>
    </div>
  );
}

function AuditTab() {
  const { plan } = usePlanner();
  const [audits, setAudits] = useState<{ name: string; audit: AuditResult }[] | null>(null);
  const rev = plan?.rev;

  useEffect(() => {
    if (!plan) return;
    let alive = true;
    (async () => {
      const cat = await loadFullCatalog();
      const coveredBy = await loadCoverage();
      const pool = buildPool(plan, cat);
      const results: { name: string; audit: AuditResult }[] = [];
      for (const slug of plan.programs) {
        const prog = await loadProgramBySlug<{ name: string; requirementSections: ReqSection[] }>(slug);
        if (prog) results.push({ name: prog.name, audit: auditProgram(prog.requirementSections, pool, cat, coveredBy) });
      }
      if (alive) setAudits(results);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  if (!audits) return <div className="chat-empty">Running the degree audit…</div>;
  return (
    // tabIndex makes the scroll region reachable: axe flags a scrollable
    // area with no focusable content because a keyboard user cannot reach
    // the part of it that is below the fold. Stacking the panel on a phone
    // is what made this one scroll.
    <div className="chat-messages" tabIndex={0} role="group" aria-label="Requirements">
      <p style={{ fontSize: 11.5, color: "var(--muted)", margin: "4px 0 10px" }}>
        Computed from your plan + completed courses against the bulletin's requirement tables.
        "Manual" items can't be checked automatically — verify with your adviser.
      </p>
      {audits.map(({ name, audit }) => (
        <div key={name} style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 13.5, margin: "0 0 6px", color: "var(--blue)" }}>
            {name}
            <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 11.5 }}>
              {" "}· {audit.totals.done} on track · {audit.totals.todo} to do · {audit.totals.manual} manual
            </span>
          </h3>
          {audit.sections.map((sec) => (
            <details key={sec.heading} open={sec.todo > 0} style={{ marginBottom: 6 }}>
              <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>
                {sec.heading} — {sec.done}✓ {sec.todo > 0 ? `· ${sec.todo} needed` : ""} {sec.manual > 0 ? `· ${sec.manual} manual` : ""}
              </summary>
              <ul style={{ margin: "6px 0", paddingLeft: 18, fontSize: 12 }}>
                {sec.rules.map((r, i) => (
                  <li key={i} style={{ color: r.status === "done" ? "var(--green)" : r.status === "in-progress" ? "var(--ink)" : r.status === "manual" ? "var(--muted)" : "var(--amber)" }}>
                    {r.status === "done" ? "✓ " : r.status === "in-progress" ? "◐ " : r.status === "manual" ? "? " : "○ "}
                    {r.label}
                    {r.used.length > 0 && <span style={{ color: "var(--muted)" }}> — {r.used.join(", ")}</span>}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      ))}
    </div>
  );
}

export function SidePanel({ width }: { width?: number }) {
  // Opens on the advisor when there IS one; otherwise on the requirements
  // audit, which is the panel's whole content in that configuration. Leaving
  // the default at "chat" showed an empty panel with a single tab beside it.
  const [tab, setTab] = useState<"chat" | "audit">(chatConfigured ? "chat" : "audit");
  // Chat state lives HERE (not in the tab) and the chat tab is hidden, never
  // unmounted — so switching to Requirements doesn't kill an in-flight reply.
  const chat = useChat();
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    if (!syncConfigured) return;
    void currentUser().then(setUser);
    return onAuthChange(setUser);
  }, []);
  // Configuring Supabase is what turns chat into a signed-in feature. Set the
  // server's REQUIRE_AUTH at the same time; this only hides the input, the
  // server is what actually enforces it.
  const chatLocked = syncConfigured && !user;
  const phone = useMediaQuery(PHONE_QUERY);
  return (
    // The dragged width is a DESKTOP affordance and is not emitted on a
    // phone. An inline style beats every stylesheet rule, so emitting it
    // always would leave the phone layer no way to take the width back short
    // of !important -- and a 360px panel on a 320px screen pushes the plan
    // off the side of the page. Same fix as SearchBox's hard-coded width.
    <div className="sidepanel" style={width && !phone ? { width, maxWidth: "none", flex: "0 0 auto" } : undefined}>
      <div className="sidepanel-tabs">
        {/* No Advisor tab when no advisor is configured. A student who
            configured nothing is never shown a control that cannot work, and
            with it hidden the panel is the requirements audit -- which needs
            no network, no account and no key. */}
        {chatConfigured && (
          <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
            ✦ Advisor{chat.busy && tab !== "chat" ? " …" : ""}
          </button>
        )}
        <button className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>Requirements</button>
      </div>
      {chatConfigured && (
        <div style={{ display: tab === "chat" ? "contents" : "none" }}>
          {chatLocked ? <ChatLocked /> : <ChatTab chat={chat} />}
        </div>
      )}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}
