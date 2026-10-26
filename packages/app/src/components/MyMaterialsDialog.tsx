import { usePrefs } from '../prefs/PrefsContext.js';
import { useEffect, useId, useRef, useState } from 'react';
import { CSV_APOSTROPHE_HELP } from '../services/csvUtil.js';
import { flushSync } from 'react-dom';
import { Modal } from './Modal.js';
import { readDecimal } from '../prefs/units.js';
import { useUserMaterials } from './useUserMaterials.js';
import { MATERIAL_UNITS, type MaterialKind } from '../services/designMaterials.js';
import {
  importUserMaterialsCsv, loadUserMaterials, materialProblem, saveUserMaterials, userMaterialKey, userMaterialsToCsv,
  type UserMaterial,
} from '../services/userMaterials.js';
import { downloadBlob } from '../services/saveFile.js';

export const MATERIAL_STORAGE_FAILURE = 'My materials could not be saved in this browser. Storage may be full or blocked. Export CSV to keep a copy before trying again.';

export function MyMaterialsDialog({ onClose }: { onClose: () => void }) {
  const { materials, note } = useUserMaterials();
  const { prefs } = usePrefs();
  const [message, setMessage] = useState('');
  const [densityError, setDensityError] = useState('');
  const densityField = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<{ key: string; draft: UserMaterial; density: string } | null>(null);
  const [deleting, setDeleting] = useState<UserMaterial | null>(null);
  const [reading, setReading] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // The file read is asynchronous; do not write storage after this dialog closes.
  const close = () => { alive.current = false; onClose(); };
  const file = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterEdit = useRef<string | null>(null);
  const focusEditName = useRef(false);
  useEffect(() => {
    if (focusEditName.current) {
      document.getElementById(`${uid}-name`)?.focus();
      focusEditName.current = false;
    }
    if (focusAfterEdit.current === null) return;
    (editButtons.current.get(focusAfterEdit.current) ?? heading.current)?.focus();
    focusAfterEdit.current = null;
  });
  const uid = useId();
  const persist = (next: UserMaterial[], success: string): boolean => {
    if (!saveUserMaterials(next)) { setMessage(MATERIAL_STORAGE_FAILURE); return false; }
    setMessage(success);
    return true;
  };
  return <Modal label="My materials" onClose={close} className="prefs-dialog panel">
    <div style={{ overflowWrap: 'anywhere' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h2 ref={heading} tabIndex={-1} style={{ flex: 1 }}>My materials</h2>
        <button className="file-btn" type="button" onClick={close} aria-label="Close My materials">Close</button>
      </div>
      <p>Saved in this browser only. Export CSV to keep a copy or move your materials to another browser. Editing this library does not change parts already in a design.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="file-btn" type="button" aria-label="Export CSV of My materials" onClick={() => {
          try { downloadBlob(new Blob([userMaterialsToCsv(materials)], { type: 'text/csv;charset=utf-8' }), 'my-materials.csv'); }
          catch { setMessage('The CSV could not be downloaded. Try Export CSV again.'); }
        }}>⬇ Export CSV</button>
        <button className="file-btn" type="button" aria-label="Import CSV into My materials" disabled={reading} onClick={() => file.current?.click()}>⬆ Import CSV</button>
        <input ref={file} type="file" accept=".csv,text/csv" aria-label="Materials CSV file" hidden
          onChange={e => { void (async () => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (!picked) return;
            if (picked.size > 2 * 1024 * 1024) { setMessage('Materials CSV has a limit of 2 MiB. Split the file and try again.'); return; }
            setReading(true);
            try {
              const csv = await picked.text();
              if (!alive.current) return;
              // Read the current store after await, so another tab's edit is retained.
              const result = importUserMaterialsCsv(csv, loadUserMaterials(), prefs.units);
              const summary = `${result.added} added, ${result.replaced} replaced, ${result.refused} refused.`;
              const details = result.reasons.slice(0, 10).join('; ')
                + (result.reasons.length > 10 ? `; and ${result.reasons.length - 10} more` : '');
              if (result.added || result.replaced) persist(result.materials, `${summary} ${details}`);
              else setMessage(`${summary} ${details}`);
            } catch { if (alive.current) setMessage('The CSV could not be read. Choose a CSV file and try again.'); }
            finally { if (alive.current) setReading(false); }
          })(); }} />
      </div>
      <p className="comp-stats">{CSV_APOSTROPHE_HELP}</p>
      <div role="status">
        {reading && <p>Reading CSV…</p>}
        {note && <p>{note}</p>}
        {message && <p>{message}</p>}
      </div>
      {materials.length === 0 && <p>No saved materials. Save a named material from a part, or Import CSV.</p>}
      {(['bulk', 'surface', 'line'] as MaterialKind[]).map(kind => <section key={kind} aria-label={`${kind} materials`}>
        <h3>{kind === 'bulk' ? 'Bulk' : kind === 'surface' ? 'Surface' : 'Line'} ({MATERIAL_UNITS[kind]})</h3>
        <ul style={{ paddingLeft: 20 }}>
          {materials.filter(m => m.kind === kind).map(m => {
            const key = userMaterialKey(m);
            return <li key={key} style={{ marginBottom: 12 }}>
              {editing?.key === key ? <form onSubmit={e => {
                e.preventDefault();
                const density = editing.density.trim() === String(editing.draft.density)
                  ? readDecimal(editing.density, false) : readDecimal(editing.density);
                const draft = { ...editing.draft, density: density ?? NaN };
                const problem = materialProblem(draft, prefs.units);
                if (problem) {
                  setMessage(problem);
                  const densityProblem = materialProblem({ ...m, density: draft.density }, prefs.units);
                  flushSync(() => setDensityError(densityProblem ?? ''));
                  if (densityProblem) densityField.current?.focus();
                  return;
                }
                setDensityError('');
                const current = loadUserMaterials();
                if (!current.some(old => userMaterialKey(old) === key)) {
                  setMessage('This material is no longer in My materials. Close the editor and check the library.'); return;
                }
                const nextKey = userMaterialKey(draft);
                if (nextKey !== key && current.some(other => userMaterialKey(other) === nextKey)) {
                  setMessage('That name is already in My materials for this kind. Choose another name.'); return;
                }
                if (persist(current.map(old => userMaterialKey(old) === key ? draft : old), 'Material updated.')) {
                  focusAfterEdit.current = nextKey;
                  setEditing(null);
                }
              }}>
                <div className="field"><label htmlFor={`${uid}-name`}>Material name</label>
                  <input id={`${uid}-name`} maxLength={80} value={editing.draft.name}
                    onChange={e => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })} /></div>
                <div className="field"><label htmlFor={`${uid}-density`}>Density ({MATERIAL_UNITS[kind]})</label>
                  <input ref={densityField} id={`${uid}-density`} inputMode="decimal" value={editing.density}
                    aria-invalid={densityError ? true : undefined} aria-describedby={densityError ? `${uid}-density-error` : undefined}
                    onChange={e => { setDensityError(''); setEditing({ ...editing, density: e.target.value }); }} />
                  {densityError && <p id={`${uid}-density-error`}>{densityError}</p>}</div>
                <button className="file-btn" type="submit">Save material</button>{' '}
                <button className="file-btn" type="button" onClick={() => { focusAfterEdit.current = key; setEditing(null); }}>Cancel</button>
              </form> : <>
                <span>{m.name} ({m.density} {MATERIAL_UNITS[kind]})</span>{' '}
                <button className="file-btn" type="button" aria-label={`Edit ${kind} material ${m.name}`} ref={el => {
                  if (el) editButtons.current.set(key, el);
                  else editButtons.current.delete(key);
                }} onClick={() => { focusEditName.current = true; setDensityError(''); setEditing({ key, draft: { ...m }, density: String(m.density) }); setMessage(''); }}>Edit</button>{' '}
                <button className="file-btn" type="button" aria-label={`Delete ${kind} material ${m.name}`} onClick={() => { setMessage(''); setDeleting(m); }}>Delete</button>
              </>}
            </li>;
          })}
        </ul>
      </section>)}
      {deleting && <Modal label={`Delete ${deleting.kind} material ${deleting.name}?`} onClose={() => setDeleting(null)}>
        <h2>Delete {deleting.kind} material {deleting.name}?</h2>
        <p>This removes it from My materials in this browser. Parts already using it keep their material. Import a saved CSV to restore the library entry.</p>
        <div role="status">{message && <p>{message}</p>}</div>
        <button className="file-btn" type="button" onClick={() => setDeleting(null)}>Cancel</button>{' '}
        <button type="button" className="file-btn modal-danger" onClick={() => {
          if (persist(materials.filter(m => userMaterialKey(m) !== userMaterialKey(deleting)), 'Material deleted.')) {
            if (editing?.key === userMaterialKey(deleting)) setEditing(null);
            focusAfterEdit.current = '';
            setDeleting(null);
          }
        }}>Delete material</button>
      </Modal>}
    </div>
  </Modal>;
}
