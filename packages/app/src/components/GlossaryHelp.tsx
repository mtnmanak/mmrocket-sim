import { lazy, useState } from 'react';
import { createPortal } from 'react-dom';
import { LazyDialog } from './LazyDialog.js';

const GuideDialog = lazy(() => import('./GuideDialog.js').then(m => ({ default: m.GuideDialog })));

/** Touch and keyboard share the guide's modal and its focus-return behavior. */
export function GlossaryHelp({ term, label }: { term?: string; label: string }) {
  const [portalHost, setPortalHost] = useState<Element>();
  if (!term) return null;
  return <>
    <button type="button" className="glossary-help" aria-label={`Definition: ${label}`}
      aria-haspopup="dialog" onClick={event => setPortalHost(event.currentTarget.closest('.viz-root') ?? document.body)}><span aria-hidden="true">ⓘ</span></button>
    {portalHost && createPortal(<LazyDialog label="User guide" className="guide-dialog panel" onClose={() => setPortalHost(undefined)}>
      <GuideDialog initialAnchor={`glossary-${term}`} onClose={() => setPortalHost(undefined)} />
    </LazyDialog>, portalHost)}
  </>;
}
