import type { ComponentNode } from '@online-openrocket/engine';
import { kernelNum } from '../tree/kernelDefaults.js';
import { numOpt } from '../tree/nodeNum.js';
import { outerProfile } from '../tree/shapeProfile.js';
import { centeringRingBore, ringOuterRadius, type SolidContext } from '../tree/solidMesh.js';
import { noseEnds } from '../tree/tailCone.js';
import { fmtSi, type UnitSelection } from '../prefs/units.js';
import { escapeXml } from './xmlUtil.js';

export const PAPER_TEMPLATE_TYPES = new Set(['centeringring', 'bulkhead', 'transition', 'nosecone']);
export interface PaperTemplateGeometry {
  name: string;
  kind: 'disc' | 'wrap' | 'profile';
  /** All dimensions are SI; path coordinates are SVG millimetres. */
  width: number;
  height: number;
  path: string;
  circles: number[];
  sector?: { outer: number; inner: number; angle: number };
  stations: [number, number][];
  dimensions: [string, number][];
  notes: string[];
}
const f = (m: number) => (m * 1000).toFixed(4);

/** C-A6/C-A7: display helpers may substitute invalid radii; fabrication must not. */
export function paperRingDimensions(node: ComponentNode, ctx: SolidContext): { outer: number; bore?: number } {
  const statedOuter = node['outerRadius'] != null;
  const resolved = ringOuterRadius(node, ctx);
  const outer = statedOuter ? numOpt(node, 'outerRadius') : resolved.assumed ? undefined : resolved.r;
  if (outer === undefined || !Number.isFinite(outer) || outer <= 0) {
    throw new Error('The outside diameter is unknown or invalid. State a positive diameter or fit the part inside a tube.');
  }
  if (node.type !== 'centeringring') return { outer };
  const statedBore = node['innerRadius'] != null;
  const bore = statedBore ? numOpt(node, 'innerRadius') : centeringRingBore(node, ctx, outer);
  if (bore === undefined || !Number.isFinite(bore) || bore < 0 || bore >= outer || (!statedBore && bore === 0)) {
    throw new Error('The ring bore is unknown or does not fit inside the ring. Check its ID and the overlapping motor mount.');
  }
  return { outer, bore };
}

