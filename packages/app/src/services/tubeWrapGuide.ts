import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { finCountOf, lineInstanceCount } from '../tree/counts.js';
import { finRootChord, finTabSpan } from '../tree/finTab.js';
import { kernelNum, KERNEL_DEFAULT_FIN_POINTS } from '../tree/kernelDefaults.js';
import { num } from '../tree/nodeNum.js';
import { absoluteStations, axialLength, axialStart } from '../tree/position.js';
import { fmtSi, type UnitSelection } from '../prefs/units.js';
import type { FinTemplateBackground } from './finTemplate.js';
import { escapeXml } from './xmlUtil.js';
import { tubeHoleMarks, TUBE_HOLE_ADVICE, type TubeHoleMark } from '../tree/tubeHoles.js';

export const WRAP_FINS: ReadonlySet<string> = new Set(['trapezoidfinset', 'ellipticalfinset', 'freeformfinset']);

interface Span { start: number; end: number }
export interface TubeWrapLine {
  label: string;
  kind: 'fin' | 'guide';
  angle: number;
  x: number;
  root: Span;
  slot: (Span & { width: number }) | null;
}
export interface TubeWrapGeometry {
  name: string;
  diameter: number;
  circumference: number;
  length: number;
  lines: TubeWrapLine[];
  holes: (TubeHoleMark & { x: number; label: string })[];
  notes: string[];
}

