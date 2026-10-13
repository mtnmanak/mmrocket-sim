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

/** N044: use displayed instance corners, respecting each shape's airframe clip. */
export function schematicSnapTargets(layout: SchematicLayout, ctx: { scale: number; x0: number; cy: number }): CaliperPoint[] {
  const out: CaliperPoint[] = [];
  for (const s of layout.shapes) {
    if ((!s.part && !s.attrs['data-wall']) || s.part?.hit) continue;
    const a = s.attrs;
    let points: number[][] = [];
    let outline: number[][] = [];
    if (s.tag === 'rect') {
      const x = Number(a['x']), y = Number(a['y']), w = Number(a['width']), h = Number(a['height']);
      points = [[x, y], [x + w, y], [x, y + h], [x + w, y + h], [x, y + h / 2], [x + w, y + h / 2]];
      outline = [points[0]!, points[1]!, points[3]!, points[2]!];
    } else if (s.tag === 'polygon' || (s.tag === 'path' && !/[CQASTHV]/i.test(String(a['d'])))) {
      const nums = String(a[s.tag === 'polygon' ? 'points' : 'd']).match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
      for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i]!, nums[i + 1]!]);
      if (s.tag === 'polygon') outline = points.slice();
    }
    const clip = layout.clips.find(c => a['clipPath'] === `url(#${c.id})`);
    if (clip) {
      // Clipping creates visible corners on polygon/rect edges; raw hidden roots must not attract picks.
      for (let i = 0; i < outline.length; i++) {
        const [x1, y1] = outline[i]!;
        const [x2, y2] = outline[(i + 1) % outline.length]!;
        for (const y of [clip.top, clip.bottom]) {
          if ((y1! < y && y2! > y) || (y2! < y && y1! > y)) {
            points.push([x1! + (x2! - x1!) * (y - y1!) / (y2! - y1!), y]);
          }
        }
      }
    }
    for (const [x, y] of points) {
      if (clip && y! > clip.top && y! < clip.bottom) continue;
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x: (x! - ctx.x0) / ctx.scale, y: (ctx.cy - y!) / ctx.scale });
    }
  }
  return out;
}