/** C-A7: fabrication only; never invent dimensions or modify the design. */
export function paperTemplateGeometry(node: ComponentNode, ctx: SolidContext): PaperTemplateGeometry {
  for (const key of ['length', 'outerRadius', 'innerRadius', 'foreRadius', 'aftRadius']) {
    // eslint-disable-next-line no-restricted-syntax -- Reject non-finite authored numbers before kernelNum substitutes its default.
    if (typeof node[key] === 'number' && !Number.isFinite(node[key])) throw new Error('Check the finite dimensions before printing.');
  }
  const g: PaperTemplateGeometry = { name: node.name ?? node.type, kind: 'disc', width: 0, height: 0,
    path: '', circles: [], stations: [], dimensions: [], notes: [] };
  if (node.type === 'centeringring' || node.type === 'bulkhead') {
    // The kernel's bore is the widest overlapping tube, centred; a cutting template must not stand that in for a
    // cluster's or an off-centre tube's holes (release claim check, 2026-10-13).
    const clusterRing = node.type === 'centeringring' && ctx.mountLayoutUnresolved === true;
    if (clusterRing && node['innerRadius'] == null) {
      throw new Error('This ring surrounds a cluster, an off-centre tube or several tubes. The app cannot lay out their '
        + 'holes, so it prints no template with one centred opening. Lay the holes out by hand, or state the ring ID '
        + 'if one centred opening is right.');
    }
    const { outer: r, bore } = paperRingDimensions(node, ctx);
    if (clusterRing) g.notes.push('Caution: this ring surrounds a cluster, an off-centre tube or several tubes; '
      + 'the template has only the stated centred opening. Lay out the other holes by hand.');
    g.width = 2 * r; g.height = 2 * r;
    g.circles = [r];
    g.dimensions.push(['Outside diameter', 2 * r]);
    if (bore !== undefined) {
      if (bore > 0) g.circles.push(bore);
      g.dimensions.push(['Opening diameter', 2 * bore]);
      g.notes.push('The centre opening uses the stated ring ID, else the overlapping mount tube OD.');
      if (bore === 0) g.notes.push('The stated zero ID makes a solid disc with no centre opening.');
    }
    g.notes.push('No cutting allowance. The design has no additional drilling-hole fields; no holes are invented.');
    return g;
  }
  if (node.type !== 'nosecone' && node.type !== 'transition') throw new Error('Select a ring, bulkhead, nose cone or transition.');
  const length = kernelNum(node, 'length');
  const ends = node.type === 'nosecone' ? noseEnds(node, kernelNum(node, 'aftRadius')) : {
    fore: numOpt(node, 'foreRadius') ?? ctx.foreRadius,
    aft: numOpt(node, 'aftRadius') ?? ctx.aftRadius,
  };
  const { fore, aft } = ends;
  if (!(Number.isFinite(length) && length > 0) || fore === undefined || aft === undefined
    || !Number.isFinite(fore) || !Number.isFinite(aft) || Math.min(fore, aft) < 0 || Math.max(fore, aft) <= 0) {
    throw new Error('Check the length and end radii before printing. Automatic radii need adjacent tubes.');
  }
  const shape = typeof node['shape'] === 'string' ? node['shape'] : node.type === 'nosecone' ? 'ogive' : 'conical';
  const clipped = typeof node['clipped'] === 'boolean' ? node['clipped'] : undefined;
  g.dimensions.push(['Fore diameter', 2 * fore], ['Aft diameter', 2 * aft], ['Length', length]);
  g.notes.push('Exterior surface only. Shoulders, wall thickness, seam tabs and cutting allowance are omitted.');
  if (shape !== 'conical') {
    g.kind = 'profile';
    g.notes.unshift('Sampled side profile, not a flat wrap. Curved surfaces cannot be flattened exactly.');
    const points = outerProfile(shape, numOpt(node, 'shapeParameter'), length, fore, aft, 64, undefined, clipped);
    g.stations = outerProfile(shape, numOpt(node, 'shapeParameter'), length, fore, aft, 8, undefined, clipped);
    const radius = Math.max(...points.map(p => p[1]));
    if (!Number.isFinite(radius)) throw new Error('The shape has no finite profile. Check its dimensions.');
    g.width = length; g.height = 2 * radius;
    const outline = [...points.map(([x, r]) => [x, radius - r]), ...[...points].reverse().map(([x, r]) => [x, radius + r])];
    g.path = outline.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${f(x!)} ${f(y!)}`).join(' ') + ' Z';
    return g;
  }
  g.kind = 'wrap';
  g.notes.unshift('Exact conical flat wrap of the exterior surface. Check material fit before cutting.');
  const small = Math.min(fore, aft), large = Math.max(fore, aft), delta = large - small;
  const slant = Math.hypot(length, delta);
  // C-A7: bound circumference and outline errors below the SVG's 0.0001 mm precision;
  // subtracting almost equal sector radii can otherwise make a 120 mm seam 125 mm long.
  const precision = 1e-7;
  const cylinderError = Math.PI ** 2 * large * delta / (2 * slant) + delta ** 2 / (slant + length);
  if (delta === 0 || (2 * Math.PI * delta <= precision && cylinderError <= precision)) {
    if (delta > 0) g.notes[0] = 'Near-cylinder rectangular approximation: circumference and outline errors below 0.0001 mm. Check material fit before cutting.';
    g.width = 2 * Math.PI * large; g.height = length;
    g.path = `M 0 0 H ${f(g.width)} V ${f(length)} H 0 Z`;
    return g;
  }
  const outer = slant * large / delta, inner = slant * small / delta;
  const angle = 2 * Math.PI * delta / slant, half = angle / 2;
  g.sector = { outer, inner, angle };
  const left = Math.min(inner * Math.cos(half), outer * Math.cos(half));
  const top = outer * (half >= Math.PI / 2 ? 1 : Math.sin(half));
  g.width = outer - left; g.height = 2 * top;
  const point = (r: number, a: number) => `${f(r * Math.cos(a) - left)} ${f(r * Math.sin(a) + top)}`;
  g.path = `M ${point(outer, -half)} A ${f(outer)} ${f(outer)} 0 ${angle > Math.PI ? 1 : 0} 1 ${point(outer, half)}`
    + (inner > 0 ? ` L ${point(inner, half)} A ${f(inner)} ${f(inner)} 0 ${angle > Math.PI ? 1 : 0} 0 ${point(inner, -half)}`
      : ` L ${point(0, 0)}`) + ' Z';
  if (![g.width, g.height, outer, inner].every(Number.isFinite)) throw new Error('The wrap is too large. Check the end radii.');
  return g;
}

export interface PaperTemplatePage { column: number; row: number; x: number; y: number; svg: string }

/** Tube-wrap page and overlap convention; never fit or shrink a part. */
export function paperTemplatePages(g: PaperTemplateGeometry, rocket: string, units: Pick<UnitSelection, 'length'>): PaperTemplatePage[] {
  const width = 180, height = 180, step = 170;
  const columns = Math.max(1, Math.ceil((g.width * 1000 - 10) / step));
  const rows = Math.max(1, Math.ceil((g.height * 1000 - 10) / step));
  if (!Number.isFinite(columns * rows) || columns * rows > 100) throw new Error('This template needs more than 100 pages. Check the dimensions.');
  const dim = (m: number) => `${fmtSi('length', units.length, m, 3)} ${units.length}`;
  const inches = units.length === 'in' || units.length === 'ft', ruler = inches ? 50.8 : 50;
  const pages: PaperTemplatePage[] = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const x = column * step, y = row * step, index = pages.length + 1;
    const text = (s: string, ty: number) => `<text x="15" y="${ty}" font-size="3.2" textLength="${Math.min(180, s.length * 1.7)}" lengthAdjust="spacingAndGlyphs">${escapeXml(s)}</text>`;
    const geometry = g.circles.length > 0 ? g.circles.map(r =>
      `<circle cx="${f(g.width / 2)}" cy="${f(g.height / 2)}" r="${f(r)}"/>`).join('') : `<path d="${g.path}"/>`;
    const stationText = g.stations.length ? [text('Stations: distance aft of front / radius (shoulders omitted)', 49),
      ...[0, 1, 2].map(i => text(g.stations.slice(i * 3, i * 3 + 3).map(([sx, sr]) => `${dim(sx)} / ${dim(sr)}`).join(' ; '), 54 + i * 5))] : [];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="279mm" viewBox="0 0 210 279" style="background:#fff">
<g font-family="sans-serif" fill="#000">${text(`${rocket} — ${g.name}: ${g.kind}`, 10)}
${text('Scale 1:1 — print at 100%, no fit to page. Check the ruler on every page.', 16)}
${text(`Page ${index}/${columns * rows}: column ${column + 1}/${columns}, row ${row + 1}/${rows}. Right ${dim(x / 1000)}; down ${dim(y / 1000)}.`, 22)}
${text('Join matching coordinates with 10 mm overlap. Solid outlines: part; grid: reference.', 28)}
${g.notes.map((s, i) => text(`${i === 0 && g.kind === 'profile' ? 'Caution: ' : ''}${s}`, 34 + i * 5)).join('')}
${text(g.dimensions.map(([label, value]) => `${label} ${dim(value)}`).join('; '), Math.max(44, 34 + g.notes.length * 5))}
${stationText.join('')}<text x="${18 + ruler}" y="72" font-size="3.2">${inches ? '2 in' : escapeXml(dim(0.05))}</text></g>
<g fill="none" stroke="#000" stroke-width="0.2"><line id="calibration-ruler" x1="15" y1="72" x2="${15 + ruler}" y2="72"/>
<line x1="15" y1="69" x2="15" y2="73"/><line x1="${15 + ruler}" y1="69" x2="${15 + ruler}" y2="73"/></g>
<defs><clipPath id="tile-${index}"><rect x="15" y="80" width="${width}" height="${height}"/></clipPath></defs>
<g clip-path="url(#tile-${index})"><g transform="translate(${15 - x} ${80 - y})" fill="none" stroke="#000" stroke-width="0.2">${geometry}</g>
${Array.from({ length: 10 }, (_, i) => {
  const gx = Math.ceil(x / 20) * 20 + i * 20, gy = Math.ceil(y / 20) * 20 + i * 20;
  const px = 15 + gx - x, py = 80 + gy - y;
  return `<path d="M ${px} 80 V 260 M 15 ${py} H 195" fill="none" stroke="#888" stroke-width="0.1" stroke-dasharray="0.5 2"/>
<text x="${px - 1}" y="84" text-anchor="end" font-size="2.2">${escapeXml(dim(gx / 1000))}</text>
<text x="16" y="${py - 1}" font-size="2.2">${escapeXml(dim(gy / 1000))}</text>`;
}).join('')}</g></svg>`;
    pages.push({ column: column + 1, row: row + 1, x: x / 1000, y: y / 1000, svg });
  }
  return pages;
}
