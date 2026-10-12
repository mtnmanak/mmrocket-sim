// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * D7 §5, P11: the fin STL's limitation — one flat prism, no cross-section, no
 * cant — is read WITH the export choice, not only from the 🖨 button's
 * tooltip. A rounded or airfoil fin (Eric's own designs) names its section.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { localStorage.clear(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const show = (crossSection?: string) => {
  const fin = { id: 'f1', type: 'trapezoidfinset', name: 'Fins', fins: 3, rootChord: 0.06, tipChord: 0.03,
    height: 0.05, sweepLength: 0.02, thickness: 0.003, ...(crossSection ? { crossSection } : {}) } as unknown as ComponentNode;
  const tree = { name: 'R', components: [{ id: 's1', type: 'stage', children: [
    { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001, children: [fin] },
  ] }] } as unknown as RocketTree;
  act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={fin} onPatch={() => {}} /></PrefsProvider>));
  return host.querySelector('.fin-print-scope');
};

it.each(['rounded', 'airfoil'])('names a %s cross-section the flat-prism STL leaves out, beside the export button', section => {
  const scope = show(section)!;
  expect(scope.textContent).toContain(`${section} cross-section is not in it`);
  expect(scope.textContent).toMatch(/flat prism.*cant is not baked in/);
  const stl = [...host.querySelectorAll('button')].find(b => /STL/.test(b.textContent ?? ''))!;
  expect(stl.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('says edge shaping is left to sanding for a square fin, and says nothing for a tube fin set (a ring, not a prism)', () => {
  expect(show('square')!.textContent).toMatch(/any edge shaping is left to sanding/);
  expect(show()!.textContent).toMatch(/any edge shaping is left to sanding/);
  const tubeFins = { id: 't1', type: 'tubefinset', name: 'Tube fins', fins: 6, length: 0.05 } as unknown as ComponentNode;
  const tree = { name: 'R', components: [{ id: 's1', type: 'stage', children: [
    { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001, children: [tubeFins] },
  ] }] } as unknown as RocketTree;
  act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={tubeFins} onPatch={() => {}} /></PrefsProvider>));
  expect([...host.querySelectorAll('button')].some(b => /STL/.test(b.textContent ?? ''))).toBe(true);
  expect(host.querySelector('.fin-print-scope')).toBeNull();
});
