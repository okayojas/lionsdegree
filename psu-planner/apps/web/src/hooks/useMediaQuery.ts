/** Subscribe to a media query from React.
 *
 * Exists so a component can decline to emit a style that only makes sense on
 * one kind of device. An inline style beats every stylesheet rule, so a
 * component that always emits one leaves CSS no way to adapt except
 * `!important` -- which is how the drag-resized advisor panel ended up
 * pushing 90px of the plan off the side of a phone. */
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    // Guarded for the non-browser case so this stays safe to import anywhere.
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    // Re-read on subscribe: the query can have changed between the initial
    // render and this effect (a rotation, or a resize during hydration).
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** The one layout breakpoint. Phone-shaped, whatever the device calls itself.
 *
 * Kept here rather than repeated as a literal so the stylesheet and the
 * components that have to agree with it cannot drift apart; `styles.css`
 * names the same number in its PHONE section. */
export const PHONE_QUERY = "(max-width: 760px)";
