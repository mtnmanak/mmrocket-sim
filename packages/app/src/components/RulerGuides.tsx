import { fmtSi } from '../prefs/units.js';
import { guideDigits, guideSpans, guideToPx, type Guide, type GuideAxis, type GuideView } from '../services/rulerGuides.js';

/** Approximate width of a 10 px label, for its backing plate. */
const plateW = (text: string) => text.length * 5.8 + 8;
const INK = 'var(--accent)';

/**
 * The measuring guides drawn over the 2D side view, and the two invisible
 * strips over the rulers that a new guide is dragged out of
 * (services/rulerGuides.ts has the why).
 *
 * Drawn OUTSIDE the zoom group, like the rulers, from positions already
 * resolved through the view — so a guide keeps a hairline width and a
 * readable label at any zoom. The whole group carries `data-guides` and the
 * exporter drops it: a guide is a tool for reading the screen, not part of
 * the drawing, and the ⬇ SVG / ⬇ Image exports stay as they were.
 */
export function RulerGuides({ guides, view, w, h, gutX, gutY, rollW, unit, onCreate, onGrab }: {
  guides: readonly Guide[];
  view: GuideView;
  /** viewBox size, and the drawing area's top-left corner inside the rulers. */
  w: number;
  h: number;
  gutX: number;
  gutY: number;
  /** The roll column's width — the left ruler starts after it. */
  rollW: number;
  /** The Preferences length unit, the rulers' own. */
  unit: string;
  onCreate: (axis: GuideAxis, e: React.PointerEvent) => void;
  onGrab: (g: Guide, e: React.PointerEvent) => void;
}) {
  const digits = guideDigits(unit);
  const len = (m: number) => `${fmtSi('length', unit, m, digits)} ${unit}`;
  const at = (g: Guide) => guideToPx(view, g.axis, g.m);
  const inside = (g: Guide) => {
    const p = at(g);
    return g.axis === 'x' ? p >= gutX && p <= w : p >= gutY && p <= h;
  };
  const label = (x: number, y: number, text: string, anchor: 'start' | 'middle') => {
    const pw = plateW(text);
    const px = anchor === 'middle' ? x - pw / 2 : x;
    return (
      <g pointerEvents="none">
        <rect x={px} y={y - 7} width={pw} height={14} rx={3} fill="var(--surface-1)" stroke={INK} strokeWidth={0.75} />
        <text x={anchor === 'middle' ? x : x + 4} y={y} textAnchor={anchor} dominantBaseline="central" fill={INK}>{text}</text>
      </g>
    );
  };

  const across = guides.filter((g) => g.axis === 'x' && inside(g));
  const along = guides.filter((g) => g.axis === 'y' && inside(g));
  // Station labels sit along the bottom and the dimension lines between
  // neighbours just above them; offsets measure down the right. All clear of
  // the control strip in the top-right corner and of the CG/CP callouts.
  const spanY = h - 32;
  const spanX = w - 78;

  return (
    <g data-guides="" fontSize="10">
      <rect data-guide-ruler="x" x={gutX} y={0} width={Math.max(0, w - gutX)} height={gutY}
        fill="transparent" style={{ cursor: 'col-resize' }} onPointerDown={(e) => onCreate('x', e)}>
        <title>Drag down from the ruler for a measuring guide across the rocket</title>
      </rect>
      <rect data-guide-ruler="y" x={rollW} y={gutY} width={Math.max(0, gutX - rollW)} height={Math.max(0, h - gutY)}
        fill="transparent" style={{ cursor: 'row-resize' }} onPointerDown={(e) => onCreate('y', e)}>
        <title>Drag right from the ruler for a measuring guide along the rocket</title>
      </rect>

      {guideSpans(guides, 'x').filter((s) => inside(s.a) && inside(s.b)).map((s) => {
        const xa = at(s.a); const xb = at(s.b);
        return (
          <g key={`sx${s.a.id}-${s.b.id}`} data-guide-span="x">
            <path pointerEvents="none" stroke={INK} strokeWidth={1} fill="none"
              d={`M ${xa} ${spanY} H ${xb} M ${xa} ${spanY - 4} V ${spanY + 4} M ${xb} ${spanY - 4} V ${spanY + 4}`} />
            {label((xa + xb) / 2, spanY - 10, len(s.d), 'middle')}
          </g>
        );
      })}
      {guideSpans(guides, 'y').filter((s) => inside(s.a) && inside(s.b)).map((s) => {
        const ya = at(s.a); const yb = at(s.b);
        return (
          <g key={`sy${s.a.id}-${s.b.id}`} data-guide-span="y">
            <path pointerEvents="none" stroke={INK} strokeWidth={1} fill="none"
              d={`M ${spanX} ${ya} V ${yb} M ${spanX - 4} ${ya} H ${spanX + 4} M ${spanX - 4} ${yb} H ${spanX + 4}`} />
            {label(spanX + 6, (ya + yb) / 2, len(s.d), 'start')}
          </g>
        );
      })}

      {across.map((g) => {
        const x = at(g);
        return (
          <g key={g.id} data-guide="x">
            <line pointerEvents="none" x1={x} y1={gutY} x2={x} y2={h} stroke={INK} strokeWidth={1} strokeDasharray="5 3" />
            {/* A wide invisible stroke to grab: a 1 px line is too thin to hit. */}
            <line x1={x} y1={gutY} x2={x} y2={h} stroke="transparent" strokeWidth={9}
              style={{ cursor: 'col-resize' }} onPointerDown={(e) => onGrab(g, e)}>
              <title>Measuring guide — drag to move, drag back onto the ruler to remove</title>
            </line>
            {label(x, h - 10, len(g.m), 'middle')}
          </g>
        );
      })}
      {along.map((g) => {
        const y = at(g);
        return (
          <g key={g.id} data-guide="y">
            <line pointerEvents="none" x1={gutX} y1={y} x2={w} y2={y} stroke={INK} strokeWidth={1} strokeDasharray="5 3" />
            <line x1={gutX} y1={y} x2={w} y2={y} stroke="transparent" strokeWidth={9}
              style={{ cursor: 'row-resize' }} onPointerDown={(e) => onGrab(g, e)}>
              <title>Measuring guide — drag to move, drag back onto the ruler to remove</title>
            </line>
            {label(gutX + 4, y - 10, len(g.m), 'start')}
          </g>
        );
      })}
    </g>
  );
}
