import { useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { exportColumnCatalog } from '../services/flightDataCsv.js';
import { configUuid } from '../services/configSnapshot.js';
import { EXPORT_EVENTS, type FlightExportLayout } from '../services/flightExportLayouts.js';
import { Modal } from './Modal.js';

const catalog = exportColumnCatalog();

export function FlightExportLayoutDialog({ layout, onClose }: {
  layout?: FlightExportLayout;
  onClose: () => void;
}) {
  const { prefs, setPrefs } = usePrefs();
  const [name, setName] = useState(layout?.name ?? '');
  const [columns, setColumns] = useState<FlightExportLayout['columns']>(() => layout?.columns ?? catalog.map(c => ({
    key: c.key, unit: c.quantity ? prefs.units[c.quantity] : c.si,
  })));
  const [events, setEvents] = useState<FlightExportLayout['events']>(layout?.events ?? {});
  const [error, setError] = useState('');
  const move = (index: number, delta: number) => {
    const next = [...columns];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    setColumns(next);
  };
  const save = () => {
    if (!name.trim() || !columns.length) { setError('Enter a layout name and select at least one column.'); return; }
    const saved = { id: layout?.id ?? configUuid(), name: name.trim(), columns, events };
    const layouts = prefs.flightExportLayouts ?? [];
    setPrefs({ ...prefs, flightExportLayouts: layout ? layouts.map(l => l.id === layout.id ? saved : l) : [...layouts, saved],
      flightExportLayoutId: saved.id });
    onClose();
  };
  return <Modal label={layout ? 'Edit export layout' : 'New export layout'} onClose={onClose}>
    <div className="flight-export-layout-editor">
    <h2>{layout ? 'Edit export layout' : 'New export layout'}</h2>
    <label style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>Layout name
      <input style={{ minWidth: 0, maxWidth: '100%' }} aria-label="Layout name" value={name} onChange={e => setName(e.target.value)} /></label>
    <p className="chart-comparison-note">These choices apply to CSV and XLSX. Missing series stay blank.
      Include Time for workbook charts.</p>
    <div className="comparison-controls">
      {(['from', 'to'] as const).map(boundary => <label key={boundary}>
        {boundary === 'from' ? 'Start event' : 'End event'}
        <select value={events[boundary] ?? ''} onChange={e => setEvents({ ...events, [boundary]: e.target.value || undefined })}>
          <option value="">{boundary === 'from' ? 'First sample' : 'Last sample'}</option>
          {EXPORT_EVENTS.map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select>
      </label>)}
    </div>
    <p className="chart-comparison-note">Each branch uses its first start event, then its first end event at or after it.
      Both boundary times are included. A branch missing either selected event has no exported samples.</p>
    <div className="comparison-controls">
      <button className="file-btn" onClick={() => setColumns([])}>Clear columns</button>
      <button className="file-btn" onClick={() => setColumns(catalog.map(c => ({ key: c.key,
        unit: c.quantity ? prefs.units[c.quantity] : c.si })))}>All columns</button>
    </div>
    <div style={{ maxHeight: '45vh', overflowY: 'auto', margin: '8px 0' }} role="group" aria-label="Export columns in order">
      {[...columns.map(c => catalog.find(d => d.key === c.key)!), ...catalog.filter(c => !columns.some(d => d.key === c.key))].map(c => {
        const index = columns.findIndex(d => d.key === c.key);
        return <div key={c.key} className="comparison-controls" style={{ padding: '4px 0' }}>
          <label style={{ flex: '1 1 160px' }}><input type="checkbox" aria-label={`Export ${c.name}`} checked={index >= 0}
            onChange={e => setColumns(e.target.checked ? [...columns, { key: c.key, unit: c.quantity ? prefs.units[c.quantity] : c.si }]
              : columns.filter(d => d.key !== c.key))} />{c.name}</label>
          {index >= 0 && <>
            <select aria-label={`${c.name} unit`} value={columns[index]!.unit} onChange={e => setColumns(columns.map((d, i) => i === index ? { ...d, unit: e.target.value } : d))}>
              {c.units.map(u => <option key={u} value={u}>{u ? u + (c.suffix ?? '') : 'No unit'}</option>)}
            </select>
            <button className="file-btn" aria-label={`Move ${c.name} up`} disabled={index === 0} onClick={() => move(index, -1)}>Up</button>
            <button className="file-btn" aria-label={`Move ${c.name} down`} disabled={index === columns.length - 1} onClick={() => move(index, 1)}>Down</button>
          </>}
        </div>;
      })}
    </div>
    {/* Always mounted (audit 2026-09-22): an alert inserted with its text already in place is announced unreliably. */}
    <div className="export-layout-alert" role="alert">{error && <p>{error}</p>}</div>
    <div className="modal-actions">
      <button className="file-btn" onClick={save}>Save layout</button>
      <button className="file-btn" onClick={onClose}>Cancel</button>
    </div>
    </div>
  </Modal>;
}
