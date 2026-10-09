/** The shell every modal shares: the dimmed overlay, the panel, and the
 * keyboard contract from `useDialog` (focus in, Tab trapped, Escape closes,
 * focus restored to whatever opened it).
 *
 * It exists because four dialogs were written inline in App.tsx, each
 * repeating the overlay and panel markup and none of them handling Escape or
 * focus at all. A hook alone could not fix those: hooks cannot be called
 * conditionally, and the dialogs are rendered inside `{open && ...}`. */
import type { CSSProperties, ReactNode } from "react";
import { useDialog } from "../hooks/useDialog";

export function Dialog({
  label,
  onClose,
  children,
  style,
}: {
  /** The accessible name. A dialog without one is announced as just "dialog". */
  label: string;
  onClose: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const ref = useDialog<HTMLDivElement>(onClose);
  return (
    // mousedown rather than click: a click that STARTS inside the panel and
    // ends on the overlay (selecting text, then releasing past the edge)
    // would otherwise close the dialog and lose what the student was doing.
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={label} style={style}>
        {children}
      </div>
    </div>
  );
}
