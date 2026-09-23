// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { componentSolid } from '../tree/solidMesh.js';

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
const onRejection = (e: PromiseRejectionEvent | unknown) => { rejections.push(e); };

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
});

describe('PropertyPanel — an export that throws says so', () => {
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
