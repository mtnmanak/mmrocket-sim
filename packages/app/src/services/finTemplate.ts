import type { ComponentNode } from '@online-openrocket/engine';
import { escapeXml as esc } from './xmlUtil.js';

/**
 * True-scale SVG fin templates — print at 100% (or feed to a laser cutter)
 * and cut. The SVG uses PHYSICAL millimeter units, so a browser's print
 * dialog at 100% renders the fin at its real size; a 50 mm calibration
 * ruler is included to verify the printer didn't scale.
 *
 * Geometry mirrors the engine's fin planforms:
 * - trapezoid: root at y=0, tip chord offset by sweep;
 * - elliptical: half-ellipse over the root chord;
 * - freeform: the editor's own points, leading-root → trailing-root.
 * A through-the-wall tab (when present) hangs BELOW the root line exactly
 * as the kernel models it.
 */

interface Pt { x: number; y: number }

/** Fin outline in meters, root chord on y=0, nose-side at x=0. */
export function finOutline(node: ComponentNode): Pt[] {
  const n = (k: string, fb: number) => (typeof node[k] === 'number' ? (node[k] as number) : fb);
  switch (node.type) {
    case 'trapezoidfinset': {
      const root = n('rootChord', 0.05);
      const tip = n('tipChord', 0.03);
      const sweep = n('sweep', 0.02);
      const height = n('height', 0.03);
      return [
        { x: 0, y: 0 },
        { x: sweep, y: height },
        { x: sweep + tip, y: height },
        { x: root, y: 0 },
      ];
    }
    case 'ellipticalfinset': {
      const root = n('rootChord', 0.05);
      const height = n('height', 0.03);
      const pts: Pt[] = [];
      const STEPS = 64;
      for (let i = 0; i <= STEPS; i++) {
        const t = (Math.PI * i) / STEPS;
        pts.push({ x: (root / 2) * (1 - Math.cos(t)), y: height * Math.sin(t) });
      }
      return pts;
    }
    case 'freeformfinset': {
      const raw = (node['points'] as [number, number][] | undefined) ?? [];
      return raw.map(([x, y]) => ({ x, y }));
    }
    default:
      throw new Error(`Not a fin set: ${node.type}`);
  }
}

/** Tab rectangle in meters (below the root line), or null. */
export function tabOutline(node: ComponentNode, rootLen: number): { x0: number; x1: number; depth: number } | null {
  const n = (k: string, fb: number) => (typeof node[k] === 'number' ? (node[k] as number) : fb);
  const depth = n('tabHeight', 0);
  const len = n('tabLength', 0);
  if (depth <= 0 || len <= 0) return null;
  const offset = n('tabOffset', 0);
  const method = String(node['tabOffsetMethod'] ?? 'middle');
  let x0: number;
  if (method === 'top') x0 = offset;
  else if (method === 'bottom') x0 = rootLen - len + offset;
  else x0 = (rootLen - len) / 2 + offset;
  return { x0, x1: x0 + len, depth };
}

export function finTemplateSvg(node: ComponentNode, rocketName: string): string {
  const outline = finOutline(node);
  if (outline.length < 3) throw new Error('This fin set has no usable outline.');
  const mm = (m: number) => m * 1000;
  const xs = outline.map((p) => mm(p.x));
  const ys = outline.map((p) => mm(p.y));
  const rootLenM = Math.max(...outline.map((p) => p.x));
  const tab = tabOutline(node, rootLenM);
  const tabDepthMm = tab ? mm(tab.depth) : 0;

  // Tabs can extend past the outline on BOTH sides (a 'top' tab with a
  // negative offset starts left of x=0) — include them or they get clipped.
  const minX = Math.min(0, ...xs, tab ? mm(tab.x0) : 0);
  const maxX = Math.max(...xs, tab ? mm(tab.x1) : 0);
  const maxY = Math.max(...ys);

  // Layout: margin, fin (flipped so height grows UP on paper), root line,
  // tab below, then the label block + calibration ruler.
  const M = 15;
  const labelBlock = 34;
  const w = maxX - minX + 2 * M;
  const h = maxY + tabDepthMm + labelBlock + 2 * M;
  const X = (v: number) => v - minX + M;
  const Y = (v: number) => M + maxY - v; // flip: y up

  const outlinePath = outline
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${X(mm(p.x)).toFixed(3)} ${Y(mm(p.y)).toFixed(3)}`)
    .join(' ') + ' Z';

  const count = typeof node['finCount'] === 'number' ? (node['finCount'] as number) : 3;
  const thickness = typeof node['thickness'] === 'number' ? (node['thickness'] as number) * 1000 : null;
  const cross = typeof node['crossSection'] === 'string' ? (node['crossSection'] as string) : 'square';
  const name = node.name ?? 'Fin set';

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}mm" height="${h.toFixed(1)}mm" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}">`);
  lines.push('<!-- Online OpenRocket fin template — PRINT AT 100% SCALE -->');
  // Cut layer: hairline outline, no fill (laser-cutter friendly).
  lines.push('<g fill="none" stroke="#000" stroke-width="0.2">');
  lines.push(`<path d="${outlinePath}"/>`);
  if (tab) {
    const y0 = Y(0);
    lines.push(`<path d="M ${X(mm(tab.x0)).toFixed(3)} ${y0.toFixed(3)} L ${X(mm(tab.x0)).toFixed(3)} ${(y0 + tabDepthMm).toFixed(3)} L ${X(mm(tab.x1)).toFixed(3)} ${(y0 + tabDepthMm).toFixed(3)} L ${X(mm(tab.x1)).toFixed(3)} ${y0.toFixed(3)}"/>`);
  }
  lines.push('</g>');
  // Root-chord reference line (dashed — fold/alignment, not a cut).
  lines.push(`<line x1="${X(0).toFixed(3)}" y1="${Y(0).toFixed(3)}" x2="${X(mm(rootLenM)).toFixed(3)}" y2="${Y(0).toFixed(3)}" stroke="#888" stroke-width="0.15" stroke-dasharray="2 1.5"/>`);

  // Label block + 50 mm calibration ruler.
  const ty = M + maxY + tabDepthMm + 8;
  lines.push(`<g font-family="sans-serif" font-size="3.2" fill="#333">`);
  lines.push(`<text x="${M}" y="${ty}">${esc(rocketName)} — ${esc(name)} (cut ${count})</text>`);
  lines.push(`<text x="${M}" y="${ty + 5}">root ${(rootLenM * 1000).toFixed(1)} mm · height ${maxY.toFixed(1)} mm${thickness !== null ? ` · thickness ${thickness.toFixed(1)} mm` : ''} · ${esc(cross)} cross-section${tab ? ` · tab ${tabDepthMm.toFixed(1)} mm deep` : ''}</text>`);
  lines.push(`<text x="${M}" y="${ty + 10}">Print at 100% — the ruler below must measure exactly 50 mm.</text>`);
  lines.push('</g>');
  const ry = ty + 14;
  lines.push(`<g stroke="#000" stroke-width="0.2">`);
  lines.push(`<line x1="${M}" y1="${ry}" x2="${M + 50}" y2="${ry}"/>`);
  for (let i = 0; i <= 5; i++) {
    lines.push(`<line x1="${M + i * 10}" y1="${ry - (i % 5 === 0 ? 3 : 2)}" x2="${M + i * 10}" y2="${ry}"/>`);
  }
  lines.push('</g>');
  lines.push(`<text x="${M + 52}" y="${ry}" font-family="sans-serif" font-size="3.2" fill="#333">50 mm</text>`);
  lines.push('</svg>');
  return lines.join('\n');
}
