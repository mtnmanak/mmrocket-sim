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
import { downloadBlob } from '../services/saveFile.js';

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
      && (!q || p.partNo.toLowerCase().includes(q)
        || p.description.toLowerCase().includes(q)
        // Manufacturer too. Without it, typing the most obvious thing — the
        // company's name — matched nothing at all, while the dropdown beside
        // the box filtered on exactly that field. Added alongside the
        // 2026-09-01a manufacturer consolidation, because one canonical
        // spelling is only useful if you can search for it.
        || p.manufacturer.toLowerCase().includes(q)));
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
    downloadBlob(new Blob([presetsToCsv(rows)], { type: 'text/csv' }),
      `presets-${kind}.csv`, 'Comma-separated values');
  };

  /**
   * A material density that did not parse is worse than a missing one.
   * `csvToPresets` sets `density: Number(cell)` with no finite check (unlike
   * the dimensional columns beside it), and a spreadsheet round-trip readily
   * writes "1,250" (thousands separator, or a non-en locale) or "0.68 g/cm3" —
   * both `NaN`. Storing that row puts the material NAME on the component while
   * the density is silently dropped (JSON.stringify turns NaN into null and
   * presetPatch skips null), so a part relabelled fibreglass keeps on being
   * weighed as cardboard, with no error and no red field anywhere. Reject the
   * row at import instead, and name it.
   */
  const badDensity = (d: unknown) => !(typeof d === 'number' && Number.isFinite(d) && d > 0);
  const rowIsSound = (p: Preset) =>
    !(p.material && badDensity(p.material.density))
    && !(p.lineMaterial && badDensity(p.lineMaterial.density));

  const importCsv = async (file: File) => {
    try {
      const parsed = csvToPresets(await file.text());
      if (parsed.length === 0) {
        setNote('No presets found in that CSV.');
        return;
      }
      const good = parsed.filter(rowIsSound);
      const dropped = parsed.length - good.length;
      const droppedNote = dropped > 0
        ? ` ${dropped} row(s) skipped — the material density was not a plain number`
          + ` (first: ${parsed.find((p) => !rowIsSound(p))!.partNo}).`
        : '';
      if (good.length === 0) {
        setNote(`Nothing imported.${droppedNote}`);
        return;
      }
      // Imported rows replace custom presets with the same kind+manufacturer+partNo.
      const key = (p: Preset) => `${p.kind}|${p.manufacturer}|${p.partNo}`;
      const keep = loadCustomPresets().filter((p) => !good.some((q) => key(q) === key(p)));
      saveCustomPresets([...keep, ...good]);
      // Read the store back before claiming the import worked.
      // `saveCustomPresets` swallows the setItem failure and returns void, and
      // localStorage is the ONLY place custom presets live — there is no
      // in-memory copy — so on a QuotaExceededError (a re-imported ~1,300-row
      // tube list, a private window, blocked site data) the table quietly
      // reloads the OLD rows while the note claims the new ones were stored.
      const stored = new Set(loadCustomPresets().map(key));
      const missing = good.filter((p) => !stored.has(key(p))).length;
      setAll(null);
      loadPresets().then(setAll);
      setNote(missing > 0
        ? `Could not store ${missing} of ${good.length} preset(s) — this browser's storage`
          + ` is full or blocked, so they are not in the list.${droppedNote}`
        : `Imported ${good.length} preset(s) — stored in this browser.${droppedNote}`);
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
          {/* A placeholder is not an accessible name — a screen reader reached
              this box as a bare "search edit". The label also has to name the
              THIRD field the filter matches: manufacturer, added with the
              2026-09-01a consolidation (see the rows filter above). */}
          <input type="search" placeholder="Search part number / description…" style={{ flex: 1 }}
            aria-label="Search part number, description or manufacturer"
            value={text} onChange={(e) => setText(e.target.value)} />
          <select aria-label="Filter by manufacturer" value={mfr}
            onChange={(e) => setMfr(e.target.value)} style={{ maxWidth: 220 }}>
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
