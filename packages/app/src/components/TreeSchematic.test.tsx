// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree, StaticInfo } from '@online-openrocket/engine';
import { calloutLayout, TreeSchematic } from './TreeSchematic.js';
import { EXPORT_VARS } from '../services/schematicExport.js';

/**
 * CG/CP leader-line callouts (S2): dashed leaders from the centerline markers
 * to labeled dots in clear lanes above/below the airframe, plus the
 * color-coded stability-margin text in the upper lane.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const tree = {
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.012 },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012 },
    ],
  }],
} as unknown as RocketTree;

const infoOf = (cal: number): StaticInfo => ({
  length: 0.4, mass: 0.1, massEmpty: 0.08, cgEmpty: 0.2, cg: 0.2, cp: 0.28,
  cna: 10, stabilityCalibers: cal, refDiameter: 0.024, warnings: 0, warningTexts: [],
});

const mount = (info: StaticInfo | null) => act(() => root.render(
  <TreeSchematic tree={tree} info={info} />,
));

/** The pointer-transparent callout group (markers keep their own <g>s). */
const calloutGroup = (): SVGGElement | null => host.querySelector('g[pointer-events="none"]');
const texts = (): SVGTextElement[] => [...host.querySelectorAll('text')];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('calloutLayout', () => {
  // Margin-text width estimate is length * 7.2 / 2 — "✓ 1.52 cal — ok" is
  // 15 chars, so halfW = 54 in the tests below.
  const MARGIN = '✓ 1.52 cal — ok';

  it('lanes stand LANE_GAP off the airframe; leaders start at the marker edge', () => {
    const l = calloutLayout(100, 300, 120, 40, 640, 240, null);
    expect(l.cg).toEqual({ x: 100, leaderY1: 111, leaderY2: 67 });
    expect(l.cp).toEqual({ x: 300, leaderY1: 129, leaderY2: 173 });
    expect(l.margin).toBeNull();
  });

  it('a rocket drawn thinner than the marker stands the lanes off the marker', () => {
    const l = calloutLayout(100, 300, 120, 4, 640, 240, null);
    expect(l.cg!.leaderY2).toBe(98);
    expect(l.cp!.leaderY2).toBe(142);
  });

  it('lanes clamp inside the viewBox', () => {
    const l = calloutLayout(100, 300, 15, 40, 640, 60, null);
    expect(l.cg!.leaderY2).toBe(10);
    expect(l.cp!.leaderY2).toBe(50);
  });

  it('margin sits midway between CG and CP in the upper lane', () => {
    const l = calloutLayout(100, 500, 120, 40, 640, 240, MARGIN);
    expect(l.margin).toEqual({ x: 300, y: 67 });
  });

  it('margin clamps at the viewBox edge, then clears the CG label', () => {
    const l = calloutLayout(10, 30, 120, 40, 640, 240, MARGIN);
    // mid 20 → clamped to halfW+2 = 56 → collides with the CG label → nudged
    // aft of it: cgX + 27 + halfW = 91.
    expect(l.margin!.x).toBe(91);
  });

  it('margin nudges off the CG label when the midpoint lands on it', () => {
    const l = calloutLayout(180, 220, 120, 40, 640, 240, MARGIN);
    expect(l.margin!.x).toBe(261);
  });

  it('margin nudges forward when CP is fore of CG', () => {
    const l = calloutLayout(300, 260, 120, 40, 640, 240, MARGIN);
    expect(l.margin!.x).toBe(240);
  });

  it('null marker positions yield no callouts', () => {
    expect(calloutLayout(null, null, 120, 40, 640, 240, MARGIN))
      .toEqual({ cg: null, cp: null, margin: null });
  });
});

describe('TreeSchematic — CG/CP callouts', () => {
  it('stable rocket: dashed leaders, dots, labels and a green margin text', () => {
    mount(infoOf(1.52));
    const g = calloutGroup()!;
    expect(g).not.toBeNull();
    expect(g.querySelectorAll('line[stroke-dasharray="4 3"]')).toHaveLength(2);
    expect(g.querySelectorAll('circle[r="4"]')).toHaveLength(2);
    const cg = texts().find((t) => t.textContent === 'CG')!;
    const cp = texts().find((t) => t.textContent === 'CP')!;
    expect(cg.getAttribute('fill')).toBe('var(--text-primary)');
    expect(cp.getAttribute('fill')).toBe('var(--status-serious)');
    // CG lane above the centerline, CP lane below.
    expect(Number(cg.getAttribute('y'))).toBeLessThan(Number(cp.getAttribute('y')));
    const margin = texts().find((t) => t.textContent === '✓ 1.52 cal — ok')!;
    expect(margin.getAttribute('fill')).toBe('var(--status-good)');
    expect(margin.getAttribute('y')).toBe(cg.getAttribute('y'));
  });

  it('under-stable rocket: red margin text with the report vocabulary', () => {
    mount(infoOf(0.70));
    const margin = texts().find((t) => t.textContent === '⚠ 0.70 cal — under-stable')!;
    expect(margin.getAttribute('fill')).toBe('var(--status-serious)');
  });

  it('over-stable rocket: amber margin text', () => {
    mount(infoOf(3.42));
    const margin = texts().find((t) => t.textContent === '△ 3.42 cal — over-stable')!;
    expect(margin.getAttribute('fill')).toBe('var(--status-warn)');
  });

  it('info null: no markers, no callout group', () => {
    mount(null);
    expect(calloutGroup()).toBeNull();
    expect(host.querySelectorAll('circle')).toHaveLength(0);
    expect(texts()).toHaveLength(0);
  });
});

describe('schematic export', () => {
  it('bakes the status vars the callouts use to their light values', () => {
    expect(EXPORT_VARS).toEqual(expect.arrayContaining([
      ['var(--status-good)', '#008300'],
      ['var(--status-warn)', '#a06b00'],
      ['var(--status-serious)', '#e34948'],
    ]));
  });
});
