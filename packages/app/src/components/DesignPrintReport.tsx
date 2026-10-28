import { useState } from 'react';
import { openPrintDocument } from '../services/printDocument.js';
import { Note } from './Note.js';

export function DesignPrintReport({ prepare, menu = false }: { prepare: () => string; menu?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  return <>
    <button type="button" className={menu ? undefined : 'file-btn'} onClick={event => {
      try { openPrintDocument(prepare()); setError(null); }
      catch (e) {
        // C-A6: keep the export disclosure open so its Caution survives a failed print action.
        event.stopPropagation();
        setError(`Could not open the report: ${e instanceof Error ? e.message : String(e)}`);
      }
    }}>Print design / flight report…</button>
    {/* Always mounted (audit 2026-09-22): an alert inserted with its text
        already in place is announced unreliably. sr-only while empty: the
        Results column, one of its two placements, is a flex column with a
        gap that would space an empty region. */}
    <div role="alert" className={error ? 'print-report-alert' : 'print-report-alert sr-only'}>
      {error && <Note tier="caution" as="p" className="hint">{error}</Note>}
    </div>
  </>;
}
