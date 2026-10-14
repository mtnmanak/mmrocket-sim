import type { ComponentNode } from '@online-openrocket/engine';
import { finCountOf } from '../tree/counts.js';
import { kernelNum } from '../tree/kernelDefaults.js';
import { num } from '../tree/nodeNum.js';
import { fmtSi, type UnitSelection } from '../prefs/units.js';
import { escapeXml } from './xmlUtil.js';
import { WRAP_FINS } from './tubeWrapGuide.js';
import type { FinTemplateBackground } from './finTemplate.js';

type Point = [number, number];
export interface FinJigGeometry {
  tubeRadius: number;
  outerRadius: number;
  slotWidth: number;
  clearance: number;
  slots: { angle: number; inner: [Point, Point]; outer: [Point, Point] }[];
}

/** N049: thickness is the stock thickness, including rounded and airfoil sections. */
export function finAlignmentJigGeometry(tube: ComponentNode, fin: ComponentNode, clearance: number): FinJigGeometry {
  if (tube.type !== 'bodytube' || !WRAP_FINS.has(fin.type)) throw new Error('Select a fin set on a straight round body tube.');
  if (!(Number.isFinite(clearance) && clearance >= 0 && clearance <= 0.01)) throw new Error('Clearance must be between 0 and 10 mm.');
  const radius = kernelNum(tube, 'outerRadius');
  const thickness = kernelNum(fin, 'thickness');
  if (!(radius > 0 && Number.isFinite(radius))) throw new Error('Check the tube outside diameter.');
  if (!(thickness > 0 && Number.isFinite(thickness))) throw new Error('Fin thickness must be positive.');
  if (Math.abs(num(fin, 'cant', 0)) > 1e-9) throw new Error('These fins have cant. A flat jig cannot hold their angle along the tube. Use an uncanted fin set for this template.');
  const count = finCountOf(fin);
  const slotWidth = thickness + clearance;
  const half = slotWidth / 2;
  if (half >= radius || 2 * Math.asin(half / radius) >= 2 * Math.PI / count) {
    throw new Error('The fin slots overlap at this tube diameter. Check the thickness and clearance.');
  }
  const points = fin['points'];
  const span = fin.type === 'freeformfinset'
    ? Array.isArray(points) ? points.reduce((max: number, p: unknown) => Math.max(max, Array.isArray(p) && Number.isFinite(p[1]) ? Number(p[1]) : 0), 0) : 0.05
    : kernelNum(fin, 'height');
  if (!(span > 0)) throw new Error('The fins need a positive span to fit a jig.');
  // N049: a closed slot must clear the full span, including rectangular freeform fins.
  const end = radius + span;
  const start = Math.sqrt(radius ** 2 - half ** 2);
  const slots = Array.from({ length: count }, (_, i) => {
    const raw = num(fin, 'rotation', 0) + i * 2 * Math.PI / count;
    const angle = ((raw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const point = (r: number, offset: number): Point => [
      r * Math.sin(angle) + offset * Math.cos(angle),
      -r * Math.cos(angle) + offset * Math.sin(angle),
    ];
    return { angle, inner: [point(start, -half), point(start, half)] as [Point, Point],
      outer: [point(end, -half), point(end, half)] as [Point, Point] };
  });
  return { tubeRadius: radius, outerRadius: Math.hypot(end, half) + 0.01, slotWidth, clearance, slots };
}

export function finAlignmentJigSvg(
  tube: ComponentNode, fin: ComponentNode, clearance: number, rocketName: string,
  units: Pick<UnitSelection, 'length' | 'angle'>, background: FinTemplateBackground = 'white',
): string {
  const g = finAlignmentJigGeometry(tube, fin, clearance);
  const dim = (m: number) => `${fmtSi('length', units.length, m, 3)} ${units.length}`;
  const labels = [
    `${rocketName} — ${fin.name ?? 'Fin set'}: fin alignment jig`,
    `Tube OD ${dim(g.tubeRadius * 2)} · ${g.slots.length} fins · slot width ${dim(g.slotWidth)}`,
    `Slot width = fin thickness + ${dim(clearance)} total clearance (across both sides).`,
    `Viewed from aft · zero angle at top · first fin ${fmtSi('angle', units.angle, g.slots[0]!.angle, 2)} ${units.angle}`,
    'Scale 1:1 — print at 100%, no fit to page. Measure the calibration ruler.',
    'Caution: measure the actual tube and fin stock; check the fit before cutting.',
    'Place the jig where every fin engages its slot. It does not set fin cant.',
  ];
  const width = Math.max(g.outerRadius * 2000 + 20, ...labels.map(l => l.length * 1.65 + 20));
  const height = g.outerRadius * 2000 + 75;
  if (width > 2000 || height > 2000) throw new Error('This jig is too large to export. Check the tube and fin dimensions.');
  const centre: Point = [width / 2, g.outerRadius * 1000 + 10];
  const xy = (p: Point) => `${(centre[0] + p[0] * 1000).toFixed(4)} ${(centre[1] + p[1] * 1000).toFixed(4)}`;
  const r = (g.tubeRadius * 1000).toFixed(4);
  const path = [`M ${xy(g.slots[0]!.inner[0])}`];
  g.slots.forEach((slot, i) => {
    path.push(`L ${xy(slot.outer[0])} L ${xy(slot.outer[1])} L ${xy(slot.inner[1])}`);
    const next = g.slots[(i + 1) % g.slots.length]!;
    const arc = 2 * Math.PI / g.slots.length - 2 * Math.asin(g.slotWidth / (2 * g.tubeRadius));
    path.push(`A ${r} ${r} 0 ${arc > Math.PI ? 1 : 0} 1 ${xy(next.inner[0])}`);
  });
  const labelY = g.outerRadius * 2000 + 28;
  const imperial = units.length === 'in' || units.length === 'ft';
  const ruler = imperial ? 50.8 : 50;
  const rulerY = height - 8;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(1)}mm" height="${height.toFixed(1)}mm" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}"${background === 'white' ? ' style="background:#fff"' : ''}>`,
    '<g fill="none" stroke="#000" stroke-width="0.2">',
    `<circle id="jig-outer-edge" cx="${centre[0].toFixed(4)}" cy="${centre[1].toFixed(4)}" r="${(g.outerRadius * 1000).toFixed(4)}"/>`,
    `<path id="tube-and-slots" d="${path.join(' ')} Z"/>`,
    `<line id="zero-angle-reference" x1="${centre[0].toFixed(4)}" y1="5" x2="${centre[0].toFixed(4)}" y2="10" stroke-dasharray="1 1"/>`,
    `<line id="calibration-ruler" x1="10" y1="${rulerY}" x2="${10 + ruler}" y2="${rulerY}"/>`,
    ...Array.from({ length: 6 }, (_, i) => `<line x1="${10 + i * ruler / 5}" y1="${rulerY - 3}" x2="${10 + i * ruler / 5}" y2="${rulerY}"/>`),
    '</g>',
    '<g font-family="sans-serif" font-size="3" fill="#000">',
    `<text x="${(centre[0] + 3).toFixed(4)}" y="7">0 ${escapeXml(units.angle)}</text>`,
    ...labels.map((label, i) => `<text x="10" y="${labelY + i * 5}">${escapeXml(label)}</text>`),
    `<text x="${ruler + 14}" y="${rulerY}">${escapeXml(imperial ? '2 in' : dim(0.05))}</text>`,
    '</g>', '</svg>',
  ].join('\n');
}
