import { useId, useRef, useState } from 'react';
import type { FlightTree } from '../model/design.js';
import { cleanDesignProvenance, PROVENANCE_FIELDS, validRevisionDate } from '../services/designProvenance.js';
import { Note } from './Note.js';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const rows = (s: string) => Math.max(4, Math.min(16, s.split('\n').length));

/** C-A9: the root's notes use the same edit/history path as the rocket name. */
export function DesignNotesPanel({ tree, onChange, onAddRevision }: {
  tree: FlightTree; onChange: (tree: FlightTree) => void; onAddRevision: (tree: FlightTree) => void;
}) {
  const id = useId();
  const dateInput = useRef<HTMLInputElement>(null);
  const p = tree.provenance ?? {};
  const [date, setDate] = useState(today);
  const [text, setText] = useState('');
  const [dateError, setDateError] = useState(false);
  const patch = (key: keyof typeof PROVENANCE_FIELDS, value: string) => {
    const next = { ...tree };
    const provenance = cleanDesignProvenance({ ...p, [key]: value });
    if (provenance) next.provenance = provenance;
    else delete next.provenance;
    onChange(next);
  };
  const add = () => {
    if (!text.trim()) return;
    if (!validRevisionDate(date)) {
      setDateError(true); dateInput.current?.focus(); return;
    }
    // An entry is one discrete undo step, separate from typing its draft.
    onAddRevision({ ...tree, provenance: { ...p, revisions: [...(p.revisions ?? []), { date, text }] } });
    setText(''); setDateError(false);
  };
  return <details className="design-notes">
    <summary>Design notes</summary>
    <div className="design-notes-fields">
      {(Object.entries(PROVENANCE_FIELDS) as [keyof typeof PROVENANCE_FIELDS, string][]).map(([key, label]) => {
        const value = p[key] ?? '';
        const multiline = key === 'comment' || key === 'revision';
        return <div className="field" key={key}>
          <label htmlFor={`${id}-${key}`}>{label}</label>
          {multiline ? <textarea id={`${id}-${key}`} rows={rows(value)} value={value}
            onChange={e => patch(key, e.target.value)} />
            : <input id={`${id}-${key}`} value={value} onChange={e => patch(key, e.target.value)} />}
        </div>;
      })}
      <h3>Revision log</h3>
      <Note tier="information" as="p">Add dated notes for changes to the design. Use Revision above for desktop OpenRocket's revision text.</Note>
      {p.revisions?.length ? <ol className="design-revision-log" aria-label="Revision log">
        {p.revisions.map((entry, i) => <li key={i}>
          <time dateTime={entry.date}>{entry.date}</time><p>{entry.text}</p>
        </li>)}
      </ol> : <p>No dated revisions yet.</p>}
      <div className="field">
        <label htmlFor={`${id}-date`}>Entry date</label>
        {/* A local calendar day; the native picker follows the user's browser locale. */}
        <input ref={dateInput} id={`${id}-date`} type="date" value={date}
          aria-invalid={dateError || undefined} aria-describedby={dateError ? `${id}-date-error` : undefined}
          onChange={e => { setDate(e.target.value); setDateError(false); }} />
        {/* Always mounted (audit 2026-09-22): an alert inserted with its text
            already in place is announced unreliably. sr-only while empty, so
            .field's flex gap does not space an empty region. */}
        <div role="alert" className={dateError ? 'revision-date-alert' : 'revision-date-alert sr-only'}>
          {dateError && <p id={`${id}-date-error`}>Choose a valid date before adding the revision.</p>}
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${id}-note`}>Revision note</label>
        <textarea id={`${id}-note`} aria-label="Revision note" rows={rows(text)} value={text} onChange={e => setText(e.target.value)} />
      </div>
      <button type="button" className="file-btn" disabled={!text.trim()} onClick={add}>Add revision</button>
      <Note tier="information" as="p">Save .ork to keep these notes. Designer, Kit name, Design comments and Revision use desktop OpenRocket's fields.
        Kit manufacturer, Kit part number and the dated revision log are kept by the app; desktop OpenRocket does not keep them when saving again.
        Saving .rkt loses design notes. Saving .CDX1 keeps Design comments and loses the other notes; the app uses the first line of comment text as the rocket name when reopening.</Note>
    </div>
  </details>;
}
