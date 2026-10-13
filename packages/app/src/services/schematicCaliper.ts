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

/** Use actual instance vertices, rather than the union of a cluster's bounds. */
export function schematicSnapTargets(layout: SchematicLayout, ctx: { scale: number; x0: number; cy: number }): CaliperPoint[] {
  const out: CaliperPoint[] = [];
  for (const s of layout.shapes) {
    if ((!s.part && !s.attrs['data-wall']) || s.part?.hit) continue;
    const a = s.attrs;
    let points: number[][] = [];
    if (s.tag === 'rect') {
      const x = Number(a['x']), y = Number(a['y']), w = Number(a['width']), h = Number(a['height']);
      points = [[x, y], [x + w, y], [x, y + h], [x + w, y + h], [x, y + h / 2], [x + w, y + h / 2]];
    } else if (s.tag === 'polygon' || (s.tag === 'path' && !/[CQASTHV]/i.test(String(a['d'])))) {
      const nums = String(a[s.tag === 'polygon' ? 'points' : 'd']).match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
      for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i]!, nums[i + 1]!]);
    }
    for (const [x, y] of points) {
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x: (x! - ctx.x0) / ctx.scale, y: (ctx.cy - y!) / ctx.scale });
    }
  }
  return out;
}
