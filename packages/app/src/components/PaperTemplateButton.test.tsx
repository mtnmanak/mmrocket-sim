// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { openPrintDocument } from '../services/printDocument.js';
import { couplerRingFitNote } from './ringFit.js';

vi.mock('../services/printDocument.js', async original => ({
  ...await original<typeof import('../services/printDocument.js')>(), openPrintDocument: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div'); document.body.append(host);
/** Text in any alert region: the regions stay mounted, empty, between messages. */
const alertTexts = () => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '').filter(Boolean);
const root = createRoot(host);
const mount = (node: ComponentNode) => {
  const tree: RocketTree = { name: 'Rocket', components: [{ type: 'stage', id: 's', children: [node] }] };
  act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={node} onPatch={() => {}} /></PrefsProvider>));
};
const button = () => [...host.querySelectorAll('button')].find(b => b.textContent!.includes('Paper template (1:1)'));
it.each([0.0099, 0.0101, 0.01025, 0.0103])('HF7 r3 carries the fit caution on the sheet for radius %s m', radius => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003, innerRadius: 0.01 };
  const tree: RocketTree = { components: [{ type: 'bodytube', length: 0.3, outerRadius: 0.03,
    children: [ring, { type: 'tubecoupler', length: 0.3,
      children: [{ type: 'innertube', length: 0.3, outerRadius: radius }] }] }] };
  act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={ring} onPatch={() => {}} /></PrefsProvider>));
  act(() => button()!.click());
  if (radius === 0.0103) {
    expect(openPrintDocument).not.toHaveBeenCalled();
    expect(alertTexts().join(' ')).toContain('The tube cannot pass through it');
  } else {
    const html = vi.mocked(openPrintDocument).mock.calls[0]![0];
    const sheet = new DOMParser().parseFromString(html, 'text/html');
    const text = [...sheet.querySelectorAll('svg text')].map(t => t.textContent).join(' ').replace(/\s+/g, ' ');
    expect(text.includes('Caution: The stated hole is')).toBe(radius !== 0.0099);
    if (radius !== 0.0099) {
      expect(text).toContain(`Caution: ${couplerRingFitNote(tree, ring)}`);
      expect(text).toContain(radius === 0.0101 ? '0.2 mm' : '0.5 mm');
      expect(text).toContain('The tube cannot pass through the stated hole.');
      expect(text).toContain('Check the tube and hole dimensions before cutting or printing.');
    }
    expect([...sheet.querySelectorAll('circle')].some(c => c.getAttribute('r') === '10.0000')).toBe(true);
  }
});
afterEach(() => { act(() => root.render(null)); vi.resetAllMocks(); localStorage.clear(); });
it.each(['bulkhead', 'centeringring', 'transition', 'nosecone'])('offers a calibrated template on %s without changing the design', type => {
  const node = { id: 'part', type, outerRadius: 0.05, innerRadius: 0.015, aftRadius: 0.05, foreRadius: 0.02, length: 0.1 } as ComponentNode;
  const before = JSON.stringify(node); mount(node);
  expect(button()).toBeDefined();
  act(() => button()!.click());
  expect(openPrintDocument).toHaveBeenCalledOnce();
  expect(vi.mocked(openPrintDocument).mock.calls[0]![0]).toContain('calibration-ruler');
  expect(JSON.stringify(node)).toBe(before);
});
it('keeps an unresolved ring or blocked preview error beside the control and allows retry', () => {
  mount({ id: 'p', type: 'centeringring' });
  // Live-region sweep (audit 2026-09-22): there, empty, before the error.
  const region = host.querySelector('.paper-template-alert');
  expect(region?.getAttribute('role')).toBe('alert');
  expect(region!.textContent).toBe('');
  act(() => button()!.click());
  expect(host.querySelector('.paper-template-alert')).toBe(region);
  expect(openPrintDocument).not.toHaveBeenCalled();
  expect(host.querySelector('.paper-template-alert[role="alert"]')!.textContent).toMatch(/Caution:.*diameter/);
  mount({ id: 'p2', type: 'bulkhead', outerRadius: 0.03 });
  vi.mocked(openPrintDocument).mockImplementation(() => { throw new Error('Pop-up blocked'); });
  act(() => button()!.click());
  expect(host.textContent).toContain('Pop-up blocked');
  vi.mocked(openPrintDocument).mockImplementation(() => {});
  act(() => button()!.click());
  expect(alertTexts()).toEqual([]);
});
it('does not offer a second paper template for fins or tubes', () => {
  mount({ id: 'p', type: 'bodytube' }); expect(button()).toBeUndefined();
  mount({ id: 'p2', type: 'freeformfinset' }); expect(button()).toBeUndefined();
});
it.each([
  ['mm', '50 mm', '50 mm (1.969 in)'],
  ['cm', '5 cm', '5 cm (1.969 in)'],
  ['m', '0.05 m', '0.05 m (1.969 in)'],
  ['in', '2 in', '2 in (50.8 mm)'],
  ['ft', '2 in', '2 in (50.8 mm)'],
])('names the actual printed calibration ruler with %s selected', (length, label, hint) => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length } }));
  mount({ id: 'p', type: 'bulkhead', outerRadius: 0.03 });
  act(() => button()!.click());
  expect(vi.mocked(openPrintDocument).mock.calls[0]![0]).toContain(`>${label}</text>`);
  expect(host.textContent).toContain(`Check the ruler on every sheet: ${hint}.`);
});
