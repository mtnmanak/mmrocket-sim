import { useEffect, useRef, useState } from 'react';
import { FIN_TEMPLATE_DPI } from '../services/finTemplate.js';
import { useMenuPopup } from './useDialog.js';

/** The four files 📐 Fin template can write. */
export type FinTemplateFormat = 'svg-white' | 'svg-transparent' | 'png' | 'jpeg';

/**
 * The choices, in the order offered. The white SVG leads — it is the default
 * Eric ruled (2026-10-11): it prints, views and converts with a white page,
 * where the transparent one shows grey in a viewer and turns black as a JPEG
 * (@atestani, TRF). The transparent SVG stays for anyone whose laser or CAD
 * workflow wants the file exactly as it was.
 */
export const FIN_TEMPLATE_FORMATS: Array<{ format: FinTemplateFormat; label: string; title: string }> = [
  {
    format: 'svg-white',
    label: 'SVG, white background (recommended)',
    title: 'True-scale vector file with a white page — prints at 100 %, opens in a browser or CAD program, and converts to an image without a black background',
  },
  {
    format: 'svg-transparent',
    label: 'SVG, transparent background',
    title: 'The same vector file with no page colour — for a laser or CAD program that wants nothing but the lines',
  },
  {
    format: 'png',
    label: `PNG image, white, ${FIN_TEMPLATE_DPI} dpi`,
    title: `A picture of the template at ${FIN_TEMPLATE_DPI} dots per inch, white background — the resolution is written in the file, so an import at ${FIN_TEMPLATE_DPI} dpi is 1:1`,
  },
  {
    format: 'jpeg',
    label: `JPG image, white, ${FIN_TEMPLATE_DPI} dpi`,
    title: `A picture of the template at ${FIN_TEMPLATE_DPI} dots per inch, white background — the resolution is written in the file, so an import at ${FIN_TEMPLATE_DPI} dpi is 1:1`,
  },
];

/**
 * 📐 Fin template's format choice — one trigger, a small disclosure with one
 * button per file. The same pattern as the 2D/3D ⬇ Image picker
 * (ImageExportMenu): a group of plain buttons, not a role="menu" of
 * non-menuitems, with useMenuPopup's Escape and focus return.
 */
export function FinTemplateMenu({ onPick }: {
  /** May be async; the menu does not wait, so the handler reports its own failure. */
  onPick: (format: FinTemplateFormat) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  useMenuPopup(open, () => setOpen(false));

  return (
    <div ref={wrap} style={{ position: 'relative', marginTop: 6 }}>
      <button className="file-btn" style={{ width: '100%' }} aria-expanded={open}
        title="True-scale 1:1 cut template with the through-the-wall tab and a 50 mm calibration ruler — choose SVG (white or transparent background) or a PNG/JPG image"
        onClick={() => setOpen((v) => !v)}>
        📐 Fin template (1:1) ▾
      </button>
      {open && (
        <div className="image-export-popup" role="group" aria-label="Fin template — file format" style={{
          position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, zIndex: 30,
          background: 'var(--surface-1)', border: '1px solid var(--border, #444)',
          borderRadius: 6, padding: 6, boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          display: 'grid', gap: 4, fontSize: 12,
        }}>
          {FIN_TEMPLATE_FORMATS.map(({ format, label, title }) => (
            <button key={format} className="file-btn" style={{ textAlign: 'left' }} title={title}
              onClick={() => { setOpen(false); void onPick(format); }}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
