// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree, StaticInfo } from '@online-openrocket/engine';
import { TreeSchematic } from './TreeSchematic.js';
import { calloutGadget } from './Rocket3D.js';
import { STABILITY_GLYPH, STABILITY_WORD, stabilityReadout } from './stabilityWording.js';

/**
 * THE TWO VIEWS MUST SAY THE SAME THING.
 *
 * The 2D schematic has printed "⚠ 1.85 cal — under-stable" since the callout
 * lanes landed. The 3D callout printed the bare number and left the verdict to
 * three hexes, so a red-green colour-blind reader got no verdict at all in the
 * one view people rotate to inspect a build. These pin the shared vocabulary
 * and, more usefully, that the two strings are byte-identical.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const TREE = {
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.024 },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.024 },
    ],
  }],
} as unknown as RocketTree;

const infoOf = (cal: number): StaticInfo => ({
  length: 0.4, refDiameter: 0.048, mass: 0.4, massEmpty: 0.3,
  cg: 0.2, cgEmpty: 0.19, cp: 0.2 + cal * 0.048, stabilityCalibers: cal,
  cna: 9, warningTexts: [],
} as unknown as StaticInfo);

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('stabilityReadout', () => {
  it('is glyph, margin, then the verdict in words', () => {
    expect(stabilityReadout('under', '0.42 cal')).toBe('⚠ 0.42 cal — under-stable');
    expect(stabilityReadout('ok', '1.67 cal')).toBe('✓ 1.67 cal — ok');
    expect(stabilityReadout('over', '3.50 cal')).toBe('△ 3.50 cal — over-stable');
  });

  it('carries a distinct glyph and word for all three states', () => {
    expect(new Set(Object.values(STABILITY_GLYPH)).size).toBe(3);
    expect(new Set(Object.values(STABILITY_WORD)).size).toBe(3);
  });
});

describe('the 2D and 3D margin readouts', () => {
  for (const [label, cal] of [['under', 0.42], ['ok', 1.67], ['over', 3.5]] as const) {
    it(`agree word for word on an ${label}-stable rocket`, () => {
      const info = infoOf(cal);
      act(() => root.render(<TreeSchematic tree={TREE} info={info} />));
      const twoD = [...host.querySelectorAll('text')]
        .map((t) => t.textContent ?? '')
        .find((s) => s.includes('cal'))!;
      expect(twoD, 'the 2D view should print a margin').toBeTruthy();

      const threeD = calloutGadget(info, 0.024, 0.4)!.margin!.text;
      expect(threeD).toBe(twoD);
      expect(threeD).toContain(STABILITY_WORD[label]);
      expect(threeD.startsWith(STABILITY_GLYPH[label])).toBe(true);
    });
  }
});
