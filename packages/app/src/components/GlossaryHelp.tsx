import { lazy, Suspense, useState } from 'react';

const GuideDialog = lazy(() => import('./GuideDialog.js').then(m => ({ default: m.GuideDialog })));

/** Touch and keyboard share the guide's modal and its focus-return behavior. */
export function GlossaryHelp({ term, label }: { term?: string; label: string }) {
  const [open, setOpen] = useState(false);
  if (!term) return null;
  return <>
    <button type="button" className="glossary-help" aria-label={`Definition: ${label}`}
      aria-haspopup="dialog" onClick={() => setOpen(true)}><span aria-hidden="true">ⓘ</span></button>
    {open && <Suspense fallback={<span role="status">Opening definition…</span>}>
      <GuideDialog initialAnchor={`glossary-${term}`} onClose={() => setOpen(false)} />
    </Suspense>}
  </>;
}
