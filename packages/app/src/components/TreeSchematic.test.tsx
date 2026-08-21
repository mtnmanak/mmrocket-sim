// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree, StaticInfo } from '@online-openrocket/engine';
import { calloutLayout, TreeSchematic } from './TreeSchematic.js';
import { EXPORT_VARS } from '../services/schematicExport.js';

/**
 * CG/CP leader-line callouts (S2): dashed leaders from the centerline markers
 * to labeled dots in clear lanes above/below the airframe, plus the
 * color-coded stability-margin text in the upper lane. Also the vertical
 * nose-up mode (S1/S4), the motor tint + designation label and the hover
 * highlight + name tag (S5).
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
      {
        id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012,
        children: [
          { id: 'f1', type: 'trapezoidfinset', rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03 },
        ],
      },
    ],
  }],
} as unknown as RocketTree;

const infoOf = (cal: number): StaticInfo => ({
  length: 0.4, mass: 0.1, massEmpty: 0.08, cgEmpty: 0.2, cg: 0.2, cp: 0.28,
  cna: 10, stabilityCalibers: cal, refDiameter: 0.024, warnings: 0, warningTexts: [],
});

type Props = Parameters<typeof TreeSchematic>[0];
const mount = (info: StaticInfo | null, extra: Partial<Props> = {}) => act(() => root.render(
  <TreeSchematic tree={tree} info={info} {...extra} />,
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

  it('margin sits midway between CG and CP in the LOWER lane (the upper-right corner belongs to the control strip)', () => {
    const l = calloutLayout(100, 500, 120, 40, 640, 240, MARGIN);
    expect(l.margin).toEqual({ x: 300, y: 173 });
  });

  it('margin clamps at the viewBox edge, then clears the CP label', () => {
    const l = calloutLayout(10, 30, 120, 40, 640, 240, MARGIN);
    // mid 20 → clamped to halfW+2 = 56 → collides with the CP label → nudged
    // aft of it: cpX + 27 + halfW = 111.
    expect(l.margin!.x).toBe(111);
  });

  it('margin nudges off the CP label when the midpoint lands on it', () => {
    const l = calloutLayout(180, 220, 120, 40, 640, 240, MARGIN);
    expect(l.margin!.x).toBe(301);
  });

  it('margin still clears the CP label when CP is fore of CG', () => {
    const l = calloutLayout(300, 260, 120, 40, 640, 240, MARGIN);
    expect(l.margin!.x).toBe(341);
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
    // The margin shares the CP (lower) lane — the upper-right corner is the
    // export/zoom control strip's.
    expect(margin.getAttribute('y')).toBe(cp.getAttribute('y'));
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

  it('bakes the launch tint the motor cases use (S5)', () => {
    expect(EXPORT_VARS).toEqual(expect.arrayContaining([
      ['var(--launch)', '#c65420'],
    ]));
  });
});

describe('TreeSchematic — vertical nose-up mode (S1/S4)', () => {
  it('transposes the viewBox and rotates the drawing group nose-up', () => {
    mount(infoOf(1.52), { vertical: true });
    const svg = host.querySelector('svg')!;
    // Length axis (480 fallback container height) becomes the viewBox height.
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 480');
    expect(host.querySelector('svg > g')!.getAttribute('transform')).toBe('rotate(90 100 100)');
  });

  it('every label counter-rotates about its own anchor', () => {
    mount(infoOf(1.52), { vertical: true });
    const all = texts();
    expect(all.length).toBeGreaterThanOrEqual(3); // CG, CP, margin
    for (const t of all) {
      expect(t.getAttribute('transform'))
        .toBe(`rotate(-90 ${t.getAttribute('x')} ${t.getAttribute('y')})`);
    }
    // Leaders and dots still render inside the rotated group.
    const g = calloutGroup()!;
    expect(g.querySelectorAll('line[stroke-dasharray="4 3"]')).toHaveLength(2);
    expect(g.querySelectorAll('circle[r="4"]')).toHaveLength(2);
  });

  it('interaction is off: no grab cursor on fins, no zoom/export controls', () => {
    const patch = vi.fn();
    mount(infoOf(1.52), { vertical: true, onPatchNode: patch, exportData: undefined });
    expect(host.querySelector('.schematic-controls')).toBeNull();
    const fin = host.querySelector('polygon')!;
    expect(fin.style.cursor).toBe('');
    act(() => { fin.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    act(() => { fin.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40 })); });
    expect(patch).not.toHaveBeenCalled();
  });

  it('horizontal keeps the grab cursor and the controls (the baseline)', () => {
    mount(infoOf(1.52), { onPatchNode: vi.fn() });
    expect(host.querySelector('.schematic-controls')).not.toBeNull();
    expect(host.querySelector('polygon')!.style.cursor).toBe('grab');
  });
});

describe('TreeSchematic — motor tint + label (S5)', () => {
  it('a long-enough case draws launch-tinted with its designation centered', () => {
    mount(null, { motors: { b1: { length: 0.07, diameter: 0.018, label: 'C6-5' } } });
    expect(host.querySelector('rect[fill="var(--launch)"]')).not.toBeNull();
    const label = texts().find((t) => t.textContent === 'C6-5')!;
    expect(label.getAttribute('font-weight')).toBe('bold');
    expect(label.getAttribute('fill')).toBe('#ffffff');
  });

  it('a case too short on screen keeps the tint but skips the label', () => {
    mount(null, { motors: { b1: { length: 0.02, diameter: 0.018, label: 'A10-3' } } });
    expect(host.querySelector('rect[fill="var(--launch)"]')).not.toBeNull();
    expect(texts().find((t) => t.textContent === 'A10-3')).toBeUndefined();
  });
});

describe('TreeSchematic — hover highlight + name tag (S5)', () => {
  // React derives onPointerEnter/Leave from the native over/out pair.
  const over = (el: Element) => act(() => {
    el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  });
  const out = (el: Element) => act(() => {
    el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
  });

  it('pointerenter shows the accent wash and the display-name tag; leave clears', () => {
    mount(null);
    const tube = host.querySelector('rect[fill="#e7e5e0"]')!;
    over(tube);
    const wash = host.querySelector('rect[fill="var(--accent)"]')!;
    expect(wash).not.toBeNull();
    expect(wash.getAttribute('fill-opacity')).toBe('0.14');
    // Lighter than the solid width-2 selection outline.
    expect(wash.getAttribute('stroke-width')).toBe('1');
    expect(texts().find((t) => t.textContent === 'Body tube')).not.toBeUndefined();
    out(tube);
    expect(host.querySelector('rect[fill="var(--accent)"]')).toBeNull();
    expect(texts().find((t) => t.textContent === 'Body tube')).toBeUndefined();
  });

  it('selection styling is untouched: the selected shape keeps its solid accent outline', () => {
    mount(null, { selectedId: 'n1' });
    const nose = host.querySelector('path[stroke="var(--accent)"]')!;
    expect(nose.getAttribute('stroke-width')).toBe('2');
  });
});
