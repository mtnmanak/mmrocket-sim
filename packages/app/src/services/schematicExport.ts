import type { StaticInfo } from '@online-openrocket/engine';
import { fmtSi, type UnitSelection } from '../prefs/units.js';
import { escapeXml } from './xmlUtil.js';

/**
 * 2D/3D image + model export with a data header (issue 2026-08-11a).
 * Modeled on RockSim's cert-packet exports (L3 / Tripoli Class 3 packets
 * include these), modernized: ONE true-scale SVG replaces RockSim's
 * "model" + "100% scale" pair — the width/height are physical millimetres,
 * so it prints 1:1 and still scales freely on screen — and PNG replaces the
 * bmp/xbm/xpm/pnm zoo.
 */

export interface ExportData {
  name: string;
  info: StaticInfo | null;
  units: UnitSelection;
  /** Full span diameter incl. fins/pods (m) — from the 2D view's measure. */
  spanM?: number;
  withMotors: boolean;
  appVersion: string;
}

/** RockSim-style header block: the numbers a cert reviewer wants on the page. */
export function dataHeaderLines(d: ExportData): string[] {
  const u = d.units;
  const lines: string[] = [d.name];
  if (d.info) {
    const i = d.info;
    const dims = [
      `Length ${fmtSi('length', u.length, i.length, 3)} ${u.length}`,
      `max diameter ${fmtSi('length', u.length, i.refDiameter, 3)} ${u.length}`,
      ...(d.spanM ? [`span ${fmtSi('length', u.length, d.spanM, 3)} ${u.length}`] : []),
    ];
    lines.push(dims.join(', '));
    lines.push(d.withMotors
      ? `Launch mass ${fmtSi('mass', u.mass, i.mass)} ${u.mass} (dry ${fmtSi('mass', u.mass, i.massEmpty)} ${u.mass})`
      : `Dry mass ${fmtSi('mass', u.mass, i.massEmpty)} ${u.mass} — no motors loaded`);
    lines.push(
      `CG ${fmtSi('length', u.length, i.cg, 3)} ${u.length}, `
      + `CP ${fmtSi('length', u.length, i.cp, 3)} ${u.length} from nose tip, `
      + `margin ${i.stabilityCalibers.toFixed(2)} cal`,
    );
  }
  lines.push(`Online OpenRocket v${d.appVersion} — ${new Date().toISOString().slice(0, 10)}`);
  return lines;
}

/** Light-theme values for the CSS variables the schematic markup uses
 *  (--accent = the selection outline when a component is selected). */
const EXPORT_VARS: [string, string][] = [
  ['var(--surface-1)', '#ffffff'],
  ['var(--text-primary)', '#20242c'],
  ['var(--accent)', '#b8511d'],
];

/**
 * Standalone SVG from the live schematic <svg>: identity view transform,
 * CSS variables baked to light-theme values, white background, data header
 * on top, physical size in mm so it prints at 100 % scale.
 *
 * @param svgEl      the live schematic svg element
 * @param pxPerM     the drawing's scale (viewBox px per metre)
 * @param viewW/viewH the drawing's viewBox size
 */
export function schematicSvg(
  svgEl: SVGSVGElement, pxPerM: number, viewW: number, viewH: number, d: ExportData,
): string {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  // Identity view: exports always show the whole rocket, whatever the
  // on-screen zoom/pan state.
  const zoomG = clone.querySelector(':scope > g');
  zoomG?.setAttribute('transform', 'translate(0 0) scale(1)');

  let inner = new XMLSerializer().serializeToString(clone);
  // The wrapper svg re-declares size/viewBox; keep only the content.
  inner = inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  for (const [v, val] of EXPORT_VARS) {
    inner = inner.split(v).join(val);
  }

  // Header band: proportional to drawing width so it stays readable at any
  // physical size (a 4 m rocket printed 1:1 gets 4 m of banner).
  const fs = Math.max(11, Math.round(viewW * 0.016));
  const lineH = Math.round(fs * 1.45);
  const lines = dataHeaderLines(d);
  const headerH = lineH * (lines.length + 1);
  const totalH = viewH + headerH;

  const mm = (px: number) => (px / pxPerM) * 1000;
  const header = lines.map((l, i) =>
    `<text x="${Math.round(fs * 0.8)}" y="${lineH * (i + 1)}" font-size="${i === 0 ? Math.round(fs * 1.25) : fs}"`
    + `${i === 0 ? ' font-weight="bold"' : ''}>${escapeXml(l)}</text>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW} ${totalH}"
  width="${mm(viewW).toFixed(2)}mm" height="${mm(totalH).toFixed(2)}mm"
  font-family="Arial, Helvetica, sans-serif" fill="#20242c">
  <rect x="0" y="0" width="${viewW}" height="${totalH}" fill="#ffffff"/>
  <g>${header}</g>
  <g transform="translate(0 ${headerH})">${inner}</g>
</svg>`;
}

/** Rasterize an SVG string to a PNG blob at the given pixel width. */
export function svgToPng(svgString: string, widthPx = 3840): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalHeight / Math.max(1, img.naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width = widthPx;
      canvas.height = Math.round(widthPx * ratio);
      const c = canvas.getContext('2d')!;
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG rasterize failed'));
    };
    img.src = url;
  });
}

/**
 * Compose a 3D-view snapshot with the data header band above it.
 * The WebGL canvas must have preserveDrawingBuffer for toDataURL/drawImage.
 */
export function snapshotWithHeader(glCanvas: HTMLCanvasElement, d: ExportData): Promise<Blob> {
  const w = glCanvas.width;
  const fs = Math.max(12, Math.round(w * 0.016));
  const lineH = Math.round(fs * 1.45);
  const lines = dataHeaderLines(d);
  const headerH = lineH * (lines.length + 1);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = headerH + glCanvas.height;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#20242c';
  lines.forEach((l, i) => {
    c.font = `${i === 0 ? 'bold ' : ''}${i === 0 ? Math.round(fs * 1.25) : fs}px Arial, Helvetica, sans-serif`;
    c.fillText(l, Math.round(fs * 0.8), lineH * (i + 1));
  });
  c.drawImage(glCanvas, 0, headerH);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
}

/** Shared download-anchor dance for the export buttons. */
export function downloadBlob(blob: Blob | string, filename: string): void {
  const b = typeof blob === 'string' ? new Blob([blob], { type: 'image/svg+xml' }) : blob;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
