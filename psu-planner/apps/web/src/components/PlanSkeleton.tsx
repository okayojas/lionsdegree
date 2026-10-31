/** The chart's shape, drawn before the catalog arrives.
 *
 * Loading the plan used to replace the whole screen with the words "Loading
 * your plan…" centred in an empty rectangle. It reads as a stalled app, and
 * on a cold cache it is what a student looks at for most of the wait.
 *
 * Everything needed to draw the LAYOUT is already in hand at that moment:
 * the saved plan carries its terms and how many items each one holds, and
 * none of that depends on the catalog — only the course codes, titles and
 * prerequisite arrows do. So the columns, the headers and a grey block per
 * course can all be on screen immediately, and the wait becomes a chart
 * filling in rather than a blank page.
 *
 * Positions come from `cardSlot`, the same function the real layout uses,
 * so the grey blocks are exactly where their cards will be. If they were
 * not, every card would visibly jump on arrival, which looks like a
 * rendering fault rather than a load completing.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { LAYOUT, cardSlot, fitView, worldSize, type PlanDoc } from "@psu-planner/engine";

export function PlanSkeleton({ plan }: { plan: PlanDoc | null }) {
  const { COLW, CARDH, TOP } = LAYOUT;
  const terms = plan?.terms ?? [];
  const ref = useRef<HTMLDivElement>(null);

  // Guess from the window, then correct from the real box in a LAYOUT
  // effect -- which runs before paint, so the correction is never seen.
  // Measuring in a plain effect would show one frame at the guessed scale
  // and then jump, and a skeleton that jumps is worse than no skeleton.
  const [box, setBox] = useState(() => ({
    w: typeof window === "undefined" ? 1200 : window.innerWidth,
    h: typeof window === "undefined" ? 700 : window.innerHeight - 48,
  }));
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r?.width) setBox({ w: r.width, h: r.height });
  }, []);

  // No saved plan means onboarding, not a chart — there is no shape to
  // promise yet, and inventing columns would be a lie about what is coming.
  if (!terms.length) {
    return <div className="loading" role="status">Loading your plan…</div>;
  }

  const counts = terms.map((t) => t.items?.length ?? 0);
  const rows = Math.max(1, ...counts);
  const last = cardSlot(terms.length - 1, rows - 1);
  const { w, h } = worldSize(terms.length, { end: last });
  // Scaled to fit, through the same `fitView` the real chart's first paint
  // uses, against the same box -- so the skeleton is at the zoom the plan
  // will actually appear at.
  const view = fitView(w, h, box.w, box.h);

  return (
    <div ref={ref} className="viewport plan-skeleton" aria-hidden="true">
      {/* One live announcement for the whole thing. The grid itself is
          aria-hidden: a screen reader has no use for a hundred empty boxes,
          and announcing them would bury the one sentence that matters. */}
      <p className="sr-only" role="status" aria-hidden="false">
        Loading your plan — {terms.length} terms.
      </p>
      <div className="world" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})`, width: w, height: h }}>
        {terms.map((term, ci) => (
          <div key={ci} className="col-header" style={{ left: cardSlot(ci, 0).x, top: TOP, width: COLW }}>
            {/* The term label is real — it comes from the saved plan, not
                from the catalog — so there is no reason to grey it out. */}
            {term.label}
            <span className="sk-row" style={{ width: "58%", marginTop: 6 }} />
          </div>
        ))}
        {terms.flatMap((term, ci) =>
          Array.from({ length: counts[ci] }, (_, ri) => {
            const p = cardSlot(ci, ri);
            return (
              <div
                key={`${ci}-${ri}`}
                className="card-skeleton"
                style={{
                  position: "absolute", left: p.x, top: p.y, width: COLW, height: CARDH,
                  // Staggered so the grid settles in a sweep rather than
                  // pulsing in unison, which reads as one object blinking.
                  animationDelay: `${((ci * 3 + ri) % 7) * 90}ms`,
                }}
              />
            );
          }),
        )}
      </div>
    </div>
  );
}
