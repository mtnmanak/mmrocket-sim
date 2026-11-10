import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { couplerRingFitNote, ringFitFor } from './ringFit.js';
import { IMPERIAL_UNITS, noticeQuantity } from '../prefs/units.js';
import { centeringRingBore, ringOuterRadius } from '../tree/solidMesh.js';
import { solidContextFor } from '../tree/solidContext.js';

it.each(['fore', 'aft'] as const)('HF7 r2 advises for an accepted %s overhang', end => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', innerRadius: 0.01,
    length: 0.003, position: { method: end === 'fore' ? 'top' : 'bottom', offset: end === 'fore' ? -0.002 : 0.002 } };
  const tree: RocketTree = { components: [{ type: 'bodytube', length: 0.4, outerRadius: 0.03,
    children: [ring, { type: 'tubecoupler', length: 0.5, position: { method: 'top', offset: -0.05 },
      children: [{ type: 'innertube', length: 0.5, outerRadius: 0.0101 }] }] }] };
  const ctx = solidContextFor(tree, ring);
  expect(centeringRingBore(ring, ctx, ringOuterRadius(ring, ctx).r)).toBeCloseTo(0.01, 10);
  expect(couplerRingFitNote(tree, ring)).toContain('The tube cannot pass through');
});

it.each([0.01, 0.009, 0.0100000005])('HF7 r2 stays silent when the stated bore is unusable with outer radius %s m', outerRadius => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', innerRadius: 0.01, outerRadius, length: 0.003 };
  const tree: RocketTree = { components: [{ type: 'bodytube', length: 0.3, outerRadius: 0.03,
    children: [ring, { type: 'tubecoupler', length: 0.3,
      children: [{ type: 'innertube', length: 0.3, outerRadius: 0.0101 }] }] }] };
  expect(couplerRingFitNote(tree, ring)).toBeUndefined();
});

it('HF7 formats the coupler clearance shortfall in the selected length unit and ignores other layouts', () => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', innerRadius: 0.01, length: 0.003,
    position: { method: 'top', offset: 0.1 } };
  const tube: ComponentNode = { type: 'innertube', length: 0.3, outerRadius: 0.0101 };
  const coupler: ComponentNode = { type: 'tubecoupler', length: 0.3,
    position: { method: 'top', offset: 0 }, children: [tube] };
  const tree: RocketTree = { components: [{ type: 'bodytube', id: 'body', length: 0.4,
    outerRadius: 0.03, children: [ring, coupler] }] };
  expect(couplerRingFitNote(tree, ring, IMPERIAL_UNITS)).toContain(noticeQuantity('length', 0.0002, IMPERIAL_UNITS));
  ring['position'] = { method: 'top', offset: 0.35 };
  expect(couplerRingFitNote(tree, ring)).toBeUndefined(); // no axial overlap
  ring['position'] = { method: 'top', offset: 0.1 };
  delete ring['innerRadius'];
  expect(couplerRingFitNote(tree, ring)).toBeUndefined(); // automatic hole
  ring['innerRadius'] = 0.01;
  tree.components[0]!.children = [ring, tube];
  expect(couplerRingFitNote(tree, ring)).toBeUndefined();
  expect(ringFitFor(tree, ring, { outside: false, inside: true }).notes).toEqual([]); // existing direct tolerance
});

describe('Round 5 certain-or-silent catalogue fit', () => {
  it.each(['sibling', 'parent'] as const)('H6 r6 compares an omitted-radius inner tube as a %s', placement => {
    const ring: ComponentNode = { id: 'ring', type: 'centeringring', length: 0.003,
      outerRadius: 0.03, innerRadius: 0.008 };
    const mount: ComponentNode = { id: 'mount', type: 'innertube', name: 'Default mount', length: 0.3,
      ...(placement === 'parent' ? { children: [ring] } : {}) };
    const tree: RocketTree = { components: [{ id: 'body', type: 'bodytube', length: 0.3,
      outerRadius: 0.033, thickness: 0.001,
      children: placement === 'parent' ? [mount] : [ring, mount] }] };
    const result = ringFitFor(tree, ring, { outside: true, inside: true });
    expect(result.comparisons.map(c => c.dimension)).toEqual(placement === 'parent' ? ['inside'] : ['outside', 'inside']);
    expect(result.comparisons.find(c => c.dimension === 'inside')!.expectedRadius).toBeCloseTo(0.0095, 10);
    expect(result.notes.join(' ')).toContain('Default mount');
    // Explicit sizes, including zero, must not be replaced by the default.
    mount['outerRadius'] = 0;
    expect(ringFitFor(tree, ring, { outside: false, inside: true }).comparisons).toEqual([]);
  });
  it('keeps catalogue advice silent for concentric tubes even though one centred export bore is resolved', () => {
    const { tree, ring } = fit(0.04, 0.015);
    tree.components[0]!.children!.push({ id: 'sleeve', type: 'innertube', length: 0.3, outerRadius: 0.008 });
    expect(ringFitFor(tree, ring, { outside: true, inside: true }).notes).toEqual([]);
  });
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
    expect(result.notes.join(' ')).toContain('bore of Airframe (64.9 mm [2.555 in])');
    expect(result.notes.join(' ')).toContain('tube it fits around (Av-bay tube) (20 mm [0.787 in])');
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
