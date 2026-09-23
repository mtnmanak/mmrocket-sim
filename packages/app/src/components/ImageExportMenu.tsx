import { useEffect, useRef, useState } from 'react';
import { IMAGE_WIDTHS, type ImageFormat } from '../services/schematicExport.js';
import { useMenuPopup } from './useDialog.js';

/** Per-export toggles carried alongside the format/width choice. Nothing here
 *  is persisted — the picker is reopened for every export anyway. */
export interface ImageExportOptions {
  /** Reframe the camera so the subject fills the exported frame (3D only). */
  fit: boolean;
}

/**
 * Format × resolution picker for the 2D/3D image exports (issue 2026-08-11b:
 * JPG option + resolution choices). One trigger button, a small popover with
 * a PNG row and a JPG row of width presets. Shared by TreeSchematic (2D
 * rasterize) and Rocket3D (hi-res re-render snapshot) so the two views offer
 * the identical picker. The 3D view additionally opts into the "fit rocket to
 * frame" toggle it needs to spend its megapixels on the rocket.
 *
 * A DISCLOSURE, like the header's Save As / Export popup — not a menu (audit
 * 2026-09-22). It declared `role="menu"` over plain buttons, which are not
 * menuitems, so assistive tech pruned them and announced an empty menu;
 * Escape did nothing; and its six buttons had three names, "HD", "4K" and
 * "8K", each twice. useMenuPopup gives it the header popups' Escape and
 * focus return, and each button now names its format and width.
 */
export function ImageExportMenu({ label, title, onPick, fitOption }: {
  label: string;
  title: string;
  /** May be async. The menu fires it and does not wait, so a handler reports
   *  its own failure — both callers' do, through their onError. */
  onPick: (format: ImageFormat, widthPx: number, opts: ImageExportOptions) => void | Promise<void>;
  /** Show the "Fit rocket to frame" checkbox. The 2D export has no camera —
   *  it already draws the whole rocket at identity view — so only the 3D view
   *  opts in, and its `opts.fit` is forced false everywhere else. */
  fitOption?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Default ON: an export that wastes 80 % of its pixels on background is
  // never what was wanted, and the unchecked path is byte-for-byte the old
  // behaviour for anyone who disagrees.
  const [fit, setFit] = useState(true);
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

  const widthLabel = (w: number) => (w >= 7680 ? '8K' : w >= 3840 ? '4K' : 'HD');
  const formatLabel = (fmt: ImageFormat) => (fmt === 'png' ? 'PNG' : 'JPG');

  return (
    <div ref={wrap} style={{ position: 'relative', display: 'inline-block' }}>
      <button className="file-btn" title={title} aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <div className="image-export-popup" role="group" aria-label="Image export — format and width" style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 30,
          background: 'var(--surface-1)', border: '1px solid var(--border, #444)',
          borderRadius: 6, padding: 6, boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          display: 'grid', gridTemplateColumns: 'auto repeat(3, auto)', gap: 4,
          whiteSpace: 'nowrap', fontSize: 12,
        }}>
          {(['png', 'jpeg'] as ImageFormat[]).map((fmt) => (
            [
              <span key={`${fmt}-label`} style={{ alignSelf: 'center', padding: '0 6px', color: 'var(--text-muted, #999)' }}>
                {formatLabel(fmt)}
              </span>,
              ...IMAGE_WIDTHS.map((w) => (
                // The name OPENS with the button's own text ("HD"), so voice
                // control's "click HD" still finds it, then says which row.
                <button key={`${fmt}-${w}`} className="file-btn"
                  title={`${w} px wide`}
                  aria-label={`${widthLabel(w)} ${formatLabel(fmt)}, ${w} px wide`}
                  onClick={() => { setOpen(false); void onPick(fmt, w, { fit: !!fitOption && fit }); }}>
                  {widthLabel(w)}
                </button>
              )),
            ]
          ))}
          {fitOption && (
            // Spans the whole grid under the format rows — it modifies every
            // button above it, so it reads as a setting, not a fourth width.
            <label style={{
              gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6,
              marginTop: 2, paddingTop: 5, borderTop: '1px solid var(--border, #444)',
              color: 'var(--text-muted, #999)', cursor: 'pointer',
            }} title="Move the camera in so the rocket fills the exported image — your viewing angle is kept, only the framing changes">
              <input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} />
              Fit rocket to frame
            </label>
          )}
        </div>
      )}
    </div>
  );
}
