// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import { finAlignmentJigSvg } from '../services/finAlignmentJig.js';
import { tubeWrapGeometry, tubeWrapPages } from '../services/tubeWrapGuide.js';
import { FinAlignmentJigMenu } from './FinAlignmentJigMenu.js';
import { TubeWrapMenu } from './TubeWrapMenu.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => localStorage.clear());

it.each([
  ['mm', '50 mm', '50 mm (1.969 in)'],
  ['cm', '5 cm', '5 cm (1.969 in)'],
  ['m', '0.05 m', '0.05 m (1.969 in)'],
  ['in', '2 in', '2 in (50.8 mm)'],
  ['ft', '2 in', '2 in (50.8 mm)'],
])('matches jig and tube hints to their printed rulers in %s', (length, label, hint) => {
  const units = { ...INITIAL_UNITS, length };
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units }));
  const fin = { type: 'freeformfinset' as const, thickness: 0.002, finCount: 3,
    crossSection: 'airfoil', points: [[0, 0], [0.02, 0.02], [0.04, 0]] };
  const tube = { type: 'bodytube' as const, id: 'tube', outerRadius: 0.025, length: 0.3, children: [fin] };
  const tree = { components: [tube] };
  const host = document.createElement('div'), root = createRoot(host);
  try {
    act(() => root.render(<PrefsProvider>
      <section id="jig"><FinAlignmentJigMenu tree={tree} tube={tube} fin={fin} /></section>
      <section id="wrap"><TubeWrapMenu tree={tree} tube={tube} /></section>
    </PrefsProvider>));
    expect(finAlignmentJigSvg(tube, fin, 0.0002, 'Rocket', units)).toContain(`>${label}</text>`);
    for (const page of tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', units)) {
      expect(page.svg).toContain(`>${label}</text>`);
    }
    expect.soft(host.querySelector('#jig')!.textContent).toContain(`Measure the ruler: ${hint}.`);
    expect.soft(host.querySelector('#wrap')!.textContent).toContain(`Measure the ruler on every page: ${hint}.`);
  } finally { act(() => root.unmount()); host.remove(); }
});
