/** The first-run tour of the planner (#71).
 *
 * A small card beside the real control each step is about, over a dimmed
 * page with that control left clear. Back, Next, and Skip tour; Escape
 * skips. Focus moves into the card and stays there while it is open, and
 * goes back where it was when it closes.
 *
 * A step whose control is not on screen (a phone, or the side panel put
 * away) is shown in the middle of the screen with the same words, rather
 * than skipped or pointing at nothing.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TourStep } from "../data/tour";

interface Box { top: number; left: number; width: number; height: number }

/** The control's box on screen, or null where it is not visible. */
function boxOf(anchor: string | null): Box | null {
  if (!anchor) return null;
  const el = [...document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`)].find((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
  });
  if (!el) return null;
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

const GAP = 12;
const CARD_WIDTH = 340;

export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [at, setAt] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [, setTick] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  const step = steps[at]!;
  const last = at === steps.length - 1;

  // Where the control is, now and whenever the window moves under it.
  useLayoutEffect(() => {
    const place = () => { setBox(boxOf(step.anchor)); setTick((n) => n + 1); };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [step.anchor]);

  // Focus into the card when it opens and on every step; back where it was
  // when the tour ends.
  useEffect(() => {
    returnTo.current = document.activeElement;
    return () => { (returnTo.current as HTMLElement | null)?.focus?.(); };
  }, []);
  useEffect(() => { card.current?.focus(); }, [at]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "Tab") return;
    // Keep Tab inside the card while it is open.
    const focusable = [...(card.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]!, end = focusable[focusable.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === card.current)) {
      e.preventDefault(); end.focus();
    } else if (!e.shiftKey && document.activeElement === end) {
      e.preventDefault(); first.focus();
    }
  };

  // The card: below the control where there is room, otherwise above, and
  // always inside the screen. Centred where there is no control.
  const vw = window.innerWidth, vh = window.innerHeight;
  const width = Math.min(CARD_WIDTH, vw - 24);
  let style: React.CSSProperties;
  if (!box) {
    style = { width, left: (vw - width) / 2, top: Math.max(12, vh / 2 - 120) };
  } else {
    const left = Math.min(Math.max(12, box.left + box.width / 2 - width / 2), vw - width - 12);
    const below = box.top + box.height + GAP;
    const roomBelow = vh - below;
    style = roomBelow > 200
      ? { width, left, top: below }
      : { width, left, bottom: Math.max(12, vh - box.top + GAP) };
    // A control as tall as the screen (the chart): sit inside it, at the top.
    if (box.height > vh * 0.6) style = { width, left, top: Math.max(12, box.top + GAP) };
  }

  return (
    <div className="tour" onKeyDown={onKeyDown}>
      {/* The dim, with the control left clear. Clicking it does nothing: the
          tour ends from its own buttons, or Escape. */}
      <div className="tour-dim" aria-hidden="true" />
      {box && (
        <div
          className="tour-spot"
          aria-hidden="true"
          style={{ top: box.top - 6, left: box.left - 6, width: box.width + 12, height: box.height + 12 }}
        />
      )}
      <div
        ref={card}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        style={style}
      >
        <p className="tour-count">Step {at + 1} of {steps.length}</p>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-body">{step.body}</p>
        <div className="tour-acts">
          <button type="button" className="tour-skip" onClick={onClose}>{last ? "Close" : "Skip tour"}</button>
          <span className="tour-nav">
            {at > 0 && <button type="button" onClick={() => setAt(at - 1)}>Back</button>}
            <button type="button" className="primary" onClick={() => (last ? onClose() : setAt(at + 1))}>
              {last ? "Done" : "Next"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
