// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The ✂ DXF and 🖨 STL buttons size a ring-type part from the tube it sits in
 * — wired end to end (audit 2026-09-22). The panel's context builder read the
 * bore only off a parent with a numeric `outerRadius`, which an Add-menu
 * coupler never has, so a bulkhead in a coupler cut and printed as a 24.0 mm
 * disc labelled plainly "Bulkhead" on any airframe, with nothing on screen to
 * say the size was a guess.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const bulkhead = { id: 'bh', type: 'bulkhead', name: 'AV bay bulkhead', length: 0.004 } as unknown as ComponentNode;

const mount = (tree: RocketTree, node: ComponentNode) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node} onPatch={() => {}} />
  </PrefsProvider>,
));

/** Click the ✂ DXF button and return the file text it hands to the browser. */
async function dxfText(): Promise<string> {
  const blobs: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
    blobs.push(b as Blob);
    return 'blob:dxf-test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click() {};
  try {
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent!.startsWith('✂'))!;
    await act(async () => { btn.click(); });
  } finally {
    HTMLAnchorElement.prototype.click = orig;
  }
  expect(blobs.length).toBe(1);
  return blobs[0]!.text();
}

/** Every CIRCLE radius in a DXF, in mm (group 40 follows the centre). */
const circleRadii = (dxf: string): number[] => {
  const lines = dxf.split('\r\n');
  const out: number[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i] === '0' && lines[i + 1] === 'CIRCLE') {
      for (let j = i + 2; j + 1 < lines.length && lines[j] !== '0'; j += 2) {
        if (lines[j] === '40') out.push(Number(lines[j + 1]));
      }
    }
  }
  return out;
};

const note = (): HTMLElement | null => host.querySelector('.print-note');

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('PropertyPanel — a ring part sizes to the tube it sits in', () => {
  it('a bulkhead in an Add-menu coupler cuts at the coupler bore, not a 24 mm placeholder', async () => {
    // 3" airframe (R 38.1 mm, 1 mm wall) -> automatic coupler OD 74.2 mm ->
    // 0.5 mm coupler wall -> bulkhead OD 73.2 mm.
    const tree = {
      name: 'Rocket',
      components: [{ id: 's1', type: 'stage', children: [{
        id: 'b1', type: 'bodytube', outerRadius: 0.0381, thickness: 0.001, length: 0.6,
        children: [{ id: 'c1', type: 'tubecoupler', length: 0.15, thickness: 0.0005, children: [bulkhead] }],
      }] }],
    } as unknown as RocketTree;
    mount(tree, bulkhead);
    const dxf = await dxfText();
    expect(circleRadii(dxf)).toEqual([36.6]);
    expect(dxf).toContain('OD 73.2 mm');
    expect(dxf).not.toContain('ASSUMED');
    // Nothing was assumed, so the panel says nothing.
    expect(note()).toBeNull();
  });

  it('a part with no bore to size from says so under the button, and in the cut file', async () => {
    // A bulkhead at the very tip of a nose cone: the inner radius there is 0.
    const tipBulkhead = { ...bulkhead, position: { method: 'top', offset: 0 } } as unknown as ComponentNode;
    const tree = {
      name: 'Rocket',
      components: [{ id: 's1', type: 'stage', children: [{
        id: 'n1', type: 'nosecone', shape: 'conical', length: 0.2, aftRadius: 0.03, thickness: 0.002,
        children: [tipBulkhead],
      }] }],
    } as unknown as RocketTree;
    mount(tree, tipBulkhead);
    expect(note()!.textContent).toBe(
      'Diameter assumed: 24.0 mm is a placeholder — the app could not find the tube this part '
      + 'sits in. Measure the bore before you print or cut it.');
    expect(note()!.className).toContain('print-note-warn');
    const dxf = await dxfText();
    expect(circleRadii(dxf)).toEqual([12]);
    expect(dxf).toContain('OD 24.0 mm | stock thickness 4.0 mm');
    expect(dxf).toContain('OD ASSUMED: no tube found to size this part from');
  });

  it('the two buttons describe the sizing they do, not "from the parent tube"', () => {
    // A part's OWN stated diameter comes first, and the bore may be a
    // coupler's, a nose cone's or a transition's (audit 2026-09-22).
    mount({
      name: 'Rocket',
      components: [{ id: 's1', type: 'stage', children: [{
        id: 'b1', type: 'bodytube', outerRadius: 0.0381, thickness: 0.001, length: 0.6, children: [bulkhead],
      }] }],
    } as unknown as RocketTree, bulkhead);
    const titles = [...host.querySelectorAll('button')].map((b) => b.title)
      .filter((t) => t.includes('bulkheads'));
    expect(titles).toHaveLength(2);
    for (const t of titles) {
      expect(t).not.toContain('from the parent tube');
      expect(t).toContain('their own stated diameter, else the bore of the tube, coupler, nose or transition');
    }
  });
});
