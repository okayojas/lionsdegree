/** Flowchart canvas: port of the demo's render/pan/zoom/drag (L338-502) as a
 * React component using Pointer Events (mouse + touch). */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LAYOUT, ZOOM, cardStatus, clampView, columnFromX, computeEdges, credOf, defaultOrderKey,
  fitView, layoutColumns, offsetForFraction, panBounds, viewportFraction, worldSize, type PlanItem,
} from "@psu-planner/engine";
import { usePlanner } from "../store";
import { ViewControls } from "./ViewControls";

interface DragState {
  type: "pan" | "card";
  id?: string;
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  moved: boolean;
}

export function PlanCanvas({ onOpenItem }: { onOpenItem: (it: PlanItem) => void }) {
  const { plan, catalog, items, sched, mutatePlan, addTerm, deleteTerm, restoreTerm } = usePlanner();
  const vpRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(plan?.view ?? { x: 0, y: 0, k: 0.86 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [cardOffset, setCardOffset] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const numTerms = plan?.terms.length ?? 0;
  const { positions } = useMemo(() => layoutColumns(items, Math.max(numTerms, 1), defaultOrderKey), [items, numTerms]);
  const edges = useMemo(() => computeEdges(items, sched, catalog, positions), [items, sched, catalog, positions]);
  const { w: worldW, h: worldH } = useMemo(() => worldSize(Math.max(numTerms, 1), positions), [numTerms, positions]);

  const byCol = useMemo(() => {
    const cols: PlanItem[][] = Array.from({ length: Math.max(numTerms, 1) }, () => []);
    items.forEach((it) => cols[Math.max(0, Math.min(numTerms - 1, it.sem))]?.push(it));
    return cols;
  }, [items, numTerms]);

  // The slider positions are a function of the viewport size, so it has to
  // be state rather than read off the ref at render: a resize changes how
  // much of the plan is off-screen, and therefore where the handles sit.
  const [vp, setVp] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      setVp({ w: r.width, h: r.height });
    };
    sync();
    // Not window.resize: the viewport also changes when the side panel opens
    // or the toolbar wraps, neither of which resizes the window.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // First mount with no saved view: fit to content.
    if (!plan?.view && vpRef.current && items.length) {
      const r = vpRef.current.getBoundingClientRect();
      setView(fitView(worldW, worldH, r.width, r.height));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length > 0]);

  const persistView = (v: typeof view) => {
    mutatePlan((p) => { p.view = v; });
  };

  // Against worldW, not the drag-time effWorldW. The extra column that
  // appears while a card is in flight is a drop target, not plan content,
  // and having the slider range jump mid-drag would move the chart under
  // the card being dragged.
  const bounds = useMemo(
    () => panBounds(worldW, worldH, vp.w, vp.h, view.k),
    [worldW, worldH, vp.w, vp.h, view.k],
  );

  /** Apply a view change from a control: clamp it, and persist, since unlike
   * a drag there is no pointer-up to persist on. */
  const commitView = (next: { x: number; y: number; k: number }) => {
    const v = clampView(next, worldW, worldH, vp.w, vp.h);
    setView(v);
    persistView(v);
  };

  const onWheel = (e: React.WheelEvent) => {
    const k0 = view.k;
    const k = Math.min(ZOOM.MAX, Math.max(ZOOM.MIN, k0 * (e.deltaY < 0 ? 1.12 : 0.89)));
    const r = vpRef.current!.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    setView({ x: cx - (cx - view.x) * (k / k0), y: cy - (cy - view.y) * (k / k0), k });
  };

  /** Zoom about the CENTRE of the viewport. The wheel zooms about the
   * pointer, which is right for a wheel and wrong for a slider — there is no
   * pointer over the chart when the handle is being dragged, and anchoring
   * on the last known one throws the content off-screen. */
  const zoomTo = (kRaw: number) => {
    const k0 = view.k;
    const k = Math.min(ZOOM.MAX, Math.max(ZOOM.MIN, kRaw));
    const cx = vp.w / 2, cy = vp.h / 2;
    commitView({ x: cx - (cx - view.x) * (k / k0), y: cy - (cy - view.y) * (k / k0), k });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const cardEl = (e.target as Element).closest?.(".card") as HTMLElement | null;
    if (cardEl) {
      const id = cardEl.dataset.id!;
      const p = positions[id];
      setDrag({ type: "card", id, sx: e.clientX, sy: e.clientY, ox: p?.x ?? 0, oy: p?.y ?? 0, moved: false });
    } else {
      setDrag({ type: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    const moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 5;
    if (moved !== drag.moved) setDrag({ ...drag, moved });
    if (drag.type === "pan") {
      setView((v) => ({ ...v, x: drag.ox + dx, y: drag.oy + dy }));
    } else if (moved && drag.id) {
      setCardOffset({ id: drag.id, dx: dx / view.k, dy: dy / view.k });
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.type === "pan") {
      if (d.moved) persistView(view);
      return;
    }
    const it = items.find((x) => x.id === d.id);
    setCardOffset(null);
    if (!d.moved) {
      if (it) onOpenItem(it);
      return;
    }
    if (it && cardOffset) {
      const worldX = d.ox + cardOffset.dx;
      // Dropped in the space past the last term → make a new term and
      // place the card there.
      const rawCol = Math.round((worldX - LAYOUT.LEFT) / (LAYOUT.COLW + LAYOUT.GAP));
      if (rawCol >= numTerms) {
        const newIdx = addTerm();
        if (newIdx >= 0) mutatePlan((p) => { p.moves[it.id] = newIdx; });
      } else {
        const ci = columnFromX(worldX, numTerms);
        if (ci !== it.sem) mutatePlan((p) => { p.moves[it.id] = ci; });
      }
    }
  };

  if (!plan) return null;
  const { COLW, GAP, CARDH, TOP, LEFT } = LAYOUT;

  // While a card is dragged, reveal a "+ term" dropzone just past the last
  // term; dropping there creates a new term (see onPointerUp).
  const draggingCard = !!cardOffset;
  const addZoneX = LEFT + numTerms * (COLW + GAP);
  const draggedX = cardOffset ? (positions[cardOffset.id]?.x ?? 0) + cardOffset.dx : 0;
  const addZoneActive = draggingCard && Math.round((draggedX - LEFT) / (COLW + GAP)) >= numTerms;
  const effWorldW = worldW + (draggingCard ? COLW + GAP : 0);

  // Each target course gets a stable hue so its incoming prereq lines read as
  // one visual group; violations stay red, concurrent stays dashed.
  const edgeColor = (e: { to: string; bad: boolean }): string => {
    if (e.bad) return "#dc2626";
    let h = 0;
    for (let i = 0; i < e.to.length; i++) h = (h * 31 + e.to.charCodeAt(i)) >>> 0;
    // Per-course route hues. Violet (around 275) is deliberately absent: the
    // accent is the logo's blue, and a violet route line was the last of the
    // old palette still rendering. Spread around the wheel so adjacent
    // courses stay distinguishable.
    const HUES = [215, 158, 30, 340, 100, 190, 15, 130, 45, 175];
    return `hsl(${HUES[h % HUES.length]}, 55%, 42%)`;
  };

  return (
    <div
      ref={vpRef}
      className={`viewport${drag?.type === "pan" ? " panning" : ""}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <ViewControls
        xFraction={viewportFraction(view.x, bounds.minX, bounds.maxX)}
        yFraction={viewportFraction(view.y, bounds.minY, bounds.maxY)}
        zoom={view.k}
        onPanX={(f) => commitView({ ...view, x: offsetForFraction(f, bounds.minX, bounds.maxX) })}
        onPanY={(f) => commitView({ ...view, y: offsetForFraction(f, bounds.minY, bounds.maxY) })}
        onZoom={zoomTo}
        onFit={() => commitView(fitView(worldW, worldH, vp.w, vp.h))}
        connectHref="/connect/"
      />
      <div className="world" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})`, width: effWorldW, height: worldH }}>
        <svg className="edges" width={effWorldW} height={worldH}>
          <defs>
            {/* context-stroke makes the arrowhead inherit each path's color */}
            <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const focus = hoverId ?? cardOffset?.id ?? null;
            const connected = focus !== null && (e.from === focus || e.to === focus);
            const dimmed = focus !== null && !connected;
            return (
              <path
                key={i}
                d={e.d}
                fill="none"
                stroke={edgeColor(e)}
                strokeWidth={connected ? (e.bad ? 3.4 : 3) : e.bad ? 2.8 : 2}
                strokeDasharray={e.concurrent ? "6 5" : undefined}
                markerEnd="url(#arr)"
                opacity={dimmed ? 0.12 : connected ? 1 : e.bad ? 0.95 : 0.75}
              />
            );
          })}
        </svg>
        {plan.terms.map((term, ci) => {
          const cr = byCol[ci]?.reduce((s, it) => s + credOf(it, catalog), 0) ?? 0;
          const stop = (e: React.PointerEvent) => e.stopPropagation();
          return (
            <div key={ci} className={`col-header${term.gap ? " gap" : ""}`} style={{ left: LEFT + ci * (COLW + GAP), top: TOP, width: COLW }}>
              {term.label}
              {term.gap ? (
                <>
                  {/* A Gap Term is INTENTIONALLY empty -- that is what makes it
                      a Gap Term rather than a term you have not filled in yet,
                      and the copy has to carry the difference. */}
                  <span className="cr">Gap term — intentionally left empty</span>
                  <button
                    className="col-act"
                    onPointerDown={stop}
                    onClick={() => void restoreTerm(ci)}
                    title={`Use ${term.label} instead of leaving it empty`}
                  >
                    Use this term
                  </button>
                </>
              ) : (
                <>
                  <span className="cr">{cr.toFixed(1).replace(/\.0$/, "")} credits planned</span>
                  <button
                    className="col-act"
                    onPointerDown={stop}
                    onClick={() => {
                      if (confirm(`Skip ${term.label}? Your courses move to later terms and this one stays intentionally empty (e.g. a gap year). Graduation moves back one term.`)) {
                        void deleteTerm(ci);
                      }
                    }}
                    title={`Skip ${term.label} — a co-op, leave or gap year`}
                  >
                    ✕ Skip term
                  </button>
                </>
              )}
            </div>
          );
        })}
        {draggingCard && (
          <div
            className={`add-zone${addZoneActive ? " active" : ""}`}
            style={{ left: addZoneX, top: TOP + 6, width: COLW, height: worldH - TOP - 40 }}
          >
            <span>+ New term</span>
          </div>
        )}
        {items.map((it) => {
          const p = positions[it.id];
          if (!p) return null;
          const off = cardOffset?.id === it.id ? cardOffset : null;
          const c = it.code ? catalog[it.code] : undefined;
          // The live catalog is the authority: a plan generated while a subject
          // was missing bakes unverified:true into its items, but once the
          // course exists in the catalog it is verified — self-heal stale flags.
          const unverified = it.kind === "course" && !c;
          const overridden = it.kind === "course" && it.code ? !!plan.prereqOverrides?.[it.code] : false;
          // An adviser-confirmed prereq override clears a warn/bad flag to OK.
          const status = unverified ? "none" : overridden ? "ok" : cardStatus(catalog, it, sched);
          const done = it.kind === "course" && it.code ? !!plan.completed[it.code] : false;
          return (
            <div
              key={it.id}
              data-id={it.id}
              onPointerEnter={() => setHoverId(it.id)}
              onPointerLeave={() => setHoverId((h) => (h === it.id ? null : h))}
              className={[
                "card",
                it.kind === "slot" ? "slot st-none" : `st-${status}`,
                unverified ? "unverified" : "",
                overridden ? "overridden" : "",
                done ? "done" : "",
                off ? "dragging" : "",
              ].join(" ")}
              style={{ left: p.x + (off?.dx ?? 0), top: p.y + (off?.dy ?? 0), width: COLW, height: CARDH }}
            >
              {it.kind === "slot" ? (
                <>
                  <div className="code"><span className="dot" />{it.slot} — open slot</div>
                  <div className="title">{it.slotLabel ?? "Requirement"} · click to fill</div>
                  <div className="cr">{it.credits ?? "?"} credits</div>
                </>
              ) : (
                <>
                  <div className="code"><span className="dot" />{c?.display ?? it.code}</div>
                  <div className="title">{unverified ? "⚠ not in course catalog — verify" : c?.title}</div>
                  <div className="cr">
                    {c?.credits ?? ""}
                    {(it.alternatives?.length ?? 0) > 0 && (
                      <span> · or {it.alternatives!.slice(0, 2).map((a) => a.replace(/^\S+ /, "")).join("/")}{it.alternatives!.length > 2 ? "…" : ""}</span>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
