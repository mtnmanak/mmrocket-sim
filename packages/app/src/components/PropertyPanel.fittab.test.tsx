// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * "Fit tab to motor tube" sizes a NEW tab at 60 % of the ROOT chord. For a
 * freeform fin it took the outline's furthest-aft x instead (missed by v0.105,
 * fixed with the axialLength split 2026-09-07), so on a fin whose tip
 * overhangs its root the "60 %" tab came out at 80 % of the root — 288 mm on
 * the 361 mm root of the `ninja_4in_54mm-MMT.ork` fin shape.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

const NINJA: [number, number][] = [
  [0, 0], [0.48026079897864005, 0.15594675369134], [0.405013311838459, 0.0270298288667628], [0.360761749736894, 0],
];

const withFin = (fin: Record<string, unknown>): RocketTree => ({
  name: 'R',
  components: [{
    id: 's1', type: 'stage', children: [
      { id: 'b1', type: 'bodytube', length: 0.866775, outerRadius: 0.0508, thickness: 0.0015,
        children: [
          { id: 'mmt', type: 'innertube', length: 0.4, outerRadius: 0.0286, thickness: 0.001,
            position: { method: 'bottom', offset: 0 } },
          fin,
        ] },
    ],
  }],
} as unknown as RocketTree);

const mount = (tree: RocketTree, node: ComponentNode) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node} onPatch={(p) => patches.push(p)} />
  </PrefsProvider>,
));

const fitButton = () => [...host.querySelectorAll('button')]
  .find((b) => /Fit tab to motor tube/.test(b.textContent ?? ''));

beforeEach(() => {
  localStorage.clear();
  patches = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Fit tab to motor tube — a new tab is 60 % of the ROOT chord', () => {
  it('sizes an overhanging freeform fin tab off the root chord, not the tip', () => {
    const fin = { id: 'ff', type: 'freeformfinset', finCount: 3, thickness: 0.0047625, points: NINJA,
      position: { method: 'bottom', offset: -0.1049714752044 } };
    mount(withFin(fin), fin as unknown as ComponentNode);
    const btn = fitButton();
    expect(btn, 'the button renders for a freeform fin on a tube with a motor mount').toBeTruthy();
    act(() => btn!.click());
    expect(patches).toHaveLength(1);
    const p = patches[0]!;
    expect(p['tabHeight']).toBeCloseTo(0.0508 - 0.0286, 12);
    // 0.6 × 360.76 mm = 216.46 mm. The old max-x sizing gave 288.16 mm.
    expect(p['tabLength']).toBeCloseTo(0.6 * 0.360761749736894, 12);
    expect(p['tabLength'] as number).toBeLessThan(0.6 * 0.48026079897864005 - 0.05);
  });

  it('leaves an existing tab length alone', () => {
    const fin = { id: 'ff', type: 'freeformfinset', finCount: 3, thickness: 0.0047625, points: NINJA,
      tabHeight: 0.022098, tabLength: 0.24765, position: { method: 'bottom', offset: -0.1049714752044 } };
    mount(withFin(fin), fin as unknown as ComponentNode);
    act(() => fitButton()!.click());
    expect(patches[0]!).not.toHaveProperty('tabLength');
  });

  it('is unchanged for a trapezoid fin — rootChord is already the root', () => {
    const fin = { id: 'tf', type: 'trapezoidfinset', finCount: 3, rootChord: 0.1, tipChord: 0.05,
      sweep: 0.03, height: 0.06, thickness: 0.003, position: { method: 'bottom', offset: 0 } };
    mount(withFin(fin), fin as unknown as ComponentNode);
    act(() => fitButton()!.click());
    expect(patches[0]!['tabLength']).toBeCloseTo(0.06, 12);
  });
});
