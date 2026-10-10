/** Privacy, Terms and Accessibility inside the planner.
 *
 * The wording is NOT here. It lives in `src/legal/content.ts`, which also
 * generates the static documents at /privacy and /terms; this file is only the
 * React renderer for it. Keeping one copy is the point: the previous version
 * hand-maintained its text, and a policy that describes a data flow the
 * product no longer has is not a style problem, it is an inaccurate privacy
 * policy. Drafts pending a lawyer's review. */
import { useState } from "react";
import { Dialog } from "./Dialog";
import { SECTIONS, type Block, type Inline, type Section } from "../legal/content";

function Run({ run }: { run: Inline }) {
  if (typeof run === "string") return <>{run}</>;
  if ("b" in run) return <b>{run.b}</b>;
  if ("i" in run) return <i>{run.i}</i>;
  const external = !run.href.startsWith("mailto:");
  return (
    <a href={run.href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {run.a}
    </a>
  );
}

const Runs = ({ list }: { list: Inline[] }) => (
  <>
    {list.map((r, i) => (
      <Run key={i} run={r} />
    ))}
  </>
);

function Blocks({ body }: { body: Block[] }) {
  return (
    <>
      {body.map((b, i) =>
        "p" in b ? (
          <p key={i}>
            <Runs list={b.p} />
          </p>
        ) : (
          <ul key={i}>
            {b.ul.map((li, j) => (
              <li key={j}>
                <Runs list={li} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

export function LegalModal({ initial, onClose }: { initial?: Section["id"]; onClose: () => void }) {
  const [tab, setTab] = useState<Section["id"]>(initial ?? "privacy");
  const section = SECTIONS.find((s) => s.id === tab)!;
  return (
    <Dialog label="Legal information" onClose={onClose}>
      <div className="row" style={{ marginTop: 0 }}>
        {SECTIONS.map((s) => (
          <button key={s.id} className={tab === s.id ? "primary" : ""} onClick={() => setTab(s.id)}>
            {s.tab}
          </button>
        ))}
      </div>
      <div className="legal-body">
        <h3>{section.heading}</h3>
        <Blocks body={section.body} />
        {section.path && (
          // A student who wants to keep or send a policy needs a URL, not a
          // modal they have to reopen.
          <p>
            <a href={section.path} target="_blank" rel="noopener noreferrer">
              Open this as a page
            </a>
          </p>
        )}
      </div>
      <div className="row">
        <button onClick={onClose} data-autofocus>
          Close
        </button>
      </div>
    </Dialog>
  );
}
