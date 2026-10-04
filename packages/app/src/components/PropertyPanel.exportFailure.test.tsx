// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { componentSolid } from '../tree/solidMesh.js';
import { downloadBlob } from '../services/saveFile.js';

vi.mock('../services/saveFile.js', () => ({ downloadBlob: vi.fn() }));

/**
 * THE 🖨 BUTTON WHEN THE EXPORT THROWS (audit 2026-09-22).
 *
 * Its handler awaits the solid builder, the print-pack builder and a lazily
 * loaded STL writer; any of them rejecting (a geometry the mesher cannot
 * close, a chunk that will not load offline) was an unhandled rejection — a
 * button that silently does nothing, which this panel's own comments call a
 * broken button. It now says why, in the export note under it.
 */
vi.mock('../tree/solidMesh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tree/solidMesh.js')>()),
  componentSolid: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nose = {
  id: 'n1', type: 'nosecone', name: 'Nose',
  shape: 'ogive', shapeParameter: 1, length: 0.3048, aftRadius: 0.0381, thickness: 0.002,
} as unknown as ComponentNode;
const tree = {
  name: 'Rocket',
  components: [{ id: 's1', type: 'stage', children: [nose] }],
} as unknown as RocketTree;

let host: HTMLDivElement;
let root: Root;
const rejections: unknown[] = [];
/** Node's unhandledRejection listener: it is handed the rejection's reason, of any type. */
const onRejection = (reason: unknown) => { rejections.push(reason); };

beforeEach(() => {
  localStorage.clear();
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  process.off('unhandledRejection', onRejection);
  vi.mocked(componentSolid).mockReset();
  vi.mocked(downloadBlob).mockReset();
});

describe('PropertyPanel — an export that throws says so', () => {
  it('reports an unusable fin template and clears the note after a successful retry', () => {
    const fin: ComponentNode = { type: 'freeformfinset', id: 'f', name: 'Fins', points: [] };
    const t: RocketTree = { name: 'R', components: [{ type: 'stage', children: [{
      type: 'bodytube', outerRadius: 0.02, length: 0.2, children: [fin],
    }] }] };
    const render = () => act(() => root.render(
      <PrefsProvider><PropertyPanel tree={t} node={fin} onPatch={() => {}} /></PrefsProvider>,
    ));
    render();
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent!.includes('Fin template'))!;
    act(() => button.click());
    expect(host.querySelector('.print-note-warn[role="alert"]')?.textContent)
      .toBe('Could not export this fin template. Check the outline in the fin editor before exporting.');
    expect(downloadBlob).not.toHaveBeenCalled();
    fin['points'] = [[0, 0], [0.025, 0.05], [0.075, 0.05], [0.05, 0]];
    render();
    act(() => button.click());
    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(host.querySelector('.print-note-warn[role="alert"]')).toBeNull();
  });
  it('the 🖨 STL button reports the failure in its note instead of rejecting', async () => {
    vi.mocked(componentSolid).mockRejectedValue(new Error('mesher gave up'));
    act(() => root.render(
      <PrefsProvider><PropertyPanel tree={tree} node={nose} onPatch={() => {}} /></PrefsProvider>,
    ));
    const print = [...host.querySelectorAll('button')].find((b) => b.textContent!.startsWith('🖨'))!;
    await act(async () => { print.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const alert = host.querySelector('.print-note-warn[role="alert"]');
    expect(alert?.textContent).toBe('Couldn\'t export this part: mesher gave up');
    expect(rejections).toEqual([]);
  });
});
