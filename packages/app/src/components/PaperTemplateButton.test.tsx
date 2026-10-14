// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { openPrintDocument } from '../services/printDocument.js';

vi.mock('../services/printDocument.js', async original => ({
  ...await original<typeof import('../services/printDocument.js')>(), openPrintDocument: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div'); document.body.append(host);
const root = createRoot(host);
const mount = (node: ComponentNode) => {
  const tree: RocketTree = { name: 'Rocket', components: [{ type: 'stage', id: 's', children: [node] }] };
  act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={node} onPatch={() => {}} /></PrefsProvider>));
};
const button = () => [...host.querySelectorAll('button')].find(b => b.textContent!.includes('Paper template (1:1)'));
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
  act(() => button()!.click());
  expect(openPrintDocument).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Caution:.*diameter/);
  mount({ id: 'p2', type: 'bulkhead', outerRadius: 0.03 });
  vi.mocked(openPrintDocument).mockImplementation(() => { throw new Error('Pop-up blocked'); });
  act(() => button()!.click());
  expect(host.textContent).toContain('Pop-up blocked');
  vi.mocked(openPrintDocument).mockImplementation(() => {});
  act(() => button()!.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it('does not offer a second paper template for fins or tubes', () => {
  mount({ id: 'p', type: 'bodytube' }); expect(button()).toBeUndefined();
  mount({ id: 'p2', type: 'freeformfinset' }); expect(button()).toBeUndefined();
});
