import { useEffect, useMemo, useState } from 'react';
import { clickable } from './clickable.js';
import { useBackdropClose, useDialog } from './useDialog.js';
import type { ComponentNode, ComponentType } from '@online-openrocket/engine';
import {
  KIND_FOR_TYPE, csvToPresets, loadCustomPresets, loadPresets, presetPatch,
  presetsToCsv, saveCustomPresets, type Preset,
} from '../services/presets.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSig, siToUi } from '../prefs/units.js';
import { downloadBlob } from '../services/saveFile.js';
import { numOpt } from '../tree/nodeNum.js';

const ROW_CAP = 300;

/**
 * Component preset chooser over the bundled openrocket-database catalog
 * (plus user CSV imports). Applying a preset patches the node's dimensions,
 * material, and — when the catalog lists a real-world mass — a mass override.
 */
export function PresetPicker({ type, node, onApply, onClose }: {
  type: ComponentType;
  /**
   * The part a pick replaces. presetPatch needs it to tell the previous part's
   * catalogue mass (cleared) from a weight the user typed (kept) — see there.
   */
  node?: ComponentNode;
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
    // Same `live` flag as RecoverySizingPanel and ScaleDialog: a ~1.3 MB load
    // behind a dialog the user can close (2026-09-08 audit).
    let live = true;
    loadPresets()
      .then((p) => { if (live) setAll(p); })
      .catch((e) => { if (live) setNote(`Could not load presets: ${e}`); });
    return () => { live = false; };
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
    const v = (k: string) => numOpt(p, k);
    const d = v('outsideDiameter') ?? v('aftOutsideDiameter') ?? v('diameter');
    const len = v('length');
    // One decimal in mm, as before; three significant figures where one decimal
    // would flatten it — a fixed `toFixed(1)` printed a 24 mm tube as "⌀0.0 m"
    // (audit 2026-09-22).
    const f = (x: number) => fmtSig(siToUi('length', lenSym, x), 3, 1);
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
  // A material needs BOTH halves. A name with no density used to skip the
  // material block at parse time and import as a clean success, so the part
  // kept its old weight under a new label — silent, which is the one outcome
  // this guard exists to prevent (2026-09-21).
  const matBad = (m?: { name: string; density: number }) =>
    !!m && (badDensity(m.density) || !m.name.trim());
  const rowIsSound = (p: Preset) => !matBad(p.material) && !matBad(p.lineMaterial);

  /** Reports every failure itself (setNote), so callers fire it with `void`. */
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
        ? ` ${dropped} row(s) skipped — a material needs both a name and a plain positive density`
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
      const imported = missing > 0
        ? `Could not store ${missing} of ${good.length} preset(s) — this browser's storage`
          + ` is full or blocked, so they are not in the list.${droppedNote}`
        : `Imported ${good.length} preset(s) — stored in this browser.${droppedNote}`;
      // The reload had no catch (audit 2026-09-22): a failure was an unhandled
      // rejection that left `all` null under the note above — and a note hides
      // the "Loading…" line — so the dialog showed an empty table. It now keeps
      // the list it had and says the new rows are in storage, not on screen.
      const before = all;
      setAll(null);
      loadPresets().then(setAll, (err: unknown) => {
        setAll(before);
        setNote(`${imported} The list could not be reloaded (${err instanceof Error ? err.message : String(err)})`
          + ' — close and reopen the presets to see the new rows.');
      });
      setNote(imported);
    } catch (e) {
      setNote(`CSV import failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const dialogRef = useDialog(onClose);
  // Closes only on a press and a release on the backdrop itself, so text
  // selected in the search box or the table and dragged past the card's edge
  // keeps it open (audit 2026-09-22).
  const backdrop = useBackdropClose(onClose);

  return (
    <div className="prefs-overlay" role="presentation" {...backdrop}>
      <div className="prefs-dialog panel motor-browser" role="dialog" aria-modal="true" aria-label="Component presets"
        ref={dialogRef} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ flex: 1 }}>
            {kind} presets
            <span className="motor-db-meta">openrocket-database{all ? ` · ${ofKind.length} parts` : ''}</span>
          </h2>
          <button className="file-btn" onClick={exportCsv}
            title={`Export all ${rows.length} row(s) matching the search — not just the ${ROW_CAP} the table shows`}>⬇ CSV</button>
          {/* Visually hidden, NOT display:none (audit 2026-09-22): the App
              header's Open… rule (styles.css .file-btn-input) — display:none
              took the input out of the Tab order, so the keyboard could not reach it. */}
          <label className="file-btn" title="Import an edited CSV (adds/updates your own presets)">
            ⬆ CSV
            <input type="file" accept=".csv" className="file-btn-input" aria-label="Import presets from a CSV file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importCsv(f);
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
            {/* A <thead> at last (2026-09-08 audit). Five unlabelled data
                columns, on the dialog whose whole job is COMPARING parts, so a
                screen reader announced every cell with no column identity. The
                sibling MotorBrowser table has had full headers with aria-sort
                throughout — this was drift between two pickers, not a decision. */}
            <thead>
              <tr>
                <th>Manufacturer</th>
                <th>Part number</th>
                <th>Description</th>
                <th>Dimensions</th>
                <th>Material</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, ROW_CAP).map((p, i) => (
                <tr key={`${p.manufacturer}|${p.partNo}|${i}`} className="motor-row"
                  {...clickable(() => {
                    onApply(presetPatch(type, p, node && { node, presets: all ?? [] }));
                    onClose();
                  })}>
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
        {/* role="status" (2026-09-08 audit): `note` carries the CSV-import
            outcome, including "Could not store N of M preset(s)" — the result of
            an async operation the user is waiting on, previously announced to
            nobody. MotorBrowser puts the same class of message in role="alert"
            and role="status" (since the 2026-09-22 audit; before that they were
            plain <p>s); this is the polite one, because it also carries
            ordinary success text. The region is ALWAYS mounted (2026-09-22): it
            was rendered only with its text already in it, and a live region
            inserted that way is announced unreliably. */}
        <div role="status">
          {note && <p className="motor-db-meta" style={{ marginBottom: 0 }}>{note}</p>}
        </div>
      </div>
    </div>
  );
}
