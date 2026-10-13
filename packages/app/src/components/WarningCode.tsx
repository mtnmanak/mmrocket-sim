import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { explanationFor, NOTE_EXPLANATIONS, staticWarningCode } from '../services/noteExplanations.js';
import { formatWarningText } from '../services/simWarnings.js';
import { useBackdropClose, useDialog } from './useDialog.js';

function WarningLookup({ code, onClose }: { code: string; onClose: () => void }) {
  const [selected, setSelected] = useState(code);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const dialog = useDialog(onClose);
  const backdrop = useBackdropClose(onClose);
  const explanation = explanationFor(selected);
  const matches = [...NOTE_EXPLANATIONS].filter(([key, value]) =>
    `${key} ${value.meaning}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="prefs-overlay" role="presentation" {...backdrop}>
    <div className="prefs-dialog panel warning-lookup" role="dialog" aria-modal="true" aria-label="Note explanations"
      ref={dialog} tabIndex={-1}>
      <div className="warning-lookup-header">
        <h2>Note explanations</h2>
        <button type="button" className="file-btn" onClick={onClose} aria-label="Close note explanations">Close</button>
      </div>
      <p className="warning-lookup-code">{selected}</p>
      <h3>What it means</h3><p>{explanation.meaning}</p>
      <h3>What to do</h3><p>{explanation.remedy}</p>
      <p>These notes are advice. They do not block Launch or certify a flight.</p>
      <label>Find a note code
        <input ref={input} type="search" value={query} onChange={e => setQuery(e.target.value)} />
      </label>
      {query && <button type="button" className="file-btn" aria-label="Clear note search"
        onClick={() => { setQuery(''); input.current?.focus(); }}>Clear</button>}
      <p role="status">{matches.length ? `${matches.length} codes` : 'No matching codes. Read the original note and include its code in your bug report.'}</p>
      <ul className="warning-lookup-list">
        {matches.map(([key, value]) => <li key={key}>
          <button type="button" className="file-btn" aria-pressed={key === selected} onClick={() => setSelected(key)}>
            <span className="warning-lookup-code">{key}</span> — {value.meaning}
          </button>
        </li>)}
      </ul>
    </div>
  </div>;
}

export function WarningCode({ code }: { code: string | undefined }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!code) return null;
  return <>
    {' '}<button type="button" className="warning-code" ref={trigger} aria-label={`Explain note ${code}`}
      aria-haspopup="dialog" onClick={() => setOpen(true)}>{code}</button>
    {open && createPortal(<WarningLookup code={code} onClose={() => setOpen(false)} />,
      trigger.current?.closest('.viz-root') ?? document.body)}
  </>;
}

export function StaticWarning({ text }: { text: string }) {
  return <span>{formatWarningText(text)}<WarningCode code={staticWarningCode(text)} /></span>;
}