/** C-A8/R09: fabrication only, in the selected straight tube's own angular frame. */
export function tubeWrapGeometry(tree: RocketTree, tube: ComponentNode): TubeWrapGeometry {
  if (tube.type !== 'bodytube') throw new Error('Select a straight round body tube.');
  const radius = kernelNum(tube, 'outerRadius');
  const length = axialLength(tube);
  if (!(radius > 0 && length > 0 && Number.isFinite(radius) && Number.isFinite(length))) {
    throw new Error('Check the tube dimensions before exporting.');
  }
  const circumference = 2 * Math.PI * radius;
  const stations = absoluteStations(tree);
  const tubeStart = stations.get(tube.id!)?.start;
  if (tubeStart === undefined) throw new Error('This tube is not in the design.');
  const lines: TubeWrapLine[] = [];
  const notes: string[] = [];
  const holes: TubeWrapGeometry['holes'] = [];
  for (let child of tube.children ?? []) {
    if ((child.type as string) === 'tubehole') {
      for (const mark of tubeHoleMarks(child)) holes.push({ ...mark, x: radius * mark.angle, label: child.name ?? 'Vent / marking hole' });
      continue;
    }
    const isFin = WRAP_FINS.has(child.type);
    if (!isFin && child.type !== 'launchlug' && child.type !== 'railbutton') continue;
    if (child.type === 'freeformfinset' && child['points'] == null) {
      child = { ...child, points: KERNEL_DEFAULT_FIN_POINTS.map(p => [...p]) };
    }
    const rootLength = isFin ? finRootChord(child) : axialLength(child);
    // A closed freeform list repeats its origin; finRootChord drops that repeat (as cut templates do).
    const start = axialStart(child, rootLength, tubeStart, length) - tubeStart;
    const root = { start, end: start + rootLength };
    const cant = isFin && Math.abs(num(child, 'cant', 0)) > 1e-9;
    if (cant) notes.push(`${child.name ?? 'Fin set'} has cant: lines show the reference angles; slot outlines are omitted. Check the fitted fin before cutting.`);
    const tab = isFin && !cant && tube['filled'] !== true ? finTabSpan(child, rootLength, radius) : null;
    const thickness = isFin ? kernelNum(child, 'thickness') : 0;
    if (tab && !(thickness > 0)) notes.push(`${child.name ?? 'Fin set'} has no positive thickness: slot outlines are omitted.`);
    const slot = tab && thickness > 0
      ? { start: start + tab.x0, end: start + tab.x1, width: thickness } : null;
    const count = isFin ? finCountOf(child) : lineInstanceCount(child);
    for (let i = 0; i < count; i++) {
      const rawAngle = isFin ? num(child, 'rotation', 0) + 2 * Math.PI * i / count
        : num(child, 'angleOffset', 0);
      let angle = ((rawAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      // C-A8: a negative rounding residual must share the zero-angle seam's label and solid fin mark.
      if (2 * Math.PI - angle < 1e-9) angle = 0;
      const instanceStart = isFin ? 0 : i * num(child, 'instanceSeparation', 0);
      lines.push({
        label: `${child.name ?? (isFin ? 'Fin set' : child.type === 'launchlug' ? 'Launch lug' : 'Rail button')} ${i + 1}`,
        kind: isFin ? 'fin' : 'guide', angle, x: radius * angle,
        root: { start: root.start + instanceStart, end: root.end + instanceStart }, slot,
      });
    }
  }
  if (lines.some(l => l.root.start < -1e-9 || l.root.end > length + 1e-9)) {
    notes.push('Some parts extend past this tube. The wrap stops at the tube ends; check the fitted parts before cutting.');
  }
  if (holes.length) notes.push(TUBE_HOLE_ADVICE);
  if (holes.some(hole => hole.station - hole.diameter / 2 < 0 || hole.station + hole.diameter / 2 > length)) {
    notes.push('Some hole marks extend past this tube. Check their position and diameter before drilling.');
  }
  return { name: tube.name ?? 'Body tube', diameter: radius * 2, circumference, length, lines, holes, notes: [...new Set(notes)] };
}

export interface TubeWrapPage {
  column: number;
  row: number;
  /** Tile origin, metres around the tube and aft of its front. */
  x: number;
  y: number;
  svg: string;
}

/** 210 x 279 mm fits A4 and US Letter; every sheet repeats the ruler and instructions. */
export function tubeWrapPages(
  guide: TubeWrapGeometry, rocketName: string, units: Pick<UnitSelection, 'length' | 'angle'>,
  background: FinTemplateBackground = 'white',
): TubeWrapPage[] {
  const printedNotes = guide.notes.flatMap(note => {
    const result: string[] = [];
    let line = note === TUBE_HOLE_ADVICE ? '' : 'Caution:';
    for (const word of note.split(/\s+/)) {
      if (line.length + word.length > 95) { result.push(line); line = ''; }
      line += `${line ? ' ' : ''}${word}`;
    }
    if (line) result.push(line);
    return result;
  });
  if (printedNotes.length > 24) throw new Error('Too many notes to fit on a wrap page. Check the fin and tube dimensions.');
  const width = 180, height = 200 - printedNotes.length * 5, overlap = 10, left = 15, top = 65 + printedNotes.length * 5;
  const circumference = guide.circumference * 1000, length = guide.length * 1000;
  const columns = Math.max(1, Math.ceil((circumference - overlap) / (width - overlap)));
  const rows = Math.max(1, Math.ceil((length - overlap) / (height - overlap)));
  if (!Number.isFinite(columns * rows) || columns * rows > 100) {
    throw new Error('This wrap needs more than 100 pages. Check the tube dimensions before exporting.');
  }
  const dim = (m: number) => `${fmtSi('length', units.length, m, 3)} ${units.length}`;
  const inches = units.length === 'in' || units.length === 'ft';
  const ruler = inches ? 50.8 : 50;
  const rulerCaption = inches ? '2 in' : dim(0.05);
  const pages: TubeWrapPage[] = [];
  const f = (v: number) => v.toFixed(4);
  const clockKey = (line: TubeWrapLine) => f(line.x * 1000);
  const finClocks = new Set(guide.lines.filter(line => line.kind === 'fin').map(clockKey));
  const labels = new Map<string, string[]>();
  for (const line of guide.lines) {
    const key = clockKey(line);
    labels.set(key, [...(labels.get(key) ?? []), line.label]);
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = column * (width - overlap), y = row * (height - overlap);
      const endX = Math.min(x + width, circumference), endY = Math.min(y + height, length);
      const text = (words: string, ty: number, size = 3.2) =>
        `<text x="15" y="${ty}" font-size="${size}" textLength="${Math.min(180, words.length * size * 0.55)}" lengthAdjust="spacingAndGlyphs">${escapeXml(words)}</text>`;
      const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="279mm" viewBox="0 0 210 279"${background === 'white' ? ' style="background:#fff"' : ''}>`,
        '<g font-family="sans-serif" fill="#000">',
        text(`${rocketName} — ${guide.name}: tube wrap`, 12, 3.8),
        text(`Scale 1:1 — print at 100%, no fit to page. Check the ruler on every page.`, 18),
        text(`OD ${dim(guide.diameter)} · circumference ${dim(guide.circumference)} · length ${dim(guide.length)}`, 24),
        text(`Page ${pages.length + 1}/${rows * columns}: column ${column + 1}/${columns}, row ${row + 1}/${rows}. Around ${dim(x / 1000)}; aft ${dim(y / 1000)}.`, 30),
        text(`Join matching coordinates with ${dim(overlap / 1000)} overlap. Trim at the tube outline; wrap printed side out.`, 36),
        text('Front of tube at top; aft at bottom. Solid: fins; dashed: lug/button. Boxes: tab slots.', 42),
        text('Slots use fin thickness, with no cutting allowance. Measure the tube and check the fit before cutting.', 48),
        `<text x="${left + ruler + 3}" y="58" font-size="3.2">${escapeXml(rulerCaption)}</text>`,
        '</g>',
        `<g fill="none" stroke="#000" stroke-width="0.2"><line id="calibration-ruler" x1="15" y1="58" x2="${left + ruler}" y2="58"/>`,
      ];
      for (let i = 0; i <= 5; i++) {
        const rx = left + ruler * i / 5;
        svg.push(`<line x1="${rx}" y1="55" x2="${rx}" y2="58"/>`);
      }
      svg.push('</g>', '<g font-family="sans-serif" fill="#000">',
        ...printedNotes.map((note, i) => text(note, 65 + i * 5, 3)), '</g>',
        `<g transform="translate(${f(left - x)} ${f(top - y)})" fill="none" stroke="#000" stroke-width="0.2">`);
      // Clip coordinates, not SVG clipPaths: some downstream SVG readers ignore clipping paths.
      const segment = (x1: number, y1: number, x2: number, y2: number) =>
        `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`;
      if (column === 0) svg.push(segment(0, y, 0, endY));
      if (endX === circumference) svg.push(segment(circumference, y, circumference, endY));
      if (row === 0) svg.push(segment(x, 0, endX, 0));
      if (endY === length) svg.push(segment(x, length, endX, length));
      const occupiedText: { left: number; right: number; top: number; bottom: number }[] = [];
      // Grid coordinates repeat on overlapping sheets so they can be joined without rescaling.
      for (let gx = Math.ceil(x / 10) * 10; gx <= endX; gx += 10) {
        svg.push(`<line x1="${gx}" y1="${y}" x2="${gx}" y2="${endY}" stroke="#888" stroke-dasharray="0.5 2" stroke-width="0.1"/>`);
        if (gx % 20 === 0 && gx + 15 < endX && endY - y > 4) {
          svg.push(`<text x="${gx + 1}" y="${y + 4}" fill="#000" stroke="none" font-size="2.4" font-family="sans-serif">${escapeXml(dim(gx / 1000))}</text>`);
          occupiedText.push({ left: gx + 1, right: gx + 1 + dim(gx / 1000).length * 2.4, top: y + 1.6, bottom: y + 4.6 });
        }
      }
      for (let gy = Math.ceil(y / 10) * 10; gy <= endY; gy += 10) {
        svg.push(`<line x1="${x}" y1="${gy}" x2="${endX}" y2="${gy}" stroke="#888" stroke-dasharray="0.5 2" stroke-width="0.1"/>`);
        if (gy % 20 === 0 && gy > y + 5 && gy + 3 < endY) {
          svg.push(`<text x="${x + 1}" y="${gy + 3}" fill="#000" stroke="none" font-size="2.4" font-family="sans-serif">${escapeXml(dim(gy / 1000))}</text>`);
          occupiedText.push({ left: x + 1, right: x + 1 + dim(gy / 1000).length * 2.4, top: gy + 0.6, bottom: gy + 3.6 });
        }
      }
      const labelPlacements = new Map<string, { x: number; y: number; length: number; text: string }>();
      const pendingLabels = [...labels.keys()].map(key => {
        const line = guide.lines.find(l => clockKey(l) === key)!;
        const cx = line.x * 1000;
        const name = labels.get(key)!.join(' / ');
        const text = `${name.slice(0, 36)}${name.length > 36 ? '…' : ''} · ${fmtSi('angle', units.angle, line.angle, 2)} ${units.angle}`;
        return { key, cx, x: cx + 5 >= endX ? cx - 4 : cx + 2, text };
      }).filter(label => label.cx >= x && label.cx <= endX && label.cx < circumference - 1e-6)
        .sort((a, b) => a.x - b.x);
      // C-A8: nearby clock lines need separate axial bands; presence alone does not make a label readable.
      for (let i = 0; i < pendingLabels.length;) {
        let next = i + 1;
        while (next < pendingLabels.length && pendingLabels[next]!.x - pendingLabels[next - 1]!.x < 5) next++;
        const start = y + (endY - y <= 20 ? 2 : 10);
        const band = (endY - start - 2) / (next - i);
        for (let j = i; j < next; j++) {
          const label = pendingLabels[j]!;
          labelPlacements.set(label.key, { x: label.x, y: start + (j - i) * band,
            length: Math.min(label.text.length * 1.65, band - (next - i > 1 ? Math.min(2, band / 4) : 0)), text: label.text });
        }
        i = next;
      }
      if (endY - y > 6) {
        for (const label of labelPlacements.values()) {
          occupiedText.push({ left: label.x - 0.75, right: label.x + 3, top: label.y, bottom: label.y + label.length });
        }
      }
      const drawnMarks = new Set<string>();
      // N045: a cross locates the drill centre; the dashed circle states the diameter.
      // Repeat seam and overlap centres, without introducing cutting edges at page joins.
      for (const hole of guide.holes) {
        const hy = hole.station * 1000;
        if (hy < y || hy > endY) continue;
        for (const hx of [hole.x * 1000 - circumference, hole.x * 1000, hole.x * 1000 + circumference]) {
          if (hx < x || hx > endX) continue;
          const cross = 2;
          // A diameter circle is drawn only when it fits the tile; the cross always marks its centre.
          const hr = hole.diameter * 500;
          svg.push(`<g class="drilling-mark"><title>${escapeXml(`${hole.label}: diameter ${dim(hole.diameter)}; fabrication only`)}</title>`);
          if (hx - hr >= x && hx + hr <= endX && hy - hr >= y && hy + hr <= endY) {
            svg.push(`<circle cx="${f(hx)}" cy="${f(hy)}" r="${f(hr)}" stroke-dasharray="1 1"/>`);
          }
          svg.push(segment(Math.max(x, hx - cross), hy, Math.min(endX, hx + cross), hy),
            segment(hx, Math.max(y, hy - cross), hx, Math.min(endY, hy + cross)), '</g>');
          const caption = `${hole.label.slice(0, 24)}: ${dim(hole.diameter)}`;
          // N045: edge and overlap centres still need a printed diameter, not just a title.
          const captionLength = Math.min(Math.max(1, endX - x - 2), caption.length * 1.3);
          const captionX = Math.max(x + 1, Math.min(hx + 3, endX - captionLength - 1));
          const preferredY = Math.max(y + 3, hy + 5 < endY ? hy + 4 : hy - 3);
          // N045: allocate whole caption rectangles, including repeated seam/overlap centres
          // and rotated fin/guide text. Keep the font size; do not crush collisions to fit.
          const baselines = [preferredY];
          for (let offset = 4; offset <= endY - y; offset += 4) baselines.push(preferredY + offset, preferredY - offset);
          baselines.push(y + 3, endY - 1);
          const starts = [captionX, x + 1, endX - captionLength - 1];
          for (let start = x + 1; start + captionLength < endX; start += 4) starts.push(start);
          let placement: { x: number; y: number } | undefined;
          for (const start of starts) {
            for (const baseline of baselines) {
              const box = { left: start, right: start + captionLength, top: baseline - 2.4, bottom: baseline + 0.6 };
              if (box.left < x || box.right > endX || box.top < y || box.bottom > endY) continue;
              if (occupiedText.some(other => box.left < other.right + 0.8 && other.left < box.right + 0.8
                && box.top < other.bottom + 0.8 && other.top < box.bottom + 0.8)) continue;
              occupiedText.push(box);
              placement = { x: start, y: baseline };
              break;
            }
            if (placement) break;
          }
          if (!placement) throw new Error('Hole captions do not fit on this wrap page. Reduce the number of marks or shorten their names before exporting.');
          svg.push(`<line class="hole-caption-leader" x1="${f(hx)}" y1="${f(hy)}" x2="${f(placement.x)}" y2="${f(placement.y - 1.2)}" stroke-width="0.1" stroke-dasharray="0.5 1"/>`,
            `<text x="${f(placement.x)}" y="${f(placement.y)}" fill="#000" stroke="none" font-size="2.4" font-family="sans-serif" textLength="${f(captionLength)}" lengthAdjust="spacingAndGlyphs">${escapeXml(caption)}</text>`);
        }
      }
      for (const line of guide.lines) {
        const lx = line.x * 1000;
        // Repeat the zero-angle line at the seam's far edge, including half-slots.
        const copies = [lx - circumference, lx, lx + circumference];
        for (const cx of copies) {
          if (cx >= x && cx <= endX) {
            const markKey = f(cx);
            if (!drawnMarks.has(markKey)) {
              svg.push(`<line class="marking-line" x1="${f(cx)}" y1="${f(y)}" x2="${f(cx)}" y2="${f(endY)}"${!finClocks.has(clockKey(line)) ? ' stroke-dasharray="3 2"' : ''}/>`);
            }
            if (!drawnMarks.has(markKey) && cx < circumference - 1e-6 && endY - y > 6) {
              const label = labelPlacements.get(clockKey(line))!;
              svg.push(`<text transform="translate(${f(label.x)} ${f(label.y)}) rotate(90)" fill="#000" stroke="none" font-size="3" font-family="sans-serif" textLength="${f(label.length)}" lengthAdjust="spacingAndGlyphs">${escapeXml(label.text)}</text>`);
            }
            drawnMarks.add(markKey);
            for (const station of [line.root.start, line.root.end]) {
              if (station * 1000 >= y && station * 1000 <= endY) {
                svg.push(`<line x1="${f(Math.max(x, cx - 2))}" y1="${f(station * 1000)}" x2="${f(Math.min(endX, cx + 2))}" y2="${f(station * 1000)}" stroke-width="0.5"/>`);
              }
            }
          }
          if (line.slot) {
            const leftEdge = cx - line.slot.width * 500, rightEdge = cx + line.slot.width * 500;
            const front = line.slot.start * 1000, aft = line.slot.end * 1000;
            const sx = Math.max(x, leftEdge), ex = Math.min(endX, rightEdge);
            const sy = Math.max(y, front), ey = Math.min(endY, aft);
            if (ex > sx && ey > sy) {
              // C-A8/R09: clipping a closed rectangle invents cutting edges at page joins and the seam.
              const slotEdge = (x1: number, y1: number, x2: number, y2: number) =>
                `<line class="tab-slot" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke-width="0.35"/>`;
              for (const edge of [leftEdge, rightEdge]) {
                if (edge >= x && edge <= endX) svg.push(slotEdge(edge, sy, edge, ey));
              }
              for (const edge of [front, aft]) {
                if (edge >= y && edge <= endY) svg.push(slotEdge(sx, edge, ex, edge));
              }
            }
          }
        }
      }
      svg.push('</g>', '<g font-family="sans-serif" fill="#000" font-size="3">',
        text('Left/right tube edges meet at the 0-angle seam. Keep the front and aft directions aligned.', 274, 2.8), '</g>', '</svg>');
      pages.push({ column: column + 1, row: row + 1, x: x / 1000, y: y / 1000, svg: svg.join('\n') });
    }
  }
  return pages;
}
