import { useState } from 'react';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi } from '../prefs/units.js';
import { paperTemplateGeometry, paperTemplatePages } from '../services/paperTemplates.js';
import { openPrintDocument, printDocument } from '../services/printDocument.js';
import { solidContextFor } from '../tree/solidContext.js';
import { Note } from './Note.js';

export function PaperTemplateButton({ tree, node }: { tree: RocketTree; node: ComponentNode }) {
  const { prefs } = usePrefs();
  const [error, setError] = useState<string | null>(null);
  const curved = (node.type === 'nosecone' || node.type === 'transition')
    && (node['shape'] ?? (node.type === 'nosecone' ? 'ogive' : 'conical')) !== 'conical';
  return <>
    <button type="button" className="file-btn" style={{ marginTop: 6, width: '100%' }} onClick={() => {
      try {
        const geometry = paperTemplateGeometry(node, solidContextFor(tree, node));
        const pages = paperTemplatePages(geometry, tree.name ?? 'Rocket', prefs.units);
        openPrintDocument(printDocument(`${node.name ?? node.type} — paper template`,
          `<main class="template-scroll">${pages.map(p => `<section class="template-page">${p.svg}</section>`).join('')}</main>`, true));
        setError(null);
      } catch (e) { setError(`Could not prepare this template: ${e instanceof Error ? e.message : String(e)}`); }
    }}>Paper template (1:1)…</button>
    <Note as="p" tier="information" className="hint">Print at 100%, no fit to page. Check the ruler on every sheet: {prefs.units.length === 'in' || prefs.units.length === 'ft' ? '2 in' : `${fmtSi('length', prefs.units.length, 0.05, 3)} ${prefs.units.length}`}. Larger parts use overlapping pages.</Note>
    <Note as="p" tier={curved ? 'caution' : 'information'} className="hint">
      {curved ? 'Curved parts give a sampled side profile and station table, not a flat wrap. ' : ''}
      {node.type === 'bulkhead' || node.type === 'centeringring'
        ? 'No cutting allowance or invented drilling holes. A ring opening fits the stated ID or overlapping mount tube OD.'
        : 'Wraps cover the exterior surface only; shoulders, wall thickness, seam tabs and cutting allowance are omitted.'}
    </Note>
    {error && <Note as="p" tier="caution" role="alert" className="hint">{error}</Note>}
  </>;
}
