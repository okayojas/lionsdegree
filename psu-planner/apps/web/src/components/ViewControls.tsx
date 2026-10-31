/** Pan and zoom controls mounted on the edges of the chart viewport.
 *
 * The chart could always be panned by dragging and zoomed by the wheel, and
 * neither is discoverable: nothing on screen said the canvas extended past
 * the frame, and a student on a trackpad who had never thought to drag a
 * diagram simply saw the part of their plan that happened to fit. Sliders
 * are the affordance — they show how much more there is by where the handle
 * sits, which a cursor change cannot.
 *
 * They sit OUTSIDE the panned world, as siblings of it, so they do not
 * scale, translate or clip with the content they drive.
 *
 * Range inputs rather than custom handles: keyboard, arrow keys, Home/End,
 * screen reader value announcements and touch targets all come free and
 * correct, and none of them would have been written by hand.
 */
import { ZOOM } from "@psu-planner/engine";

export interface ViewControlsProps {
  /** How far through the plan the viewport is looking, across: 0 is the
   * first term. See `viewportFraction` -- this deliberately is NOT the raw
   * view offset, which runs the other way. */
  xFraction: number;
  /** The same, down the plan: 0 is the top. */
  yFraction: number;
  zoom: number;
  onPanX: (fraction: number) => void;
  onPanY: (fraction: number) => void;
  onZoom: (k: number) => void;
  onFit: () => void;
  /** Where "Connect your AI" goes. Passed in so this component does not
   * reach for a route, and so the e2e test can assert the real href. */
  connectHref: string;
}

const STEP = 0.002;

export function ViewControls({
  xFraction, yFraction, zoom, onPanX, onPanY, onZoom, onFit, connectHref,
}: ViewControlsProps) {
  // Pointer events on a control must never reach the canvas underneath, or
  // grabbing a slider handle also starts a pan and the chart slides out from
  // under the gesture.
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div className="view-controls" onPointerDown={stop} onWheel={(e) => e.stopPropagation()}>
      {/* The one bright thing on the chart. Everything else here is a muted
          control; this is the single action we are actually asking for, so
          it gets the accent and nothing else competes with it. */}
      <a className="vc-connect" href={connectHref}>
        <span aria-hidden="true">✦</span> Connect your AI
      </a>

      <input
        type="range"
        className="vc-pan vc-pan-x"
        min={0}
        max={1}
        step={STEP}
        value={xFraction}
        onChange={(e) => onPanX(Number(e.target.value))}
        aria-label="Pan the flowchart left and right"
      />

      <input
        type="range"
        className="vc-pan vc-pan-y"
        min={0}
        max={1}
        step={STEP}
        // No inversion here: a vertical range puts its minimum at the top,
        // and fraction 0 already means "looking at the top of the plan", so
        // the two line up. The direction is handled once, in
        // `viewportFraction`, where it is tested.
        value={yFraction}
        onChange={(e) => onPanY(Number(e.target.value))}
        aria-label="Pan the flowchart up and down"
      />

      <div className="vc-zoom">
        <button type="button" onClick={() => onZoom(zoom / 1.2)} aria-label="Zoom out" title="Zoom out">−</button>
        <input
          type="range"
          className="vc-zoom-range"
          min={ZOOM.MIN}
          max={ZOOM.MAX}
          step={0.01}
          value={zoom}
          onChange={(e) => onZoom(Number(e.target.value))}
          aria-label="Zoom"
          // The percentage is what a student reads the control by; the raw
          // 0.25-2.2 scale means nothing to anyone.
          aria-valuetext={`${Math.round(zoom * 100)} percent`}
        />
        <button type="button" onClick={() => onZoom(zoom * 1.2)} aria-label="Zoom in" title="Zoom in">+</button>
        <button
          type="button"
          className="vc-fit"
          onClick={onFit}
          title="Fit the whole plan on screen"
          // "Fit" is enough sitting next to a zoom slider, and nowhere near
          // enough read out on its own with no surrounding context.
          aria-label="Fit the whole plan on screen"
        >
          Fit
        </button>
      </div>
    </div>
  );
}
