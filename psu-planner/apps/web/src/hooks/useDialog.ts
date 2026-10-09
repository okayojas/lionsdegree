/** The keyboard contract every dialog in this app owes a student.
 *
 * Each modal previously handled Escape on its own and nothing else, which
 * left three gaps that only show up if you put the mouse down:
 *
 *   - focus stayed on the page BEHIND the dialog, so the first Tab went to
 *     the toolbar and a screen reader began reading the plan, not the dialog;
 *   - Tab walked straight out of the dialog into the page behind it, which
 *     is still visible and still clickable, so "which thing am I in" has no
 *     answer;
 *   - closing dropped focus to <body>, putting the student back at the top of
 *     the document with no memory of where they had been.
 *
 * Nothing here animates. Opening a dialog is a keyboard-initiated action a
 * student repeats all through a planning session, and motion on a repeated
 * keyboard action reads as lag (the dialog's own entrance transition is
 * separate and already tuned).
 */
import { useEffect, useRef } from "react";

/** Focusable, in DOM order, skipping anything disabled or deliberately
 * removed from the tab ring. `:not([tabindex="-1"])` matters: a scroll
 * container given tabindex="-1" is focusable by script but is not a tab stop,
 * and treating it as one puts an invisible stop at the top of the dialog. */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // offsetParent is null for display:none. A hidden control is a tab stop
    // that goes nowhere visible, which reads as the dialog swallowing a press.
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Wire up a modal dialog: focus moves in on open, Tab cycles inside it,
 * Escape closes it, and focus returns to whatever opened it.
 *
 * Attach the returned ref to the element carrying `role="dialog"`. Intended
 * for dialogs that are MOUNTED only while open, which is how every dialog in
 * this app is rendered.
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  // Held in a ref so changing the handler identity cannot re-run the effect
  // and re-steal focus out from under the student mid-interaction.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Captured BEFORE focus moves, so it is the control the student actually
    // pressed rather than whatever the dialog focuses first.
    const opener = document.activeElement as HTMLElement | null;

    // Prefer an element that asks for focus; otherwise the first tab stop;
    // otherwise the dialog itself, so focus is at least inside it.
    const initial =
      node.querySelector<HTMLElement>("[data-autofocus]") ?? focusable(node)[0] ?? node;
    if (initial === node && !node.hasAttribute("tabindex")) node.setAttribute("tabindex", "-1");
    initial.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;

      const stops = focusable(node);
      if (!stops.length) {
        // Nothing to move to: keep focus on the dialog rather than letting it
        // fall through to the page behind.
        e.preventDefault();
        node.focus();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement as HTMLElement | null;

      // Wrap at both ends. The `!node.contains(active)` case covers focus
      // having already escaped (a stray programmatic focus, say) -- pull it
      // back rather than leaving the student outside a modal dialog.
      if (!active || !node.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Only restore if the opener is still on the page and focus has not
      // already been deliberately placed somewhere else. Forcing it would
      // yank focus back from whatever the closing action opened next.
      if (opener && opener.isConnected && typeof opener.focus === "function") {
        const active = document.activeElement;
        if (!active || active === document.body || node.contains(active)) opener.focus();
      }
    };
  }, []);

  return ref;
}
