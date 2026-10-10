// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { RULER_TOP, TreeSchematic } from './TreeSchematic.js';
import { schematicSvg } from '../services/schematicExport.js';
import { guideSpans, guideToPx, pxToGuide, type GuideView } from '../services/rulerGuides.js';
import { INITIAL_UNITS } from '../prefs/units.js';

/**
 * Measuring guides dragged out of the 2D view's rulers (@atestani,
 * 2026-10-09: "ruler measuring cursors"), driven by real pointer sequences.
 * The rulers themselves are TreeSchematic.rulers.test.tsx.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('guide geometry', () => {
  const view: GuideView = { k: 2.5, x: -130, y: 40, x0: 60, cy: 150, scale: 900 };

  it('a station and an offset survive the round trip through the view', () => {
    for (const m of [0, 0.123, 0.4, -0.02]) {
      expect(pxToGuide(view, 'x', guideToPx(view, 'x', m))).toBeCloseTo(m, 12);
      expect(pxToGuide(view, 'y', guideToPx(view, 'y', m))).toBeCloseTo(m, 12);
    }
  });

  it('the nose tip is station 0 and up is positive, as the rulers read', () => {
    expect(guideToPx(view, 'x', 0)).toBe(view.x + view.k * view.x0);
    expect(guideToPx(view, 'y', 0)).toBe(view.y + view.k * view.cy);
    expect(guideToPx(view, 'y', 0.01)).toBeLessThan(guideToPx(view, 'y', 0));
  });

  it('measures between neighbours on one axis only, in order', () => {
    const spans = guideSpans([
      { id: 1, axis: 'x', m: 0.3 }, { id: 2, axis: 'y', m: 0.01 },
      { id: 3, axis: 'x', m: 0.1 }, { id: 4, axis: 'x', m: 0.25 },
    ], 'x');
    expect(spans.map((s) => [s.a.id, s.b.id])).toEqual([[3, 4], [4, 1]]);
    expect(spans[0]!.d).toBeCloseTo(0.15, 12);
    expect(spans[1]!.d).toBeCloseTo(0.05, 12);
  });
});

let host: HTMLDivElement;
let root: Root;
let rectSpy: ReturnType<typeof vi.spyOn>;

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

const svgEl = () => host.querySelector('svg')!;
const viewW = () => Number(svgEl().getAttribute('viewBox')!.split(' ')[2]);
const viewH = () => Number(svgEl().getAttribute('viewBox')!.split(' ')[3]);
const ruler = (axis: 'x' | 'y') => host.querySelector(`[data-guide-ruler="${axis}"]`)!;
const guideLabels = (axis: 'x' | 'y') =>
  [...host.querySelectorAll(`[data-guide="${axis}"] text`)].map((t) => t.textContent);
const spanLabels = (axis: 'x' | 'y') =>
  [...host.querySelectorAll(`[data-guide-span="${axis}"] text`)].map((t) => t.textContent);
/** The nose cone's leading edge: the nose tip, station 0. */
const noseX = () => Number(/M\s*([\d.]+)/.exec(host.querySelector('svg > g > path')!.getAttribute('d')!)![1]);
const centreY = () => RULER_TOP + (viewH() - RULER_TOP) / 2;

const pointer = (el: Element, type: string, x: number, y: number, id = 1) => act(() => {
  el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: id, isPrimary: id === 1, pointerType: 'mouse',
    clientX: x, clientY: y, button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
  }));
});
/** Press on `from`, move the svg to (x, y), release there. */
const dragTo = (from: Element, start: [number, number], x: number, y: number) => {
  pointer(from, 'pointerdown', ...start);
  pointer(svgEl(), 'pointermove', x, y);
  pointer(svgEl(), 'pointerup', x, y);
};

beforeEach(() => {
  // 640 client px on the 640-wide viewBox: 1:1, so a client x IS a viewBox x.
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 240, width: 640, height: 240,
    toJSON: () => ({}),
  } as DOMRect);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<TreeSchematic tree={tree} info={null} />));
  expect(viewW()).toBe(640);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  rectSpy.mockRestore();
  localStorage.clear();
});

