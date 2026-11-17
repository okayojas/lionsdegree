/** Setup's last step: use the plan with your own AI (optional).
 *
 * WHY HERE (the owner, 2026-11-17). The AI connector is one of the things
 * LionsDegree does that nothing else for Penn State students does, and the
 * only place it was offered was a button on the chart and a page of its own.
 * Setup is the one screen every student reads from top to bottom, so it is
 * where they learn it exists.
 *
 * OPTIONAL AND AFTER THE FACT. Connecting needs a plan saved to an account,
 * and at this point there is neither: the step says so plainly, offers the
 * link to copy now, and leaves the full walkthrough (ChatGPT's plan limits
 * included) to the Connect page. Nothing here blocks building the plan.
 *
 * Only where accounts exist. A build with no account service (a self-hosted
 * copy) has nothing for an assistant to read, so the step is not shown.
 */
import { useState } from "react";
import { CONNECTOR_URL } from "../data/connector";

export function ConnectAiStep({ number }: { number: number }) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CONNECTOR_URL);
      setCopied("yes");
    } catch {
      // Clipboard refused (an older browser, or permission denied). The
      // address is selectable text beside the button either way.
      setCopied("failed");
    }
  };

  return (
    <div className="step connect-ai">
      <h3>{number} · Use your plan with your AI (optional)</h3>
      <p className="step-help">
        Connect Claude or ChatGPT and ask about your plan in your own words: <i>what if I add a
        minor?</i>, <i>can I graduate a term early?</i>, <i>what should I take next spring?</i> It
        answers from your real plan and the Bulletin, not from memory.
      </p>
      <div className="ai-copy">
        <code className="ai-url">{CONNECTOR_URL}</code>
        <button type="button" onClick={() => void copy()} aria-label="Copy the connection link">
          {copied === "yes" ? "Copied" : "Copy link"}
        </button>
      </div>
      <p className="ai-status" role="status">
        {copied === "yes"
          ? "Copied. Paste it into your assistant once your plan is built and you've signed in."
          : copied === "failed"
            ? "Your browser would not copy it. Select the link above and copy it yourself."
            : ""}
      </p>
      <ol className="ai-how">
        <li>Build your plan below, then <b>sign in</b> (top right) so it is saved to your account.</li>
        <li>
          In Claude: <b>Customize → Connectors → Add custom connector</b>, paste the link, and sign in
          with the same account.
        </li>
      </ol>
      <p className="step-help ai-more">
        <a href="/connect/">Full instructions, including ChatGPT</a>. You can skip this and connect any
        time from the planner.
      </p>
    </div>
  );
}
