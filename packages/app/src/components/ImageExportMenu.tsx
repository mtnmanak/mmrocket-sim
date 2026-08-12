import { useEffect, useRef, useState } from 'react';
import { IMAGE_WIDTHS, type ImageFormat } from '../services/schematicExport.js';

/**
 * Format × resolution picker for the 2D/3D image exports (issue 2026-08-11b:
 * JPG option + resolution choices). One trigger button, a small popover with
 * a PNG row and a JPG row of width presets. Shared by TreeSchematic (2D
 * rasterize) and Rocket3D (hi-res re-render snapshot) so the two views offer
 * the identical picker.
 */
export function ImageExportMenu({ label, title, onPick }: {
  label: string;
  title: string;
  onPick: (format: ImageFormat, widthPx: number) => void;
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

  const widthLabel = (w: number) => (w >= 7680 ? '8K' : w >= 3840 ? '4K' : 'HD');

  return (
    <div ref={wrap} style={{ position: 'relative', display: 'inline-block' }}>
      <button className="file-btn" title={title} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <div role="menu" style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 30,
          background: 'var(--surface-1)', border: '1px solid var(--border, #444)',
          borderRadius: 6, padding: 6, boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          display: 'grid', gridTemplateColumns: 'auto repeat(3, auto)', gap: 4,
          whiteSpace: 'nowrap', fontSize: 12,
        }}>
          {(['png', 'jpeg'] as ImageFormat[]).map((fmt) => (
            [
              <span key={`${fmt}-label`} style={{ alignSelf: 'center', padding: '0 6px', color: 'var(--text-muted, #999)' }}>
                {fmt === 'png' ? 'PNG' : 'JPG'}
              </span>,
              ...IMAGE_WIDTHS.map((w) => (
                <button key={`${fmt}-${w}`} className="file-btn"
                  title={`${w} px wide`}
                  onClick={() => { setOpen(false); onPick(fmt, w); }}>
                  {widthLabel(w)}
                </button>
              )),
            ]
          ))}
        </div>
      )}
    </div>
  );
}
