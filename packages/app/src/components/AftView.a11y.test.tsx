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
