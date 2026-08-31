// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The snap buttons' WIRING, not the angle helpers.
 *
 * v0.089's headline fix was that "▲ on a fin" / "⟂ between fins" only appeared
 * when the part happened to sit on the same tube as the fin set — so a camera
 * on the payload bay, the normal place for one, got nothing (owner report,
 * hours after v0.088 shipped). The frame helpers got unit tests; the PANEL did
 * not, and the v0.089 review pointed out that mutating snapTargets back to
 * siblings-only left all 1,282 app tests green. That is this file.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

const FINS = {
  id: 'f1', type: 'trapezoidfinset', finCount: 3, rootChord: 0.08, tipChord: 0.04,
  sweep: 0.03, height: 0.05, thickness: 0.003,
};

/** Fins on the AFT tube, the surface part on the tube ABOVE it — his layout. */
const twoTubes = (part: Record<string, unknown>): RocketTree => ({
  name: 'R',
  components: [{
    id: 's1', type: 'stage', children: [
      { id: 'up', type: 'bodytube', length: 0.5, outerRadius: 0.027, thickness: 0.001,
        children: [part] },
      { id: 'fc', type: 'bodytube', length: 0.3, outerRadius: 0.027, thickness: 0.001,
        children: [FINS] },
    ],
  }],
} as unknown as RocketTree);

const snapButtons = () => [...host.querySelectorAll('button')]
  .filter((b) => /on a fin|between fins/.test(b.textContent ?? ''));

const mount = (tree: RocketTree, node: ComponentNode) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node} onPatch={(p) => patches.push(p)} />
  </PrefsProvider>,
));

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

describe('snap buttons reach fins on OTHER tubes', () => {
  it('offers both buttons for a rail button one tube above the fin can', () => {
    const rb = { id: 'rb', type: 'railbutton', outerDiameter: 0.0097, angleOffset: 0 };
    const tree = twoTubes(rb);
    mount(tree, rb as unknown as ComponentNode);
    expect(snapButtons(), 'the v0.088 bug: no buttons unless the fins are siblings')
      .toHaveLength(2);
  });

  it('offers them for a camera shroud too, and snapping patches a real angle', () => {
    const sh = { id: 'sh', type: 'fairing', length: 0.08, width: 0.03, height: 0.02, angleOffset: 0 };
    mount(twoTubes(sh), sh as unknown as ComponentNode);
    const [onFin, between] = snapButtons();
    expect(onFin).toBeTruthy();
    expect(between).toBeTruthy();

    act(() => { between!.click(); });
    const patch = patches.at(-1)!;
    expect(Object.keys(patch)).toEqual(['angleOffset']);
    // 3 fins at 0/±120 -> midpoints at ±60/180. From 0, the nearest is ±60.
    expect(Math.abs((patch['angleOffset'] as number) * 180 / Math.PI)).toBeCloseTo(60, 6);

    act(() => { onFin!.click(); });
    expect((patches.at(-1)!['angleOffset'] as number)).toBeCloseTo(0, 9);
  });

  it('offers nothing when the rocket has no fins at all — the question has no answer', () => {
    const rb = { id: 'rb', type: 'railbutton', outerDiameter: 0.0097, angleOffset: 0 };
    const finless = {
      name: 'R',
      components: [{
        id: 's1', type: 'stage', children: [
          { id: 'up', type: 'bodytube', length: 0.5, outerRadius: 0.027, thickness: 0.001,
            children: [rb] },
        ],
      }],
    } as unknown as RocketTree;
    mount(finless, rb as unknown as ComponentNode);
    expect(snapButtons()).toHaveLength(0);
  });

  it('does NOT offer the core airframe\'s fins to a part inside a pod', () => {
    const podRb = { id: 'prb', type: 'railbutton', outerDiameter: 0.0097, angleOffset: 0 };
    const podded = {
      name: 'R',
      components: [{
        id: 's1', type: 'stage', children: [{
          id: 'b1', type: 'bodytube', length: 0.4, outerRadius: 0.027, thickness: 0.001,
          children: [
            FINS,
            { id: 'p1', type: 'podset', instanceCount: 2, angleOffset: Math.PI / 2,
              children: [{ id: 'pb', type: 'bodytube', length: 0.1, outerRadius: 0.01,
                thickness: 0.001, children: [podRb] }] },
          ],
        }],
      }],
    } as unknown as RocketTree;
    mount(podded, podRb as unknown as ComponentNode);
    // The pod's chain carries no fins of its own, and the core's are measured
    // from a different zero — so there is nothing honest to offer.
    expect(snapButtons()).toHaveLength(0);
  });
});
