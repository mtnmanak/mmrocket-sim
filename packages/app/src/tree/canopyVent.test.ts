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

  it('has no ceiling for a diameter no vent fits: 0, negative', () => {
    for (const diameter of [0, -0.6]) expect(ventLimit(chute({ diameter })), String(diameter)).toBeNull();
  });

  it('measures a NaN or infinite diameter at the 0.3 m the kernel flies for it (audit row 522)', () => {
    // JSON.stringify hands the kernel null for a non-finite number, and
    // ComponentFactory's `dbl(node, "diameter", 0.3)` falls back. The old
    // typeof read called NaN "no vent fits" and +Infinity "no vent dents".
    for (const diameter of [NaN, Infinity, -Infinity]) {
      expect(ventLimit(chute({ diameter })), String(diameter)).toEqual({ diameter: 0.3, maxHole: 0.3 * 0.95 });
    }
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

  it('reads a non-finite diameter, hole or Cd as absent (audit row 522)', () => {
    // Each figure is what the same canopy flies with the field left out.
    for (const bad of [NaN, Infinity]) {
      expect(flownCd({ diameter: bad, spillHoleDiameter: 0.15 }), `D ${bad}`).toBe(flownCd({ spillHoleDiameter: 0.15 }));
      // A non-finite hole is no hole: the typed Cd flies unscaled. +Infinity
      // used to pass `> 0` and fly the widest vent the canopy can carry.
      expect(flownCd({ diameter: 0.6, spillHoleDiameter: bad }), `hole ${bad}`).toBe(2);
      // A non-finite Cd is no Cd: the kernel's automatic 0.80, scaled by the
      // vent like any untyped one. A NaN used to reach the kernel as null,
      // which flew 0.80 with the vent ignored.
      const flown = findNode(engineTree(tree({ diameter: 0.6, spillHoleDiameter: 0.15, cd: bad })), 'p1')!;
      expect(flown['cd'], `cd ${bad}`).toBeCloseTo(0.8 * (1 - 0.25 ** 2), 12);
      expect(flown['cdAuto'], `cd ${bad}`).toBe(true);
    }
  });
});
