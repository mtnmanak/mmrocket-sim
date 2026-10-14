import type { SchematicLayout } from '../tree/schematicLayout.js';
import { fmtSi } from '../prefs/units.js';
import { guideDigits } from './rulerGuides.js';

/** N044: points in the drawn plane, metres from the nose and centreline. */
export interface CaliperPoint { x: number; y: number }

export function caliperDistances(a: CaliperPoint, b: CaliperPoint) {
  const horizontal = Math.abs(b.x - a.x), vertical = Math.abs(b.y - a.y);
  return { horizontal, vertical, straight: Math.hypot(horizontal, vertical) };
}

export function caliperReadout(a: CaliperPoint, b: CaliperPoint, unit: string): string {
  const d = caliperDistances(a, b);
  const fmt = (m: number) => `${fmtSi('length', unit, m, guideDigits(unit))} ${unit}`;
  return `Horizontal ${fmt(d.horizontal)} · Vertical ${fmt(d.vertical)} · Straight ${fmt(d.straight)}`;
}

export function snapCaliperPoint(p: CaliperPoint, targets: readonly CaliperPoint[], radiusM: number): CaliperPoint {
  let best = p, distance = radiusM;
  for (const t of targets) {
    const d = Math.hypot(p.x - t.x, p.y - t.y);
    if (d <= distance) { best = t; distance = d; }
  }
  return best;
}

/** N044: only explicit model stations may attract a pick; ink and hit surfaces are decoration. */
export function schematicSnapTargets(layout: SchematicLayout): CaliperPoint[] {
  const out: CaliperPoint[] = [];
  for (const s of layout.shapes) {
    if (!s.snap || s.part?.hit) continue;
    const points = s.snap.points.slice();
    const outline = s.snap.outline ?? [];
    const clip = s.snap.hiddenBand;
    if (clip) {
      // Physical outline intersections with the airframe remain pickable; hidden roots do not.
      for (let i = 0; i < outline.length; i++) {
        const [x1, y1] = outline[i]!;
        const [x2, y2] = outline[(i + 1) % outline.length]!;
        for (const y of clip) {
          if ((y1! < y && y2! > y) || (y2! < y && y1! > y)) {
            points.push([x1! + (x2! - x1!) * (y - y1!) / (y2! - y1!), y]);
          }
        }
      }
    }
    for (const [x, y] of points) {
      if (clip && y! > clip[0] && y! < clip[1]) continue;
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x: x!, y: y! });
    }
  }
  return out;
}
