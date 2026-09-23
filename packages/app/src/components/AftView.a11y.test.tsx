// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { AftView } from './AftView.js';

/**
 * The aft view's three zoom controls carried a `title` and a single glyph.
 * Name-from-content wins over `title` in the accessible-name computation, so
 * their names were "+", "−" and "⤢" — announced as "plus sign button",
 * "minus sign button" and "north east and south west arrow button".
 * TreeSchematic renders the identical pair with aria-label beside its title.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const TREE = {
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [{ id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.024 }],
  }],
} as unknown as RocketTree;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('AftView zoom controls', () => {
  it('name every icon-only button, keeping the tooltip', () => {
    act(() => root.render(<AftView tree={TREE} />));
    const buttons = [...host.querySelectorAll('.schematic-controls button')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Zoom in', 'Zoom out', 'Fit the whole cross-section in view',
    ]);
    // Every one of them still shows a glyph and still has its tooltip: this is
    // an addition, not a replacement.
    expect(buttons.map((b) => b.textContent)).toEqual(['+', '−', '⤢']);
    expect(buttons.every((b) => (b.getAttribute('title') ?? '') !== '')).toBe(true);
  });
});

/**
 * Audit 2026-09-22: once zoomed, the view could be panned only by pointer drag,
 * so a pod or cluster tube off the centre could not be brought back into view
 * from the keyboard — and the drawing's own label sent a reader to "pan with
 * the buttons beside this drawing", which do not exist.
 */
describe('AftView keyboard panning', () => {
  const svg = () => host.querySelector('svg')!;
  const view = () => svg().querySelector('g')!.getAttribute('transform') ?? '';
  const translate = () => view().match(/translate\((-?[\d.e-]+) (-?[\d.e-]+)\)/)!.slice(1).map(Number);
  const key = (k: string): boolean => {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    act(() => { svg().dispatchEvent(ev); });
    return ev.defaultPrevented;
  };

  it('is a tab stop whose name promises only what is there', () => {
    act(() => root.render(<AftView tree={TREE} />));
    expect(svg().tabIndex).toBe(0);
    const name = svg().getAttribute('aria-label') ?? '';
    expect(name).not.toMatch(/pan with the buttons/i);
    expect(name).toMatch(/arrow keys pan/i);
  });

  it('leaves the arrows to the page at fit, where there is nothing to pan', () => {
    act(() => root.render(<AftView tree={TREE} />));
    const before = view();
    expect(key('ArrowRight')).toBe(false);
    expect(view()).toBe(before);
  });

  it('pans a zoomed view with the arrows, the way a scroll moves a page', () => {
    act(() => root.render(<AftView tree={TREE} />));
    act(() => { (host.querySelector('button[aria-label="Zoom in"]') as HTMLButtonElement).click(); });
    const [x0, y0] = translate();
    expect(key('ArrowRight')).toBe(true);
    const [x1, y1] = translate();
    // The view moves right, so the drawing moves left.
    expect(x1!).toBeLessThan(x0!);
    expect(y1).toBe(y0);
    expect(key('ArrowDown')).toBe(true);
    expect(translate()[1]!).toBeLessThan(y0!);
    key('ArrowLeft');
    key('ArrowUp');
    expect(translate()[0]).toBeCloseTo(x0!, 12);
    expect(translate()[1]).toBeCloseTo(y0!, 12);
  });
});
