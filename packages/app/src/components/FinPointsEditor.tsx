import { useMemo, useRef, useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { niceStep, siToUi, uiToSi } from '../prefs/units.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';

/**
 * Freeform fin planform editor: a visual editor and a coordinate table over
 * ONE data model (the node's `points`, SI meters, fin-local frame: x aft
 * along the root from the leading edge, y outward from the body surface).
 *
 * Interactions:
 *  - drag a point to move it (updates live; commits one undo step on release)
 *  - click/drag on empty canvas: inserts a point into the nearest edge and
 *    immediately drags it (rough placement by click, refine in the table)
 *  - double-click a point to delete it
 *  - the table edits the same points; both views always agree
 *
 * Invariants (mirroring the engine's FreeformFinSet):
 *  - point 1 is locked at (0,0) — the leading root corner
 *  - the last point stays on the body line (y = 0), draggable along x
 *  - y >= 0 for all points; minimum 3 points
 */

export type FinPoint = [number, number];

const VIEW_W = 300;
const VIEW_H = 170;
const PAD = 22;
const HIT_RADIUS = 12; // screen px, generous grab target

interface Transform {
  scale: number;
  minX: number;
  minY: number;
}

function makeTransform(pts: FinPoint[]): Transform {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(0.01, ...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0.01, ...ys);
  const scale = Math.min(
    (VIEW_W - 2 * PAD) / (maxX - minX),
    (VIEW_H - 2 * PAD) / (maxY - minY),
  );
  return { scale, minX, minY };
}

function toScreen(t: Transform, [x, y]: FinPoint): [number, number] {
  return [PAD + (x - t.minX) * t.scale, VIEW_H - PAD - (y - t.minY) * t.scale];
}

function toModel(t: Transform, [sx, sy]: [number, number]): FinPoint {
  return [(sx - PAD) / t.scale + t.minX, (VIEW_H - PAD - sy) / t.scale + t.minY];
}

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
  const committed: FinPoint[] = points.length >= 3 ? points : [[0, 0], [0.02, 0.03], [0.05, 0]];

  // Live points during a drag (null = not dragging → render committed).
  const [livePts, setLivePts] = useState<FinPoint[] | null>(null);
  const pts = livePts ?? committed;

  // The transform follows committed points but FREEZES during a drag so the
  // canvas doesn't rescale under the pointer.
  const layoutTransform = useMemo(() => makeTransform(committed), [committed]);
  const frozenTransform = useRef<Transform | null>(null);
  const t = frozenTransform.current ?? layoutTransform;

  const svgRef = useRef<SVGSVGElement>(null);
  const dragIndex = useRef<number | null>(null);
  // Row being edited in the table — its dot lights up in the canvas.
  const [hotRow, setHotRow] = useState<number | null>(null);

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

  const beginDrag = (index: number, e: React.PointerEvent) => {
    frozenTransform.current = layoutTransform;
    dragIndex.current = index;
    setLivePts(committed.map((p) => [...p] as FinPoint));
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerDownPoint = (index: number) => (e: React.PointerEvent) => {
    if (index === 0) return; // locked origin
    e.stopPropagation();
    beginDrag(index, e);
  };

  const onPointerDownCanvas = (e: React.PointerEvent) => {
    // Insert a new point into the nearest edge, then drag it.
    const s = clientToSvg(e);
    // Ignore clicks that land on an existing point (their handler runs instead).
    for (let i = 0; i < committed.length; i++) {
      const [sx, sy] = toScreen(layoutTransform, committed[i]!);
      if (Math.hypot(s[0] - sx, s[1] - sy) < HIT_RADIUS) return;
    }
    const edge = nearestEdge(layoutTransform, committed, s);
    const model = constrain(edge + 1, toModel(layoutTransform, s), committed.length + 1);
    const inserted = [
      ...committed.slice(0, edge + 1),
      model,
      ...committed.slice(edge + 1),
    ];
    frozenTransform.current = layoutTransform;
    dragIndex.current = edge + 1;
    setLivePts(inserted);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragIndex.current === null || !frozenTransform.current) return;
    const i = dragIndex.current;
    const model = toModel(frozenTransform.current, clientToSvg(e));
    setLivePts((prev) => {
      const base = prev ?? committed;
      return base.map((p, j) => (j === i ? constrain(i, model, base.length) : p));
    });
  };

  const endDrag = () => {
    if (dragIndex.current !== null && livePts) {
      onChange(livePts); // single undo step
    }
    dragIndex.current = null;
    frozenTransform.current = null;
    setLivePts(null);
  };

  const removePoint = (i: number) => {
    if (pts.length <= 3 || i === 0 || i === pts.length - 1) return;
    onChange(committed.filter((_, j) => j !== i));
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
    onChange(next);
  };

  const addPoint = () => {
    const a = committed[committed.length - 2]!;
    const b = committed[committed.length - 1]!;
    const mid: FinPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    onChange([...committed.slice(0, committed.length - 1), mid, committed[committed.length - 1]!]);
  };

  const polygon = pts.map((p) => toScreen(t, p).join(',')).join(' ');
  const bodyY = toScreen(t, [0, 0])[1];

  return (
    <div style={{ marginTop: 10 }}>
      <h2>Fin planform</h2>
      <svg ref={svgRef} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          style={{ width: '100%', height: 'auto', background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 6, touchAction: 'none', cursor: 'crosshair' }}
          role="img" aria-label="Fin planform editor — click to add points, drag to move them"
          onPointerDown={onPointerDownCanvas}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}>
        {/* body surface line */}
        <line x1={0} y1={bodyY} x2={VIEW_W} y2={bodyY} stroke="#9a978f" strokeWidth="3" />
        <text x={4} y={bodyY + 12} fontSize="9" fill="var(--text-muted)">body tube</text>
        {/* fin polygon */}
        <polygon points={polygon} fill="#b9b7b0" fillOpacity="0.75" stroke="#7a786f" strokeWidth="1.5"
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
                onDoubleClick={() => removePoint(i)} />
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
            <th>#</th>
            <th>x <UnitChip quantity="length" /></th>
            <th>y <UnitChip quantity="length" /></th>
            <th></th>
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
                    ? <input value={0} disabled />
                    : <NumField value={toUi(p[0])} step={tableStep} allowNegative
                        ariaLabel={`Point ${i + 1} x`}
                        onCommit={(v) => { if (v !== null) setPoint(i, 0, v); }} />}
                </td>
                <td>
                  {first || last
                    ? <input value={0} disabled
                        title={last ? 'Trailing corner stays on the body (y = 0)' : undefined} />
                    : <NumField value={toUi(p[1])} step={tableStep}
                        ariaLabel={`Point ${i + 1} y`}
                        onCommit={(v) => { if (v !== null) setPoint(i, 1, v); }} />}
                </td>
                <td>
                  <button className="fin-row-del" disabled={first || last || pts.length <= 3}
                    title="Remove point" onClick={() => removePoint(i)}>✕</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="file-btn" style={{ marginTop: 6 }} onClick={addPoint}>
        + Add point
      </button>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
        Click the canvas to add a point on the nearest edge · drag points to move
        them · double-click a point to delete it · refine exact values in the
        table. Point 1 is fixed at the origin; the last point stays on the body.
      </p>
    </div>
  );
}
