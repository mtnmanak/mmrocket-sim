import { useState } from 'react';
import { openPrintDocument } from '../services/printDocument.js';
import { Note } from './Note.js';

export function DesignPrintReport({ prepare, menu = false }: { prepare: () => string; menu?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  return <>
    <button type="button" className={menu ? undefined : 'file-btn'} onClick={() => {
      try { openPrintDocument(prepare()); setError(null); }
      catch (e) { setError(`Could not open the report: ${e instanceof Error ? e.message : String(e)}`); }
    }}>Print design / flight report…</button>
    {error && <Note tier="caution" as="p" role="alert" className="hint">{error}</Note>}
  </>;
}
