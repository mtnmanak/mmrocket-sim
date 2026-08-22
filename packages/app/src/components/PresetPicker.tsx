import { useEffect, useMemo, useState } from 'react';
import { clickable } from './clickable.js';
import { useDialog } from './useDialog.js';
import type { ComponentNode, ComponentType } from '@online-openrocket/engine';
import {
  KIND_FOR_TYPE, csvToPresets, loadCustomPresets, loadPresets, presetPatch,
  presetsToCsv, saveCustomPresets, type Preset,
} from '../services/presets.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { siToUi } from '../prefs/units.js';

const ROW_CAP = 300;

/**
 * Component preset chooser over the bundled openrocket-database catalog
 * (plus user CSV imports). Applying a preset patches the node's dimensions,
 * material, and — when the catalog lists a real-world mass — a mass override.
 */
export function PresetPicker({ type, onApply, onClose }: {
  type: ComponentType;
  onApply: (patch: Partial<ComponentNode>) => void;
  onClose: () => void;
}) {
  const { prefs } = usePrefs();
  const lenSym = prefs.units.length;
  const kind = KIND_FOR_TYPE[type]!;

  const [all, setAll] = useState<Preset[] | null>(null);
  const [text, setText] = useState('');
  const [mfr, setMfr] = useState('');
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    loadPresets().then(setAll).catch((e) => setNote(`Could not load presets: ${e}`));
  }, []);

  const ofKind = useMemo(
    () => (all ?? []).filter((p) => p.kind === kind),
    [all, kind],
  );
  const manufacturers = useMemo(
    () => [...new Set(ofKind.map((p) => p.manufacturer))].sort(),
    [ofKind],
  );
  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    return ofKind.filter((p) =>
      (!mfr || p.manufacturer === mfr)
      && (!q || p.partNo.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)));
  }, [ofKind, mfr, text]);

  const dim = (p: Preset): string => {
    const v = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined);
    const d = v('outsideDiameter') ?? v('aftOutsideDiameter') ?? v('diameter');
    const len = v('length');
    const f = (x: number) => `${siToUi('length', lenSym, x).toFixed(1)}`;
    return [d !== undefined ? `⌀${f(d)}` : null, len !== undefined ? `L${f(len)}` : null]
      .filter(Boolean).join(' ') + ` ${lenSym}`;
  };

  const exportCsv = () => {
    const blob = new Blob([presetsToCsv(rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `presets-${kind}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importCsv = async (file: File) => {
    try {
      const parsed = csvToPresets(await file.text());
      if (parsed.length === 0) {
        setNote('No presets found in that CSV.');
        return;
      }
      // Imported rows replace custom presets with the same kind+manufacturer+partNo.
      const key = (p: Preset) => `${p.kind}|${p.manufacturer}|${p.partNo}`;
      const keep = loadCustomPresets().filter((p) => !parsed.some((q) => key(q) === key(p)));
      saveCustomPresets([...keep, ...parsed]);
      setAll(null);
      loadPresets().then(setAll);
      setNote(`Imported ${parsed.length} preset(s) — stored in this browser.`);
    } catch (e) {
      setNote(`CSV import failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const dialogRef = useDialog(onClose);

  return (
    <div className="prefs-overlay" role="presentation" onClick={onClose}>
      <div className="prefs-dialog panel motor-browser" role="dialog" aria-modal="true" aria-label="Component presets"
        ref={dialogRef} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ flex: 1 }}>
            {kind} presets
            <span className="motor-db-meta">openrocket-database{all ? ` · ${ofKind.length} parts` : ''}</span>
          </h2>
          <button className="file-btn" onClick={exportCsv} title="Export the current list as CSV">⬇ CSV</button>
          <label className="file-btn" title="Import an edited CSV (adds/updates your own presets)">
            ⬆ CSV
            <input type="file" accept=".csv" style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importCsv(f);
                e.target.value = '';
              }} />
          </label>
          <button className="file-btn" onClick={onClose} aria-label="Close presets">✕ Close</button>
        </div>

        <div className="motor-filter-row" style={{ marginBottom: 8 }}>
          <input type="search" placeholder="Search part number / description…" style={{ flex: 1 }}
            value={text} onChange={(e) => setText(e.target.value)} />
          <select value={mfr} onChange={(e) => setMfr(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">All manufacturers</option>
            {manufacturers.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="motor-table-wrap">
          {!all && !note && <p className="placeholder">Loading preset database…</p>}
          <table className="motor-table">
            <tbody>
              {rows.slice(0, ROW_CAP).map((p, i) => (
                <tr key={`${p.manufacturer}|${p.partNo}|${i}`} className="motor-row"
                  {...clickable(() => { onApply(presetPatch(type, p)); onClose(); })}>
                  <td>{p.manufacturer}</td>
                  <td><strong>{p.partNo}</strong></td>
                  <td>{p.description}</td>
                  <td>{dim(p)}</td>
                  <td>{p.material?.name ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {all && rows.length === 0 && (
            <p className="placeholder" style={{ padding: 16 }}>No presets match.</p>
          )}
          {rows.length > ROW_CAP && (
            <p className="motor-db-meta" style={{ padding: '6px 8px' }}>
              Showing {ROW_CAP} of {rows.length} — narrow the search.
            </p>
          )}
        </div>
        {note && <p className="motor-db-meta" style={{ marginBottom: 0 }}>{note}</p>}
      </div>
    </div>
  );
}
