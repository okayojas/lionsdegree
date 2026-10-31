/** What the student looks at between pressing Build and seeing their chart.
 *
 * The button already said "Building your flowchart…", and that was not
 * enough: the work below the click is several seconds of main-thread
 * generating and optimizing, during which the page cannot repaint. The
 * label changed in state but never reached the screen, so the press looked
 * like it had done nothing at all. The fix is half here and half in
 * `generate` — it yields a frame so this can paint before the thread is
 * taken (see `nextPaint`).
 *
 * The stages are the real ones the build moves through, not a timed
 * animation pretending to be progress. Each is set immediately before the
 * work it names.
 *
 * The skeleton columns are the same grey blocks the chart's loading state
 * uses, so the wait and the thing being waited for look like one process.
 */
export type BuildStage = "reading" | "planning" | "optimizing";

const STEPS: { id: BuildStage; label: string }[] = [
  { id: "reading", label: "Reading the Bulletin" },
  { id: "planning", label: "Laying out your terms" },
  { id: "optimizing", label: "Checking every prerequisite" },
];

/** Yield until the browser has painted.
 *
 * One `requestAnimationFrame` only gets you to just before the next render;
 * the callback still runs before paint, so blocking inside it freezes the
 * frame you were trying to show. The second frame is the one that proves
 * the pixels landed. Falls back to a timeout where rAF does not exist, so
 * a non-browser environment does not hang here.
 */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function BuildOverlay({ stage, terms }: { stage: BuildStage; terms: number }) {
  const current = Math.max(0, STEPS.findIndex((s) => s.id === stage));

  // The columns draw themselves in one after another, and the stagger is a
  // CSS `animation-delay` rather than a chain of timers. THE TIMERS DID NOT
  // RUN: the build occupies the main thread for seconds at a stretch, which
  // is the entire reason this overlay exists, and a `setTimeout` cannot
  // fire while it is held -- the animation froze on column one for the
  // whole wait. A compositor animation on opacity and transform keeps going
  // regardless of what JavaScript is doing, which is the only kind of
  // movement that can honestly be promised here.
  //
  // It is deliberately NOT progress. The build cannot report a percentage,
  // and a bar that filled on a timer would be inventing one. This says the
  // page is alive; the step list below says where the work actually is.
  return (
    <div className="build-overlay" role="status" aria-live="polite">
      <div className="bo-card">
        <p className="bo-title">Building your flowchart</p>

        <div className="bo-grid" aria-hidden="true">
          {Array.from({ length: terms }, (_, i) => (
            <div key={i} className="bo-col" style={{ animationDelay: `${i * 130}ms` }}>
              {Array.from({ length: 3 + (i % 2) }, (_, j) => (
                <span key={j} className="bo-node" style={{ animationDelay: `${(i * 2 + j) * 90}ms` }} />
              ))}
            </div>
          ))}
        </div>

        <ol className="bo-steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={i < current ? "is-done" : i === current ? "is-now" : ""}>
              <span className="bo-tick" aria-hidden="true">{i < current ? "✓" : "•"}</span>
              {s.label}
            </li>
          ))}
        </ol>

        <p className="bo-note">
          This runs entirely in your browser — nothing about your plan is sent anywhere.
        </p>
      </div>
    </div>
  );
}
