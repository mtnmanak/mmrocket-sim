import { GlossaryHelp } from './GlossaryHelp.js';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { niceStep, siToUi, uiToSi } from '../prefs/units.js';
import { finOutlineProblem } from '../tree/finOutline.js';
import { arrowPan, startsGesture, wheelZoomFactor } from '../chartPanZoom.js';
import { FIN_VIEW_W as VIEW_W, FIN_VIEW_H as VIEW_H, fitFin as makeTransform,
  finToScreen as toScreen, screenToFin as toModel, panFin, zoomFin,
  type FinTransform as Transform } from './finViewport.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';

/**
 * Freeform fin planform editor: a visual editor and a coordinate table over
 * ONE data model (the node's `points`, SI meters, fin-local frame: x aft
 * along the root from the leading edge, y outward from the body surface).
 *
 * Interactions:
 *  - drag a point to move it (updates live once past a few px of click
 *    jitter; commits one undo step on release, and none if nothing moved)
 *  - click empty canvas: inserts a point into the nearest edge
 *  - drag empty canvas or shift-drag anywhere: pans the view
 *  - wheel or two-finger pinch/pan: zooms/moves the view, never the points
 *  - double-click a point to delete it
 *  - the table edits the same points; both views always agree
 *
 * Invariants (mirroring the engine's FreeformFinSet):
 *  - point 1 is locked at (0,0) — the leading root corner
 *  - the last point stays on the body line (y = 0), draggable along x
 *  - y >= 0 for all points; minimum 3 points
 */

export type FinPoint = [number, number];

const HIT_RADIUS = 12; // screen px, generous grab target
/** Client px a press may wander before it moves a point: a physical click
 *  jitters 1-3 px. The same 4 px the 2D side view gives a click (its PAN_SLOP). */
const PRESS_SLOP = 4;
/**
 * The outline shown for a set with fewer than 3 points. Module-level so its
 * identity is stable: built inline it was a fresh array every render, which
 * re-ran the two `[committed]` memos below on every render. FROZEN because it
 * is now shared: "+ Add point" emits an outline that reuses its tuples, and a
 * consumer writing into those would otherwise redraw the next set's starter
 * (FinPointsEditor.test.tsx pins that it cannot).
 */
const STARTER_OUTLINE: FinPoint[] = [[0, 0], [0.02, 0.03], [0.05, 0]];
for (const p of STARTER_OUTLINE) Object.freeze(p);
Object.freeze(STARTER_OUTLINE);

/** The press this editor is following — see onPointerMove. */
interface Press {
  /** The pointer that owns it; every other pointer's events are ignored. */
  pointerId: number;
  x: number;
  y: number;
  /** Past PRESS_SLOP yet. Until then the point stays exactly where it was. */
  active: boolean;
  kind: 'point' | 'empty' | 'pan';
  screen: FinPoint;
  transform: Transform;
  capture: Element;
}

// Point edits follow startsGesture, the drawings' primary-pointer/button rule.
// A second touch pointer belongs only to the view gesture (N019).

const samePoints = (a: FinPoint[], b: FinPoint[]): boolean =>
  a.length === b.length && a.every((p, i) => p[0] === b[i]![0] && p[1] === b[i]![1]);

/** Index of the edge (segment i -> i+1) closest to screen point s. */
function nearestEdge(t: Transform, pts: FinPoint[], s: [number, number]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = toScreen(t, pts[i]!);
    const b = toScreen(t, pts[i + 1]!);
    const d = distToSegment(s, a, b);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function distToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1,
    ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const px = a[0] + u * dx - p[0];
  const py = a[1] + u * dy - p[1];
  return Math.sqrt(px * px + py * py);
}

