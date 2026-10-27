import { useRef, useState, type RefObject } from 'react';
import { safeName } from '../services/fileName.js';
import { saveFile, saveOutcomeNote } from '../services/saveFile.js';
import { Note } from './Note.js';
import { SAMPLE_WIDTH, drawLineSample, type LegendEntry } from '../chartLegend.js';
import tokens from 'virtual:mmr-brand-tokens';

/** Caption text is prose, so the brand's display face (body text at 400). A
 *  canvas needs a concrete family list, not var(--mmr-font-display): the
 *  brand's own stack, from tokens.json. */
const CAPTION_FONT = tokens.font.display;
/** Legend labels are chart text: the data face, as the live legend sets them. */
const LEGEND_FONT = tokens.font.data;

/** The image's series key: each series' line sample (colour + dash) beside its name in the text ink. */
export interface PlotLegend {
  entries: LegendEntry[];
  /** The series' CSS stroke width (--chart-series-width). */
  strokeWidth: number;
}

/**
 * C-E7: include identity and units in the file itself, with an opaque surface.
 * The live legend is DOM, not canvas, so the image draws its own: one row of
 * line samples under the captions, each named in the text ink, never in the
 * series colour (mmr-brand SPEC §3.2).
 */
export function plotPng(source: HTMLCanvasElement, captions: string[], background: string, ink: string,
  legend?: PlotLegend): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  const ctx = canvas.getContext('2d');
  if (!ctx || !source.width || !source.height) return Promise.reject(new Error('The plot canvas is unavailable.'));
  const fontSize = 14 * Math.max(1, source.width / Math.max(1, source.clientWidth || source.width));
  const lines: string[] = [];
  ctx.font = `${fontSize}px ${CAPTION_FONT}`;
  for (const caption of captions) {
    let line = '';
    for (const word of caption.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > canvas.width - 24) { lines.push(line); line = ''; }
      // A component name can be one long token; keep all its characters.
      for (const char of (line ? ` ${word}` : word)) {
        if (line && ctx.measureText(line + char).width > canvas.width - 24) { lines.push(line); line = ''; }
        line += char;
      }
    }
    if (line) lines.push(line);
  }
  // Lay the legend out in rows that fit the width: sample, gap, name, gap.
  const scale = fontSize / 14;
  // The ratio the plot canvas was drawn at (uPlot: CSS size × pxRatio). The
  // samples take the plotted lines' device-px width and dash from it, so a
  // pattern in the key is the pattern on the plot at any screen ratio.
  const ratio = source.clientWidth ? source.width / source.clientWidth : scale;
  const sample = SAMPLE_WIDTH * scale;
  const legendFont = `${fontSize * 0.9}px ${LEGEND_FONT}`;
  const legendRows: { x: number; entry: LegendEntry }[][] = [];
  if (legend?.entries.length) {
    ctx.font = legendFont;
    let row: { x: number; entry: LegendEntry }[] = [];
    let x = 12;
    for (const entry of legend.entries) {
      const w = sample + 6 * scale + ctx.measureText(entry.label).width;
      if (row.length && x + w > canvas.width - 12) { legendRows.push(row); row = []; x = 12; }
      row.push({ x, entry });
      x += w + 18 * scale;
    }
    legendRows.push(row);
  }
  const top = (lines.length + legendRows.length + 1) * fontSize * 1.5;
  canvas.height = source.height + Math.ceil(top);
  ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ink; ctx.font = `${fontSize}px ${CAPTION_FONT}`;
  lines.forEach((line, i) => ctx.fillText(line, 12, (i + 1) * fontSize * 1.5));
  ctx.font = legendFont;
  legendRows.forEach((row, r) => {
    const y = (lines.length + r + 1) * fontSize * 1.5;
    for (const { x, entry } of row) {
      drawLineSample(ctx, x, y - fontSize * 0.35, entry, legend!.strokeWidth, scale, ratio);
      ctx.fillStyle = ink;
      ctx.fillText(entry.label, x + sample + 6 * scale, y);
    }
  });
  ctx.drawImage(source, 0, Math.ceil(top));
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob)
    : reject(new Error('The browser could not create a PNG.')), 'image/png'));
}

export function PlotImage({ container, title, captions = [], legend = [] }: {
  container: RefObject<HTMLDivElement | null>; title: string; captions?: string[];
  /** The plotted series, drawn as the image's legend. */
  legend?: LegendEntry[];
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; severity: 'info' | 'warn' } | null>(null);
  // Save completion can arrive after the branch or chart has been removed.
  const button = useRef<HTMLButtonElement>(null);
  const save = async () => {
    setBusy(true); setMessage(null);
    try {
      const el = container.current;
      const canvas = el?.querySelector('canvas');
      if (!el || !canvas) throw new Error('The plot canvas is unavailable.');
      const css = getComputedStyle(el);
      // Outside a themed root, the brand's light plot ground and text (tokens.json).
      const blob = await plotPng(canvas, [title, ...captions], css.getPropertyValue('--surface-1').trim() || tokens.theme.light.bg,
        css.getPropertyValue('--text-primary').trim() || tokens.theme.light.text,
        { entries: legend, strokeWidth: Number(css.getPropertyValue('--chart-series-width')) || 2 });
      const out = await saveFile(blob, { suggestedName: `${safeName(title).slice(0, 180)}.png`, mime: 'image/png',
        extensions: ['.png'], description: 'Flight plot image' });
      if (button.current) setMessage(saveOutcomeNote(out));
    } catch (e) {
      if (button.current) setMessage({ text: `Image could not be saved: ${e instanceof Error ? e.message : String(e)}`, severity: 'info' });
    } finally { if (button.current) setBusy(false); }
  };
  return <div className="plot-image-control">
    <button ref={button} className="chart-btn" disabled={busy} aria-label={`Save image: ${title}`} onClick={() => void save()}>
      {busy ? 'Saving image…' : 'Save image'}
    </button>
    <div role="status">{message && <Note as="p" tier={message.severity === 'warn' ? 'caution' : 'information'}>{message.text}</Note>}</div>
  </div>;
}
