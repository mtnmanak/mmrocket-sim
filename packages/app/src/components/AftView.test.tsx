// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { AftView } from './AftView.js';

/**
 * The aft view's cross-section frame, pinned (v0.078). Angle 0 is +y for
 * EVERY radial part — fins, pods, clusters — because that is where the kernel
 * puts them (`FinSet.getInstanceOffsets` starts at `Coordinate(0, bodyRadius,
 * 0)`; `RingInstanceable` starts at `(r·cosθ, r·sinθ)`), and +y draws UP, as
 * the desktop's back view draws it.
 *
 * Before v0.078 this view drew +y RIGHT and +z up, with a compensating +π/2
 * on fin sets alone — so fins came out upright but pods and clusters sat 90°
 * away from them, and 90° away from the same design in the 3D view. The roll
 * slider is what made that visible.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const finRocket = (extra: Record<string, unknown> = {}) => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [{
      id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012,
      children: [{
        id: 'f1', type: 'trapezoidfinset', finCount: 3,
        rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003, ...extra,
      }],
    }],
  }],
} as unknown as RocketTree);

const podRocket = (angleOffset: number) => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [{
      id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012,
      children: [{
        id: 'p1', type: 'podset', instanceCount: 1, angleOffset, radiusOffset: 0.01,
        children: [{ id: 'pb', type: 'bodytube', length: 0.1, outerRadius: 0.006 }],
      }],
    }],
  }],
} as unknown as RocketTree);

const show = (el: React.ReactElement) => act(() => root.render(el));

/** Mean of a polygon's plotted points — good enough to say which way it points. */
const polyCentre = (p: Element): { x: number; y: number } => {
  const pts = p.getAttribute('points')!.trim().split(/\s+/).map((s) => s.split(',').map(Number));
  return {
    x: pts.reduce((a, q) => a + q[0]!, 0) / pts.length,
    y: pts.reduce((a, q) => a + q[1]!, 0) / pts.length,
  };
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('AftView cross-section frame', () => {
  it('draws an unrotated first fin straight up', () => {
    show(<AftView tree={finRocket()} />);
    const fins = [...host.querySelectorAll('polygon')];
    expect(fins).toHaveLength(3);
    const first = polyCentre(fins[0]!);
    expect(Math.abs(first.x)).toBeLessThan(1e-9); // dead centre horizontally
    expect(first.y).toBeLessThan(0); // SVG y grows down, so this is UP
  });

  it('rolling +90° swings that fin to the right', () => {
    show(<AftView tree={finRocket()} roll={Math.PI / 2} />);
    const first = polyCentre([...host.querySelectorAll('polygon')][0]!);
    expect(first.x).toBeGreaterThan(0);
    expect(Math.abs(first.y)).toBeLessThan(1e-9);
  });

  it("a fin set's own rotation reads the same way as the roll", () => {
    show(<AftView tree={finRocket({ rotation: Math.PI / 2 })} />);
    const first = polyCentre([...host.querySelectorAll('polygon')][0]!);
    expect(first.x).toBeGreaterThan(0);
  });

  it('puts a pod at angle 0 straight up too — with the fins, not across from them', () => {
    show(<AftView tree={podRocket(0)} />);
    // Hulls: the core tube at the origin, then the pod's own tube offset.
    const pod = [...host.querySelectorAll('circle')]
      .map((c) => ({ x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) }))
      .find((c) => Math.abs(c.x) > 1e-9 || Math.abs(c.y) > 1e-9)!;
    expect(pod).toBeTruthy();
    expect(Math.abs(pod.x)).toBeLessThan(1e-9);
    expect(pod.y).toBeLessThan(0);
  });

  it('rolls a pod ring with everything else', () => {
    show(<AftView tree={podRocket(0)} roll={Math.PI / 2} />);
    const pod = [...host.querySelectorAll('circle')]
      .map((c) => ({ x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) }))
      .find((c) => Math.abs(c.x) > 1e-9 || Math.abs(c.y) > 1e-9)!;
    expect(pod.x).toBeGreaterThan(0);
    expect(Math.abs(pod.y)).toBeLessThan(1e-9);
  });
});
