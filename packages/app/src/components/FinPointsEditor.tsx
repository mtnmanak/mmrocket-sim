import { useMemo } from 'react';

/**
 * Freeform fin planform editor: an editable coordinate table with a live SVG
 * preview sharing ONE data model (the node's `points`, SI meters, fin-local
 * frame: x aft along the root from the leading edge, y outward from the body
 * surface).
 *
 * Constraints (mirroring the engine's FreeformFinSet):
 *  - first point is locked at (0,0) — the leading root corner
 *  - last point stays on the body line (y = 0) — the trailing root corner
 *  - minimum 3 points
 *
 * Built drag-ready: toScreen/toModel are exact inverses, and each rendered
 * point carries its index — a future pointer handler only needs to call
 * onChange with the same shape the table uses.
 */

export type FinPoint = [number, number];

const VIEW_W = 300;
const VIEW_H = 170;
const PAD = 22;

export function FinPointsEditor({ points, onChange }: {
  points: FinPoint[];
  onChange: (next: FinPoint[]) => void;
}) {
  const pts: FinPoint[] = points.length >= 3 ? points : [[0, 0], [0.02, 0.03], [0.05, 0]];

  const { toScreen } = useMemo(() => {
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
    const toScreenF = ([x, y]: FinPoint): [number, number] => [
      PAD + (x - minX) * scale,
      VIEW_H - PAD - (y - minY) * scale,
    ];
    return { toScreen: toScreenF };
  }, [pts]);

  const mm = (v: number) => Number((v * 1000).toFixed(3));

  const setPoint = (i: number, axis: 0 | 1, valueMm: number) => {
    if (!Number.isFinite(valueMm)) return;
    const next = pts.map((p, j) => {
      if (j !== i) return [...p] as FinPoint;
      const q: FinPoint = [...p];
      q[axis] = valueMm / 1000;
      return q;
    });
    // Enforce invariants.
    next[0] = [0, 0];
    next[next.length - 1] = [next[next.length - 1]![0], 0];
    onChange(next);
  };

  const addPoint = () => {
    // Insert the midpoint of the last edge (before the trailing root corner).
    const a = pts[pts.length - 2]!;
    const b = pts[pts.length - 1]!;
    const mid: FinPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    onChange([...pts.slice(0, pts.length - 1), mid, pts[pts.length - 1]!]);
  };

  const removePoint = (i: number) => {
    if (pts.length <= 3 || i === 0 || i === pts.length - 1) return;
    onChange(pts.filter((_, j) => j !== i));
  };

  const polygon = pts.map((p) => toScreen(p).join(',')).join(' ');
  const bodyLine = [toScreen([Math.min(0, ...pts.map((p) => p[0])) , 0]), toScreen([Math.max(...pts.map((p) => p[0])), 0])];

  return (
    <div style={{ marginTop: 10 }}>
      <h2>Fin planform</h2>
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          style={{ width: '100%', height: 'auto', background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 6 }}
          role="img" aria-label="Fin planform preview">
        {/* body surface line */}
        <line x1={0} y1={bodyLine[0]![1]} x2={VIEW_W} y2={bodyLine[0]![1]}
          stroke="#9a978f" strokeWidth="3" />
        <text x={4} y={bodyLine[0]![1] + 12} fontSize="9" fill="var(--text-muted)">body tube</text>
        {/* fin polygon */}
        <polygon points={polygon} fill="#b9b7b0" fillOpacity="0.75" stroke="#7a786f" strokeWidth="1.5" />
        {/* points with indices */}
        {pts.map((p, i) => {
          const [sx, sy] = toScreen(p);
          const locked = i === 0;
          return (
            <g key={i}>
              <circle cx={sx} cy={sy} r={4.5}
                fill={locked ? '#7a786f' : '#2a78d6'} stroke="#fff" strokeWidth="1.5" />
              <text x={sx + 7} y={sy - 6} fontSize="9" fill="var(--text-secondary)">{i + 1}</text>
            </g>
          );
        })}
      </svg>

      <table className="fin-table">
        <thead>
          <tr><th>#</th><th>x (mm)</th><th>y (mm)</th><th></th></tr>
        </thead>
        <tbody>
          {pts.map((p, i) => {
            const first = i === 0;
            const last = i === pts.length - 1;
            return (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>
                  <input type="number" step={1} value={mm(p[0])} disabled={first}
                    onChange={(e) => setPoint(i, 0, Number(e.target.value))} />
                </td>
                <td>
                  <input type="number" step={1} value={mm(p[1])} disabled={first || last}
                    title={last ? 'Trailing corner stays on the body (y = 0)' : undefined}
                    onChange={(e) => setPoint(i, 1, Number(e.target.value))} />
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
        x runs aft along the root from the leading corner; y is height above the
        body. Point 1 is fixed at the origin; the last point stays on the body.
      </p>
    </div>
  );
}
