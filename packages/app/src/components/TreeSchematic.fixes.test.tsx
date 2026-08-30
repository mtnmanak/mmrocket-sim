// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { ROLL_COL } from './RollControl.js';
import { RULER_LEFT, RULER_TOP, TreeSchematic } from './TreeSchematic.js';

/**
 * v0.079 — three things the v0.078 review found, pinned so they cannot come
 * back: an elliptical fin drawn at 57 % of its span, a hover box measured from
 * the un-foreshortened span, and the button zoom anchoring on the canvas
 * centre after the gutters moved the drawing's.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const BODY_R = 0.012;
const HEIGHT = 0.03;

const treeWith = (fin: Record<string, unknown>) => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: BODY_R },
      {
        id: 'b1', type: 'bodytube', length: 0.3, outerRadius: BODY_R,
        children: [{ id: 'f1', rootChord: 0.05, height: HEIGHT, thickness: 0.003, ...fin }],
      },
    ],
  }],
} as unknown as RocketTree);

const show = (el: React.ReactElement) => act(() => root.render(el));
const viewBox = () => host.querySelector('svg')!.getAttribute('viewBox')!.split(' ').map(Number);
const centreY = () => { const [, , , h] = viewBox(); return RULER_TOP + (h! - RULER_TOP) / 2; };
/** viewBox px per metre — recovered from the body tube's drawn height. */
const scale = () => {
  const tube = host.querySelector<SVGRectElement>('rect[fill="#e7e5e0"]')!;
  return Number(tube.getAttribute('height')) / (2 * BODY_R);
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

describe('elliptical fins reach their full span', () => {
  it('draws a true half-ellipse, not a quadratic that stops halfway to its tip', () => {
    show(<TreeSchematic tree={treeWith({ type: 'ellipticalfinset', finCount: 2 })} info={null} />);
    const d = [...host.querySelectorAll('path')]
      .map((p) => p.getAttribute('d') ?? '')
      .find((s) => s.includes('A '))!;
    expect(d, 'the elliptical fin should be an arc').toBeTruthy();
    // "M x0 y0 A rx ry 0 0 sweep x1 y0 Z" — ry IS the drawn span, where the
    // old control-point form reached only half of it.
    const ry = Number(/A\s+[\d.]+\s+([\d.]+)/.exec(d)![1]);
    expect(ry).toBeCloseTo(HEIGHT * scale(), 6);
  });

  it('keeps the arc on the correct side of the airframe for each instance', () => {
    show(<TreeSchematic tree={treeWith({ type: 'ellipticalfinset', finCount: 2 })} info={null} />);
    const arcs = [...host.querySelectorAll('path')]
      .map((p) => p.getAttribute('d') ?? '').filter((s) => s.includes('A '));
    expect(arcs).toHaveLength(2);
    const sweeps = arcs.map((d) => /A\s+[\d.]+\s+[\d.]+\s+0\s+0\s+(\d)/.exec(d)![1]);
    // One fin up, one down: opposite sweep flags bulge them away from the body.
    expect(new Set(sweeps).size).toBe(2);
  });
});

describe('the hover box follows the drawn fins', () => {
  const over = (el: Element) => act(() => {
    el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  });

  it('a 3-fin set highlights one full span up and half a span down, not the full box', () => {
    show(<TreeSchematic tree={treeWith({ type: 'trapezoidfinset', finCount: 3, tipChord: 0.03, sweep: 0.02 })} info={null} />);
    over(host.querySelector('polygon')!);
    const wash = host.querySelector<SVGRectElement>('rect[fill="var(--accent)"]')!;
    expect(wash).not.toBeNull();
    const y = Number(wash.getAttribute('y'));
    const hgt = Number(wash.getAttribute('height'));
    const cy = centreY();
    const s = scale();
    // The wash carries a 2 px bleed on each edge (see the hover overlay).
    const up = cy - (y + 2);
    const down = (y + hgt - 2) - cy;
    // cos 0 = 1 above; cos 120 = cos 240 = -0.5 below.
    expect(up).toBeCloseTo((BODY_R + HEIGHT) * s, 4);
    expect(down).toBeCloseTo((BODY_R + HEIGHT) * s * 0.5, 4);
  });

  it('a single fin still gets a box with height', () => {
    show(<TreeSchematic tree={treeWith({ type: 'trapezoidfinset', finCount: 1, tipChord: 0.03, sweep: 0.02 })} info={null} />);
    over(host.querySelector('polygon')!);
    const wash = host.querySelector<SVGRectElement>('rect[fill="var(--accent)"]')!;
    expect(Number(wash.getAttribute('height'))).toBeGreaterThan(HEIGHT * scale() * 0.9);
  });
});

describe('the zoom buttons anchor on the drawing, not the canvas', () => {
  it('holds the drawing area centre fixed across a zoom step', () => {
    show(<TreeSchematic tree={treeWith({ type: 'trapezoidfinset', finCount: 3, tipChord: 0.03, sweep: 0.02 })} info={null} />);
    const [, , w, h] = viewBox();
    const zoomIn = [...host.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'Zoom in')!;
    act(() => { zoomIn.click(); });

    const t = host.querySelector('svg > g')!.getAttribute('transform')!;
    const [, tx, ty, k] = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/.exec(t)!.map(Number) as number[];
    // The gutters: roll column + vertical ruler on the left, ruler band on top.
    const gutX = ROLL_COL + RULER_LEFT;
    const ax = (gutX + w!) / 2;
    const ay = (RULER_TOP + h!) / 2;
    // A point held fixed satisfies  a = t + k*a.
    expect(tx! + k! * ax).toBeCloseTo(ax, 6);
    expect(ty! + k! * ay).toBeCloseTo(ay, 6);
    // …and the canvas centre, which it used to hold, has moved.
    expect(ty! + k! * (h! / 2)).not.toBeCloseTo(h! / 2, 3);
  });
});
