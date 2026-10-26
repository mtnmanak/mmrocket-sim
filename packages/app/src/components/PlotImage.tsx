import { useRef, useState, type RefObject } from 'react';
import { safeName } from '../services/fileName.js';
import { saveFile, saveOutcomeNote } from '../services/saveFile.js';
import { Note } from './Note.js';

/** C-E7: include identity and units in the file itself, with an opaque surface. */
export function plotPng(source: HTMLCanvasElement, captions: string[], background: string, ink: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  const ctx = canvas.getContext('2d');
  if (!ctx || !source.width || !source.height) return Promise.reject(new Error('The plot canvas is unavailable.'));
  const fontSize = 14 * Math.max(1, source.width / Math.max(1, source.clientWidth || source.width));
  const lines: string[] = [];
  ctx.font = `${fontSize}px system-ui`;
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
  const top = (lines.length + 1) * fontSize * 1.5;
  canvas.height = source.height + Math.ceil(top);
  ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ink; ctx.font = `${fontSize}px system-ui`;
  lines.forEach((line, i) => ctx.fillText(line, 12, (i + 1) * fontSize * 1.5));
  ctx.drawImage(source, 0, Math.ceil(top));
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob)
    : reject(new Error('The browser could not create a PNG.')), 'image/png'));
}

export function PlotImage({ container, title, captions = [] }: {
  container: RefObject<HTMLDivElement | null>; title: string; captions?: string[];
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
      const blob = await plotPng(canvas, [title, ...captions], css.getPropertyValue('--surface-1').trim() || '#fff',
        css.getPropertyValue('--text-primary').trim() || '#111');
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