describe('measuring guides', () => {
  it('none until one is dragged out', () => {
    expect(host.querySelector('[data-guide]')).toBeNull();
    expect(ruler('x')).not.toBeNull();
    expect(ruler('y')).not.toBeNull();
  });

  it('drags a guide down from the top ruler that reads its station from the nose tip', () => {
    dragTo(ruler('x'), [300, 5], noseX(), 120);
    expect(guideLabels('x')).toEqual(['0 mm']);
  });

  it('drags a guide right from the left ruler that reads its distance from the centreline', () => {
    dragTo(ruler('y'), [40, 100], 200, centreY());
    expect(guideLabels('y')).toEqual(['0 mm']);
  });

  it('two guides read the distance between them', () => {
    dragTo(ruler('x'), [300, 5], noseX(), 120);
    dragTo(ruler('x'), [300, 5], noseX() + 150, 120);
    const second = guideLabels('x')[1]!;
    expect(second).toMatch(/^[\d.]+ mm$/);
    expect(Number.parseFloat(second)).toBeGreaterThan(0);
    // Station 0 to station s is s.
    expect(spanLabels('x')).toEqual([second]);
  });

  it('a plain click on a ruler drops a guide where it was clicked', () => {
    pointer(ruler('x'), 'pointerdown', noseX(), 5);
    pointer(svgEl(), 'pointerup', noseX(), 5);
    expect(guideLabels('x')).toEqual(['0 mm']);
  });

  it('dragged back onto its ruler, a guide is removed', () => {
    dragTo(ruler('x'), [300, 5], 300, 120);
    const line = host.querySelector('[data-guide="x"] line[stroke="transparent"]')!;
    dragTo(line, [300, 120], 320, 5);
    expect(host.querySelector('[data-guide]')).toBeNull();
  });

  it('moving a guide does not pan the drawing', () => {
    dragTo(ruler('x'), [300, 5], 300, 120);
    const line = host.querySelector('[data-guide="x"] line[stroke="transparent"]')!;
    const before = guideLabels('x')[0];
    dragTo(line, [300, 120], 360, 140);
    expect(guideLabels('x')[0]).not.toBe(before);
    expect(host.querySelector('svg > g')!.getAttribute('transform')).toBe('translate(0 0) scale(1)');
  });

  it('a guide stays on its station when the view zooms', () => {
    dragTo(ruler('x'), [300, 5], 300, 120);
    const label = guideLabels('x')[0];
    const x0 = host.querySelector('[data-guide="x"] line')!.getAttribute('x1');
    const zoomIn = [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Zoom in')!;
    act(() => { zoomIn.click(); });
    // Zoomed about the drawing's centre, a station off-centre moves on screen
    // but never changes its reading.
    const line = host.querySelector('[data-guide="x"] line');
    expect(line).not.toBeNull();
    expect(line!.getAttribute('x1')).not.toBe(x0);
    expect(guideLabels('x')[0]).toBe(label);
  });

  it('✕ Guides removes them all, and the button goes with them', () => {
    dragTo(ruler('x'), [300, 5], 300, 120);
    dragTo(ruler('y'), [40, 100], 200, 110);
    const clear = () => [...host.querySelectorAll('button')].find((b) => b.textContent === '✕ Guides');
    act(() => { clear()!.click(); });
    expect(host.querySelector('[data-guide]')).toBeNull();
    expect(clear()).toBeUndefined();
  });

  it('the exports leave the guides out', () => {
    dragTo(ruler('x'), [300, 5], 300, 120);
    const svg = schematicSvg(svgEl(), 100, 640, 300, {
      name: 'Rocket', info: null, units: INITIAL_UNITS, withMotors: false, appVersion: '0',
    });
    expect(svg).not.toContain('data-guide');
  });

  it('a second finger neither moves a guide nor ends its drag', () => {
    pointer(ruler('x'), 'pointerdown', 300, 5);
    pointer(svgEl(), 'pointermove', 300, 120);
    const first = guideLabels('x')[0];
    pointer(svgEl(), 'pointermove', 400, 120, 2);
    pointer(svgEl(), 'pointerup', 400, 120, 2);
    expect(guideLabels('x')[0]).toBe(first);
    pointer(svgEl(), 'pointermove', 350, 120);
    expect(guideLabels('x')[0]).not.toBe(first);
    pointer(svgEl(), 'pointerup', 350, 120);
  });
});
