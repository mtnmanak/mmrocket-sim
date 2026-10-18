import { useEffect, useId, useRef, useState } from 'react';
import type { ComponentNode } from '@online-openrocket/engine';
import { Modal } from './Modal.js';
import { Note } from './Note.js';
import {
  componentToPreset, customPartKey, customPresetLinkError, loadBundledPresets, loadCustomPresets, sameCustomPreset, saveCustomPresets,
} from '../services/presets.js';
import { mfrKey, partKey } from '../../scripts/manufacturers.mjs';

export function SaveMyPartDialog({ node, onClose, onSaved }: { node: ComponentNode; onClose: () => void; onSaved?: (name: string) => void }) {
  const uid = useId();
  const partInput = useRef<HTMLInputElement>(null);
  const [manufacturer, setManufacturer] = useState('My parts');
  const [partNo, setPartNo] = useState('');
  const [description, setDescription] = useState(node.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const cancel = () => { live.current = false; onClose(); };
  const save = async () => {
    if (saving.current) return;
    if (!partNo.trim()) {
      setError('Enter a part number.');
      partInput.current?.focus();
      return;
    }
    if (!customPartKey(partNo)) {
      setError('Enter a part number containing a letter, number or +; punctuation alone cannot identify a part.');
      partInput.current?.focus();
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const row = { ...componentToPreset(node), manufacturer: manufacturer.trim() || 'My parts', partNo: partNo.trim(), description };
      const bundled = await loadBundledPresets();
      if (!live.current) return;
      if (partKey(row.partNo) && bundled.some((p) => p.kind === row.kind && mfrKey(p.manufacturer) === mfrKey(row.manufacturer)
        && [p.partNo, ...(Array.isArray(p['altPartNos']) ? p['altPartNos'] : [])]
          .some((pn) => partKey(pn) === partKey(row.partNo)))) {
        setError('That manufacturer and part number belong to a bundled catalogue part of this kind. Choose a different manufacturer or part number.');
        return;
      }
      const keep = loadCustomPresets().filter((p) => !sameCustomPreset(p, row));
      const linkError = customPresetLinkError(row, keep);
      if (linkError) {
        setError(linkError);
        return;
      }
      if (!saveCustomPresets([...keep, row])) {
        setError('Could not save My part — this browser’s storage is full or blocked. Export your parts or free storage, then try again.');
        return;
      }
      onSaved?.(`${row.manufacturer} ${row.partNo}`);
      onClose();
    } catch {
      setError('Could not save My part. The preset catalogue could not be loaded; try again.');
    } finally {
      saving.current = false;
      if (live.current) {
        setBusy(false);
        partInput.current?.focus();
      }
    }
  };
  return <Modal label="Save as My part" onClose={cancel}>
    <h2>Save as My part</h2>
    <form noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="field"><label htmlFor={`${uid}-manufacturer`}>Manufacturer</label>
        <input id={`${uid}-manufacturer`} value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} /></div>
      <div className="field"><label htmlFor={`${uid}-part`}>Part number</label>
        <input id={`${uid}-part`} ref={partInput} required value={partNo} aria-invalid={error && !partNo.trim() ? true : undefined}
          aria-describedby={error ? `${uid}-error` : undefined} onChange={(e) => setPartNo(e.target.value)} /></div>
      <div className="field"><label htmlFor={`${uid}-description`}>Description</label>
        <input id={`${uid}-description`} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <p className="hint">Dimensions and materials are saved. Blank optional dimensions stay automatic or use their defaults; blank required dimensions keep the receiving part’s values.
        Only this part’s positive mass override is applied; computed mass and a weighing of everything inside are excluded.
        A saved parachute is fitted to its new tube when picked. A matching My part is replaced. My parts live in this browser only — export CSV to keep them.</p>
      <div role="status">{error && <Note as="p" tier="caution" id={`${uid}-error`}>{error}</Note>}</div>
      <div className="modal-actions">
        <button type="button" className="file-btn" onClick={cancel}>Cancel</button>
        <button type="submit" className="file-btn" aria-busy={busy}>Save My part</button>
      </div>
    </form>
  </Modal>;
}
