// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { AftView } from './AftView.js';
import { TreeSchematic } from './TreeSchematic.js';

/**
 * The 2D side view and the aft view draw a count the way the kernel flies it
 * (audit 2026-09-22). Measured before the fix: a .rkt with FinCount 70,000
 * made the side view's `Math.min(...ys)` spread throw RangeError — and with no
 * error boundary around the tree, the whole app was replaced by the "Something
 * went wrong" panel — while a 12-fin set was drawn as 12 and flown as 8.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const rocket = (child: Record<string, unknown>) => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.012 },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012, children: [child] },
    ],
  }],
} as unknown as RocketTree);

const fins = (finCount: number) => rocket({
  id: 'f1', type: 'trapezoidfinset', finCount,
  rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003,
});
const tubes = (finCount: number) => rocket({ id: 't1', type: 'tubefinset', finCount, length: 0.1, thickness: 0.0005 });
const lug = (instanceCount: number) => rocket({
  id: 'l1', type: 'launchlug', length: 0.05, outerRadius: 0.0022, thickness: 0.0003,
  instanceCount, instanceSeparation: 0.001,
});

const show = (el: React.ReactElement) => act(() => root.render(el));
const elements = () => host.querySelectorAll('*').length;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('side view', () => {
  it('draws a .rkt FinCount of 70,000 as the 8 fins the kernel flies, without throwing', () => {
    show(<TreeSchematic tree={fins(8)} info={null} />);
    const eight = elements();
    expect(() => show(<TreeSchematic tree={fins(70_000)} info={null} />)).not.toThrow();
    expect(elements()).toBe(eight);
  });

  it('draws 12 fins, and 12 tube fins, as 8', () => {
    show(<TreeSchematic tree={fins(8)} info={null} />);
    const eightFins = elements();
    show(<TreeSchematic tree={fins(12)} info={null} />);
    expect(elements()).toBe(eightFins);
    show(<TreeSchematic tree={tubes(8)} info={null} />);
    const eightTubes = elements();
    show(<TreeSchematic tree={tubes(12)} info={null} />);
    expect(elements()).toBe(eightTubes);
  });

  it('draws at most 64 line instances of a lug', () => {
    show(<TreeSchematic tree={lug(64)} info={null} />);
    const cap = elements();
    show(<TreeSchematic tree={lug(20_000)} info={null} />);
    expect(elements()).toBe(cap);
  });
});

describe('aft view', () => {
  it('draws 8 fins for a set of 12, and 8 tube circles for 12 tubes', () => {
    show(<AftView tree={fins(12)} />);
    expect(host.querySelectorAll('polygon')).toHaveLength(8);
    show(<AftView tree={tubes(8)} />);
    const eight = host.querySelectorAll('circle').length;
    show(<AftView tree={tubes(12)} />);
    expect(host.querySelectorAll('circle')).toHaveLength(eight);
  });

  it('titles a lug stack with the count the kernel flies', () => {
    show(<AftView tree={lug(20_000)} />);
    expect([...host.querySelectorAll('title')].some((t) => /×64$/.test(t.textContent ?? ''))).toBe(true);
    expect([...host.querySelectorAll('title')].some((t) => /×20000/.test(t.textContent ?? ''))).toBe(false);
  });
});