export function FinPointsEditor({ points, onChange }: {
  points: FinPoint[];
  onChange: (next: FinPoint[]) => void;
}) {
  const { prefs } = usePrefs();
  const committed: FinPoint[] = points.length >= 3 ? points : STARTER_OUTLINE;

  // Live points during a drag (null = not dragging → render committed).
  const [livePts, setLivePts] = useState<FinPoint[] | null>(null);
  const pts = livePts ?? committed;
  /**
   * The same live points, current as of the last POINTER EVENT rather than the
   * last render (audit 2026-09-22). The release used to commit `livePts` from
   * its own render's closure, so a move and a release landing in one frame —
   * nothing renders between them — committed the outline from before the move.
   * Every write goes through showLive, so the two cannot disagree.
   */
  const liveRef = useRef<FinPoint[] | null>(null);
  const showLive = (next: FinPoint[] | null) => {
    liveRef.current = next;
    setLivePts(next);
  };
  const press = useRef<Press | null>(null);
  const [panning, setPanning] = useState(false);

  // The transform follows committed points but FREEZES during a drag so the
  // canvas doesn't rescale under the pointer.
  const layoutTransform = useMemo(() => makeTransform(committed), [committed]);
  const frozenTransform = useRef<Transform | null>(null);
  const [view, setView] = useState<Transform | null>(null);
  const viewRef = useRef<Transform | null>(null);
  const currentView = () => viewRef.current ?? layoutTransform;
  const showView = (next: Transform | null) => {
    viewRef.current = next;
    setView(next);
  };
  const t = frozenTransform.current ?? view ?? layoutTransform;
  const helpId = useId();

  const touches = useRef(new Map<number, FinPoint>());
  const pinch = useRef<{ ids: [number, number]; transform: Transform; center: FinPoint; distance: number } | null>(null);
  // After a pinch ends, the remaining finger must lift before it can edit.
  const touchView = useRef(false);

  const svgRef = useRef<SVGSVGElement>(null);
  const dragIndex = useRef<number | null>(null);
  // Row being edited in the table — its dot lights up in the canvas.
  const [hotRow, setHotRow] = useState<number | null>(null);
  // Why the last edit was refused, shown under the table (null = nothing wrong).
  const [refused, setRefused] = useState<string | null>(null);

  const committedProblem = useMemo(() => finOutlineProblem(committed), [committed]);
  // What is on screen right now — the live drag if there is one. Drives the red
  // outline, so a crossing shows up under the pointer before the user lets go.
  const shownProblem = livePts ? finOutlineProblem(livePts) : committedProblem;

  /**
   * Commit an edited point array, unless the edit is what breaks the outline.
   *
   * A self-intersecting or duplicate-point outline is not a cosmetic problem
   * here: the kernel refuses it, so `OrkRocket.buildTree` throws (naming the
   * fin set) and App.tsx blanks the whole design — no mass, CG, CP, stability, stats,
   * exports or Launch — until the user undoes an edit that looked fine on the
   * canvas. See tree/finOutline.ts for the mechanism and the kernel citation.
   *
   * The `!committedProblem` half matters as much as the check: if a design
   * ARRIVED broken (saved before this guard existed, or hand-edited .ork),
   * refusing every edit would trap the user in the exact state they are trying
   * to edit their way out of. Then we let the edit through and just say so.
   */
  const commit = (next: FinPoint[]): boolean => {
    const problem = finOutlineProblem(next);
    if (problem && !committedProblem) {
      setRefused(problem);
      return false;
    }
    setRefused(problem);
    onChange(next);
    return true;
  };

  const clientToSvg = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = svgRef.current!.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * VIEW_W,
      ((e.clientY - rect.top) / rect.height) * VIEW_H,
    ];
  };

  /** Apply invariants to a moved point. */
  const constrain = (i: number, p: FinPoint, count: number): FinPoint => {
    if (i === 0) return [0, 0];
    const x = p[0];
    const y = i === count - 1 ? 0 : Math.max(0, p[1]);
    return [x, y];
  };

  /** Starts following a press of point `index`, showing `start` meanwhile. */
  const beginDrag = (index: number, start: FinPoint[], e: React.PointerEvent) => {
    const transform = currentView();
    frozenTransform.current = transform;
    dragIndex.current = index;
    press.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, active: false,
      kind: 'point', screen: clientToSvg(e), transform, capture: e.currentTarget };
    showLive(start);
    // N019: keep an unmoved press/release on the point so dblclick reaches it.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const beginViewPress = (kind: 'pan' | 'empty', e: React.PointerEvent) => {
    setPanning(kind === 'pan');
    press.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, active: false,
      kind, screen: clientToSvg(e), transform: currentView(), capture: svgRef.current! };
    svgRef.current!.setPointerCapture?.(e.pointerId);
  };

  const touchPair = (ids: [number, number]) => {
    const a = touches.current.get(ids[0]);
    const b = touches.current.get(ids[1]);
    if (!a || !b) return null;
    return { center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as FinPoint,
      distance: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  };

  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch' || e.button !== 0) return;
    touches.current.set(e.pointerId, clientToSvg(e));
    if (touches.current.size !== 2) return;
    // N019: a second finger cancels a tentative point edit, never drops it.
    clearPress(false);
    const ids = [...touches.current.keys()] as [number, number];
    const pair = touchPair(ids)!;
    pinch.current = { ...pair, ids, transform: currentView() };
    touchView.current = true;
    for (const id of touches.current.keys()) svgRef.current!.setPointerCapture?.(id);
  };

  const onPointerDownPoint = (index: number) => (e: React.PointerEvent) => {
    if (touchView.current || !startsGesture(e) || press.current) return;
    e.stopPropagation();
    if (e.shiftKey) { beginViewPress('pan', e); return; }
    if (index === 0) return; // locked origin
    beginDrag(index, committed.map((p) => [...p] as FinPoint), e);
  };

  const onPointerDownCanvas = (e: React.PointerEvent) => {
    if (touchView.current || !startsGesture(e) || press.current) return;
    if (e.shiftKey) { beginViewPress('pan', e); return; }
    const s = clientToSvg(e);
    // Ignore clicks that land on an existing point (their handler runs instead).
    for (let i = 0; i < committed.length; i++) {
      const [sx, sy] = toScreen(currentView(), committed[i]!);
      if (Math.hypot(s[0] - sx, s[1] - sy) < HIT_RADIUS) return;
    }
    // Wait for release to insert: movement past click slop means view pan.
    beginViewPress('empty', e);
  };

  /**
   * Moves the pressed point — once the press has travelled past PRESS_SLOP
   * (audit 2026-09-22). It used to move from the first pixel, so the 1-3 px an
   * ordinary click wanders dragged the point with it, and the release then
   * committed that as an edit.
   */
  const onPointerMove = (e: React.PointerEvent) => {
    if (touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, clientToSvg(e));
      const start = pinch.current;
      const pair = start && start.ids.includes(e.pointerId) ? touchPair(start.ids) : null;
      if (start && pair) {
        const zoomed = zoomFin(start.transform, start.center,
          start.distance > 0 ? pair.distance / start.distance : 1, layoutTransform.scale);
        showView(panFin(zoomed, [pair.center[0] - start.center[0], pair.center[1] - start.center[1]]));
        return;
      }
      if (touchView.current) return;
    }
    const p = press.current;
    if (!p || e.pointerId !== p.pointerId) return;
    // Primary button up mid-drag: a release this editor never saw (the macOS
    // context menu swallows it). End it as the release it was.
    if ((e.buttons & 1) === 0) { endDrag(e); return; }
    if (!p.active) {
      if (Math.abs(e.clientX - p.x) <= PRESS_SLOP && Math.abs(e.clientY - p.y) <= PRESS_SLOP) return;
      p.active = true;
    }
    if (p.kind !== 'point') {
      p.kind = 'pan';
      setPanning(true);
      const s = clientToSvg(e);
      showView(panFin(p.transform, [s[0] - p.screen[0], s[1] - p.screen[1]]));
      return;
    }
    if (dragIndex.current === null || !frozenTransform.current) return;
    const i = dragIndex.current;
    const model = toModel(frozenTransform.current, clientToSvg(e));
    const base = liveRef.current ?? committed;
    showLive(base.map((q, j) => (j === i ? constrain(i, model, base.length) : q)));
  };

  /** Drops the press without committing; the canvas snaps back to `committed`. */
  const clearPress = (releaseCapture = true) => {
    const pointerId = press.current?.pointerId;
    const capture = press.current?.capture;
    press.current = null;
    setPanning(false);
    dragIndex.current = null;
    frozenTransform.current = null;
    showLive(null);
    if (releaseCapture && pointerId != null && capture?.hasPointerCapture?.(pointerId)) {
      capture.releasePointerCapture(pointerId);
    }
  };

  const finishTouch = (e: React.PointerEvent): boolean => {
    if (!touches.current.delete(e.pointerId)) return false;
    const consumed = touchView.current;
    // N019: an extra finger lifting must not stop the original pair's view gesture.
    if (pinch.current?.ids.includes(e.pointerId)) pinch.current = null;
    if (touches.current.size === 0) touchView.current = false;
    if (consumed && svgRef.current?.hasPointerCapture?.(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    return consumed;
  };

  const endDrag = (e: React.PointerEvent) => {
    if (finishTouch(e)) return;
    if (press.current?.pointerId !== e.pointerId) return;
    const p = press.current;
    if (p.kind === 'empty') {
      const edge = nearestEdge(p.transform, committed, p.screen);
      const model = constrain(edge + 1, toModel(p.transform, p.screen), committed.length + 1);
      commit([...committed.slice(0, edge + 1), model, ...committed.slice(edge + 1)]);
    }
    // A refused commit leaves `committed` alone and clearPress() below snaps
    // the canvas back to it — the "restore the previous array" half of the
    // guard, so a crossing outline never reaches buildTree.
    //
    // And ONLY a real change commits: a click that moved nothing used to
    // commit an identical array, which is still an undo step — two of them
    // for the double-click that deletes a point. An inserted point is a real
    // change even when the press never moved, so it still commits.
    const live = liveRef.current;
    if (dragIndex.current !== null && live && !samePoints(live, committed)) {
      commit(live); // single undo step
    }
    clearPress();
  };

  /** The browser took the gesture over (pointercancel, lost capture). A
   *  cancelled drag is not a drop: nothing commits. */
  const cancelDrag = (e: React.PointerEvent) => {
    if (finishTouch(e)) return;
    if (press.current?.pointerId !== e.pointerId) return;
    clearPress();
  };

  const viewBusy = () => press.current !== null || touches.current.size > 0;
  const zoomView = (factor: number, focus: FinPoint = [VIEW_W / 2, VIEW_H / 2]) => {
    if (viewBusy()) return;
    showView(zoomFin(currentView(), focus, factor, layoutTransform.scale));
  };
  const fitView = () => { if (!viewBusy()) showView(null); };

  // Like the other drawings, own wheel scrolling only when the view changes.
  // React's delegated wheel listener is passive in browsers, so use a local one.
  useEffect(() => {
    const svg = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (viewBusy()) return;
      const before = currentView();
      const next = zoomFin(before, clientToSvg(e), 1 / wheelZoomFactor(e), layoutTransform.scale);
      if (next.scale === before.scale) return;
      e.preventDefault();
      showView(next);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { pinch.current = null; clearPress(); return; }
    if (viewBusy() || e.ctrlKey || e.metaKey || e.altKey) return;
    const delta = arrowPan(e.key);
    if (delta) showView(panFin(currentView(), [delta[0] * 20, delta[1] * 20]));
    else if (e.key === '+' || e.key === '=') zoomView(1 / wheelZoomFactor({ deltaY: -100 }));
    else if (e.key === '-') zoomView(wheelZoomFactor({ deltaY: -100 }));
    else if (e.key === '0' || e.key === 'Home') fitView();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const removePoint = (i: number) => {
    if (pts.length <= 3 || i === 0 || i === pts.length - 1) return;
    // Deleting a point can cross the outline too — the kernel's own
    // removePoint() rolls back for exactly this reason (FreeformFinSet.java:229).
    commit(committed.filter((_, j) => j !== i));
  };

  // Coordinate table in the user's rocket-dimension unit (engine stays SI).
  const lenSym = prefs.units.length;
  const toUi = (si: number) => Number(siToUi('length', lenSym, si).toFixed(4));
  const tableStep = niceStep(siToUi('length', lenSym, 0.001));

  const setPoint = (i: number, axis: 0 | 1, uiValue: number) => {
    if (!Number.isFinite(uiValue)) return;
    const next = committed.map((p, j) => {
      if (j !== i) return [...p] as FinPoint;
      const q: FinPoint = [...p];
      q[axis] = uiToSi('length', lenSym, uiValue);
      return constrain(i, q, committed.length);
    });
    next[0] = [0, 0];
    commit(next);
  };

  const addPoint = () => {
    const a = committed[committed.length - 2]!;
    const b = committed[committed.length - 1]!;
    const mid: FinPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    commit([...committed.slice(0, committed.length - 1), mid, committed[committed.length - 1]!]);
  };

  const polygon = pts.map((p) => toScreen(t, p).join(',')).join(' ');
  const bodyY = toScreen(t, [0, 0])[1];

  return (
    <div style={{ marginTop: 10 }}>
      <h2 className="field-label-help">Fin planform <GlossaryHelp term="fin-outline-coordinates" label="Fin planform" /></h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        <button className="file-btn" onClick={() => zoomView(1 / wheelZoomFactor({ deltaY: -100 }))}>Zoom in</button>
        <button className="file-btn" onClick={() => zoomView(wheelZoomFactor({ deltaY: -100 }))}>Zoom out</button>
        <button className="file-btn" onClick={fitView}>Fit view</button>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          style={{ width: '100%', height: 'auto', background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 6, touchAction: 'none', cursor: panning ? 'grabbing' : 'crosshair' }}
          // role="group", not "img" — the fix TreeSchematic's interactive <svg> `role` documents
          // and applies to its own interactive variant. role="img" makes the
          // WHOLE subtree presentational, so this label was promising a reader
          // an affordance ("click to add points, drag to move them") that
          // assistive tech could not reach, on an element whose own children
          // are the shapes being described (2026-09-08 audit).
          role="group"
          tabIndex={0}
          aria-label="Fin planform, drawn. Arrow keys pan; plus and minus zoom; 0 fits the view. Points are edited in the coordinate table below this drawing."
          aria-describedby={helpId}
          onKeyDown={onKeyDown}
          onPointerDownCapture={onPointerDownCapture}
          onPointerDown={onPointerDownCanvas}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={cancelDrag}
          onLostPointerCapture={(e) => {
            // N019: transferring a point's capture to the pinch surface is not cancellation.
            if (e.target !== svgRef.current && touchView.current) return;
            cancelDrag(e);
          }}>
        {/* body surface line */}
        <line x1={0} y1={bodyY} x2={VIEW_W} y2={bodyY} stroke="#9a978f" strokeWidth="3" />
        <text x={4} y={bodyY + 12} fontSize="9" fill="var(--text-muted)">body tube</text>
        {/* fin polygon — red while the outline is one the kernel would refuse */}
        <polygon points={polygon}
          fill={shownProblem ? '#e34948' : '#b9b7b0'} fillOpacity={shownProblem ? 0.35 : 0.75}
          stroke={shownProblem ? '#e34948' : '#7a786f'} strokeWidth="1.5"
          style={{ pointerEvents: 'none' }} />
        {/* points: generous invisible hit circle + visible dot */}
        {pts.map((p, i) => {
          const [sx, sy] = toScreen(t, p);
          const locked = i === 0;
          const draggingThis = dragIndex.current === i;
          const hot = hotRow === i || draggingThis;
          return (
            <g key={i}>
              <circle cx={sx} cy={sy} r={HIT_RADIUS} fill="transparent"
                style={{ cursor: locked ? 'not-allowed' : 'grab' }}
                onPointerDown={onPointerDownPoint(i)}
                onDoubleClick={(e) => { if (!e.shiftKey && !touchView.current) removePoint(i); }} />
              {hot && (
                <circle cx={sx} cy={sy} r={9} fill="none" stroke="#e3a008"
                  strokeWidth="2" style={{ pointerEvents: 'none' }} />
              )}
              <circle cx={sx} cy={sy} r={hot ? 6 : 4.5}
                fill={locked ? '#7a786f' : draggingThis ? '#e34948' : hot ? '#e3a008' : '#2a78d6'}
                stroke="#fff" strokeWidth="1.5" style={{ pointerEvents: 'none' }} />
              <text x={sx + 7} y={sy - 6} fontSize="9" fill="var(--text-secondary)"
                style={{ pointerEvents: 'none' }}>{i + 1}</text>
            </g>
          );
        })}
      </svg>

      <table className="fin-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">x <UnitChip quantity="length" /> <GlossaryHelp term="fin-outline-coordinates" label="Fin point x" /></th>
            <th scope="col">y <UnitChip quantity="length" /> <GlossaryHelp term="fin-outline-coordinates" label="Fin point y" /></th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {pts.map((p, i) => {
            const first = i === 0;
            const last = i === pts.length - 1;
            return (
              <tr key={i}
                onFocusCapture={() => setHotRow(i)}
                onBlurCapture={() => setHotRow((prev) => (prev === i ? null : prev))}>
                <td>{i + 1}</td>
                <td>
                  {first
                    ? <input value={0} disabled
                        aria-label={`Point ${i + 1} x (fixed at the root leading edge)`} />
                    : <NumField value={toUi(p[0])} step={tableStep} allowNegative
                        ariaLabel={`Point ${i + 1} x`}
                        onCommit={(v) => { if (v !== null) setPoint(i, 0, v); }} />}
                </td>
                <td>
                  {first || last
                    ? <input value={0} disabled
                        aria-label={`Point ${i + 1} y (fixed on the body)`}
                        title={last ? 'Trailing corner stays on the body (y = 0)' : undefined} />
                    : <NumField value={toUi(p[1])} step={tableStep}
                        ariaLabel={`Point ${i + 1} y`}
                        onCommit={(v) => { if (v !== null) setPoint(i, 1, v); }} />}
                </td>
                <td>
                  <button className="fin-row-del" disabled={first || last || pts.length <= 3}
                    title="Remove point" aria-label={`Remove point ${i + 1}`}
                    onClick={() => removePoint(i)}>✕</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="file-btn" style={{ marginTop: 6 }} onClick={addPoint}>
        + Add point
      </button>
      {/* The status token, not the hard-coded red this line had (audit
          2026-09-22): on the default dark theme's panel that red was 2.95:1;
          the token is 5.57:1 there, and AA in light and Daylight too. */}
      {refused && (
        <p role="alert" style={{ fontSize: 11, color: 'var(--status-serious)', margin: '6px 0 0' }}>
          {refused}{committedProblem ? '' : ' The fin is unchanged.'}
        </p>
      )}
      <p id={helpId} style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
        Drag empty space or Shift-drag to pan. Use the wheel or pinch with two fingers
        to zoom; move two fingers together to pan. Use arrow keys to pan, + / − to
        zoom, and 0 to fit the view. These change the view only. Scroll the page
        outside the drawing. Click the canvas to add a point on the nearest edge · drag points to move
        them · double-click a point to delete it · refine exact values in the
        table. Point 1 is fixed at the origin; the last point stays on the body.
      </p>
    </div>
  );
}
