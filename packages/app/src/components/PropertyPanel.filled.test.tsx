// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { importOrk } from '../services/orkFile.js';
import { updateNode } from '../tree/treeModel.js';
import { blankValue } from '../tree/schema.js';

/**
 * A SOLID part (Solid (filled)) has no bore, so the panel shows no inner
 * diameter for it. The box is the wall read the other way round — outer
 * diameter less two walls — and a filled part flies no wall: the kernel's
 * BodyTube.getInnerRadius is 0 when filled. A solid 40 mm rod with a 1 mm wall
 * showed an Inner diameter of 38 mm, and ticking Solid on any tube saved with a
 * wall did the same (claim check of the v0.147 notes). The Wall thickness box
 * stays, as it does on a solid nose cone: the wall comes back with the untick.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

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
});

const render = (part: Record<string, unknown>) => {
  const tree = { name: 'R', components: [{ id: 's1', type: 'stage', children: [part] }] } as unknown as RocketTree;
  act(() => root.render(
    <PrefsProvider>
      <PropertyPanel tree={tree} node={part as unknown as ComponentNode} onPatch={() => {}} />
    </PrefsProvider>,
  ));
};
const box = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

it.each([['nosecone', 'aftradius', 'Base inner diameter', '2', '36'],
  ['bodytube', 'radius', 'Inner diameter', '0.3', '39.4']] as const)(
  'S4a-g3 restores the default wall controls after unticking an imported filled %s', (type, radius, bore, wall, inside) => {
    const imported = importOrk(`<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents>
      <${type}><name>Solid</name><length>0.1</length><${radius}>0.02</${radius}><thickness>filled</thickness></${type}>
      </subcomponents></stage></subcomponents></rocket></openrocket>`).tree;
    function FilledPanel() {
      const [tree, setTree] = useState<RocketTree>(imported);
      const node = tree.components[0]!.children![0]!;
      return <PrefsProvider><PropertyPanel tree={tree} node={node}
        onPatch={patch => setTree(updateNode(tree, node.id!, patch))} /></PrefsProvider>;
    }
    act(() => root.render(<FilledPanel />));
    expect(box(bore)).toBeNull();
    const solid = [...host.querySelectorAll('label')].find(label => label.textContent?.includes('Solid (filled)'))!
      .querySelector<HTMLInputElement>('input')!;
    expect(solid.checked).toBe(true);
    act(() => solid.click());
    expect(box('Wall thickness (mm)')?.placeholder).toBe(`default: ${wall}`);
    expect(box(bore)?.value).toBe(inside);
    act(() => { box('Wall thickness (mm)')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    expect(Number(box('Wall thickness (mm)')!.value)).toBeGreaterThan(Number(wall));
    expect(blankValue('bodytube', 'length')).toBeUndefined();
    expect(blankValue('transition', 'foreRadius')).toBeUndefined();
  },
);

describe('a solid part shows no inner diameter', () => {
  const tube = { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001 };

  it('a hollow body tube shows the bore its wall leaves', () => {
    render(tube);
    expect(box('Inner diameter')?.value).toBe('38');
    render({ ...tube, filled: false });
    expect(box('Inner diameter')?.value).toBe('38');
  });

  it('a solid body tube shows none, and keeps its Wall thickness box', () => {
    render({ ...tube, filled: true });
    expect(box('Inner diameter')).toBeNull();
    expect(box('Wall thickness (mm)')).not.toBeNull();
  });

  it('a solid nose cone shows no Base inner diameter either', () => {
    const nose = { id: 'n1', type: 'nosecone', length: 0.1, aftRadius: 0.02, thickness: 0.002, shape: 'ogive' };
    render(nose);
    expect(box('Base inner diameter')?.value).toBe('36');
    render({ ...nose, filled: true });
    expect(box('Base inner diameter')).toBeNull();
  });
});
