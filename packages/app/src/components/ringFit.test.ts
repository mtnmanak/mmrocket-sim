import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { ringFitFor } from './ringFit.js';

describe('Round 5 certain-or-silent catalogue fit', () => {
  it('S3c-g3 checks an explicit inside diameter when the outside is automatic', () => {
    const ring: ComponentNode = { id: 'ring', type: 'centeringring', length: 0.003, innerRadius: 0.008 };
    const tree: RocketTree = { components: [{ id: 'body', type: 'bodytube', length: 0.3,
      outerRadius: 0.033, thickness: 0.001, children: [ring,
        { id: 'mount', type: 'innertube', length: 0.3, outerRadius: 0.01 }] }] };
    expect(ringFitFor(tree, ring, { outside: false, inside: true }).comparisons.map(c => c.dimension)).toEqual(['inside']);
  });
  function fit(outside: number, inside: number) {
    const ring: ComponentNode = { id: 'ring', name: 'Picked ring', type: 'centeringring',
      length: 0.003, outerRadius: outside / 2, innerRadius: inside / 2 };
    const tree: RocketTree = { components: [{ id: 'body', type: 'bodytube', name: 'BT-80',
      length: 0.3, outerRadius: 0.033, thickness: 0.00055, children: [ring,
        { id: 'mount', type: 'innertube', name: 'Mount', length: 0.3, outerRadius: 0.01 }],
    }] };
    return { tree, ring, result: ringFitFor(tree, ring, { outside: true, inside: true }) };
  }
  it.each([
    [0.0654, 0.0195], [0.0619, 0.02], [0.0649, 0.021],
  ])('keeps exact limits or larger holes silent: OD %s m / ID %s m', (od, id) => {
    expect(fit(od, id).result.notes).toEqual([]);
  });
  it.each([
    [0.065401, 0.02, 'outside'], [0.061899, 0.02, 'outside'], [0.0649, 0.019499, 'inside'],
  ])('warns just beyond the diameter limit: OD %s m / ID %s m', (od, id, dimension) => {
    expect(fit(od, id).result.comparisons.map(c => c.dimension)).toEqual([dimension]);
  });
  it.each(['innertube', 'tubecoupler'] as const)('checks an around-%s pick against the host', type => {
    const ring: ComponentNode = { id: 'ring', type: 'centeringring', name: 'Picked ring', length: 0.003,
      outerRadius: 0.04, innerRadius: 0.009 };
    const mount: ComponentNode = { id: 'mount', type, name: 'Av-bay tube', length: 0.3,
      outerRadius: 0.01, thickness: 0.001, children: [ring] };
    const tree: RocketTree = { components: [{ id: 'body', type: 'bodytube', name: 'Airframe',
      length: 0.3, outerRadius: 0.033, thickness: 0.00055, children: [mount] }] };
    const result = ringFitFor(tree, ring, { outside: true, inside: true });
    expect(result.notes.join(' ')).toContain('bore of Airframe (64.90 mm)');
    expect(result.notes.join(' ')).toContain('tube it fits around (Av-bay tube) (20.00 mm)');
    ring['outerRadius'] = 0.015;
    ring['innerRadius'] = 0.01;
    expect(ringFitFor(tree, ring, { outside: true, inside: true }).notes).toEqual([]); // a sleeve need not reach the host
  });
  it('resolves absolute sibling stations before declaring a pick certain', () => {
    const ring: ComponentNode = { id: 'ring', type: 'bulkhead', length: 0.006,
      position: { method: 'top', offset: 0.064 }, outerRadius: 0.02 };
    const tree: RocketTree = { components: [{ id: 'stage', type: 'stage', children: [
      { type: 'nosecone', length: 0.5, aftRadius: 0.04 },
      { id: 'body', type: 'bodytube', length: 0.4, outerRadius: 0.0391, thickness: 0.001,
        children: [ring, { id: 'coupler', type: 'tubecoupler', length: 0.15,
          position: { method: 'absolute', offset: 0.55 }, outerRadius: 0.0381, thickness: 0.00089 }] },
    ] }] };
    expect(ringFitFor(tree, ring, { outside: true, inside: true }).notes).toEqual([]);
  });
});
