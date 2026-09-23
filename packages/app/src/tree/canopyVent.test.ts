import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { CANOPY_DIAMETER_FALLBACK, SPILL_HOLE_MAX_FRACTION, ventLimit } from './canopyVent.js';
import { engineTree, findNode } from './treeModel.js';

const chute = (params: Record<string, unknown>) =>
  ({ type: 'parachute', id: 'p1', cd: 2, ...params }) as unknown as ComponentNode;

describe('ventLimit — the widest spill hole a canopy can carry', () => {
  it('is 0.95 of the stated canopy diameter', () => {
    expect(ventLimit(chute({ diameter: 0.6 }))).toEqual({ diameter: 0.6, maxHole: 0.6 * 0.95 });
    expect(SPILL_HOLE_MAX_FRACTION).toBe(0.95);
  });

  it('measures a canopy with no stated diameter at the 0.3 m it is flown at', () => {
    expect(CANOPY_DIAMETER_FALLBACK).toBe(0.3);
    expect(ventLimit(chute({}))).toEqual({ diameter: 0.3, maxHole: 0.3 * 0.95 });
  });

  it('has no ceiling for a diameter no vent fits: 0, negative, NaN', () => {
    for (const diameter of [0, -0.6, NaN]) expect(ventLimit(chute({ diameter })), String(diameter)).toBeNull();
  });
});

/**
 * The reason there is one rule: the ceiling the property panel offers
 * (PropertyPanel.oneShots.test.tsx pins the slider) is the hole engineTree
 * flies. An oversized vent is flown at the ceiling, never past it.
 */
describe('engineTree flies the vent at ventLimit', () => {
  const tree = (params: Record<string, unknown>): RocketTree => ({
    name: 's',
    components: [{
      type: 'stage', id: 's1',
      children: [{
        type: 'bodytube', id: 'b1', length: 0.3, outerRadius: 0.02, children: [chute(params)],
      } as ComponentNode],
    } as ComponentNode],
  });
  const flownCd = (params: Record<string, unknown>) => findNode(engineTree(tree(params)), 'p1')!['cd'] as number;

  it('clamps a vent wider than the canopy to 0.95 D', () => {
    expect(flownCd({ diameter: 0.6, spillHoleDiameter: 2 })).toBeCloseTo(2 * (1 - 0.95 ** 2), 12);
    // The same figure as a vent typed AT the ceiling.
    const atCeiling = ventLimit(chute({ diameter: 0.6 }))!.maxHole;
    expect(flownCd({ diameter: 0.6, spillHoleDiameter: 2 }))
      .toBe(flownCd({ diameter: 0.6, spillHoleDiameter: atCeiling }));
  });

  it('flies a canopy with no diameter as 0.3 m, vent and all', () => {
    expect(flownCd({ spillHoleDiameter: 0.15 })).toBeCloseTo(2 * (1 - (0.15 / 0.3) ** 2), 12);
    expect(flownCd({ spillHoleDiameter: 1 })).toBeCloseTo(2 * (1 - 0.95 ** 2), 12);
  });

  it('flies a vent under the ceiling as typed', () => {
    expect(flownCd({ diameter: 0.6, spillHoleDiameter: 0.15 })).toBeCloseTo(2 * (1 - 0.25 ** 2), 12);
  });
});
