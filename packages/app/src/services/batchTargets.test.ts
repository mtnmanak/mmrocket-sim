import { expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { batchMatchingMounts, batchTargetsDefault, batchMountDisclosure } from './batchMountDisclosure.js';
import { batchRingSplits } from './batchRing.js';
import { testMotor } from './autoDelay.testSupport.js';
import type { BatchMountOption } from './batchSweep.js';

const option = (id: string): BatchMountOption => ({ id, label: id, diameterMm: 75, motorCount: 1, maxMotorLengthM: null });
function ring(angles = [0, 90, 180, 270], rotation = 0): RocketTree {
  return { components: [{ type: 'stage', id: 'stage', children: [{ type: 'bodytube', id: 'body', children:
    angles.map((angle, i) => ({ type: 'innertube', id: `m${i}`, name: 'MMT', motorMount: true,
      outerRadius: 0.0385, thickness: 0.001, radialPosition: 0.06,
      radialDirection: angle * Math.PI / 180 + rotation })) }] }] };
}
const options = (tree: RocketTree) => tree.components[0]!.children![0]!.children!.map(m => option(m.id!));

it('124 shares stage/bore matching and defaults by motor identity alone', () => {
  const tree = ring();
  const mounts = options(tree);
  expect(batchMatchingMounts(tree, mounts, mounts[0]!)).toHaveLength(4);
  expect(batchTargetsDefault(mounts, {}, {}, {})).toBe(true);
  const spec = testMotor(false, 5).spec;
  const specs = Object.fromEntries(mounts.map(m => [m.id, spec]));
  const ids = Object.fromEntries(mounts.map(m => [m.id, 'same']));
  expect(batchTargetsDefault(mounts, specs, {}, ids)).toBe(true);
  expect(batchTargetsDefault(mounts, specs, {}, { ...ids, m1: 'different' })).toBe(false);
  expect(batchTargetsDefault(mounts, { ...specs, m1: { ...spec, ejectionDelay: Infinity } }, {}, ids)).toBe(true);
  expect(batchTargetsDefault(mounts, specs, { m1: testMotor(true, 8) }, ids)).toBe(true);
  const ex = Object.fromEntries(mounts.map(m => [m.id, { ...testMotor(false, 5), meta: { label: 'EX', exMotorId: 'ex:same' } }]));
  expect(batchTargetsDefault(mounts, specs, ex, {})).toBe(true);
  expect(batchTargetsDefault(mounts, specs, { ...ex, m1: { ...ex.m1!, meta: { label: 'EX', exMotorId: 'ex:other' } } }, {})).toBe(false);
  expect(batchTargetsDefault(mounts, { m0: spec }, {}, ids)).toBe(false);
  tree.components[0]!.children![0]!.children![1]!['outerRadius'] = 0.04;
  const other = tree.components[0]!.children![0]!.children!.pop()!;
  tree.components.push({ type: 'stage', id: 'other', children: [other] });
  expect(batchMatchingMounts(tree, mounts, mounts[0]!).map(m => m.id)).toEqual(['m0', 'm2']);
});

it('124 discloses every candidate target with numbered names and cautions only for kept matches', () => {
  const tree = ring(); const mounts = options(tree);
  const all = batchMountDisclosure(tree, mounts, mounts[0]!, {}, {}, {}, {}, mounts.map(m => m.id));
  expect(all.text).toBe('Candidates fly in MMT 1, MMT 2, MMT 3 and MMT 4.');
  expect(all.matching).toBe(false);
  expect(all.mixedUnavailable).toBeNull();
  const one = batchMountDisclosure(tree, mounts, mounts[0]!, {}, {}, {}, {});
  expect(one.text).toContain('Each row is that mix');
  expect(one.matching).toBe(true);
});

it.each([0, 0.37, -2.8])('125 pairs opposite tubes regardless of common rotation %s', rotation => {
  const tree = ring(undefined, rotation); const mounts = options(tree);
  const splits = batchRingSplits(tree, mounts);
  expect(splits.halves?.mountGroups).toEqual([['m0', 'm2'], ['m1', 'm3']]);
  expect(splits.halves?.tree).toBe(tree);
  expect(splits.pairs).toBeNull();
});

it('125 six-ring halves alternate and three pairs are diametrically opposite', () => {
  const tree = ring([0, 60, 120, 180, 240, 300]);
  const splits = batchRingSplits(tree, options(tree));
  expect(splits.halves?.mountGroups).toEqual([['m0', 'm2', 'm4'], ['m1', 'm3', 'm5']]);
  expect(splits.pairs?.mountGroups).toEqual([['m0', 'm3'], ['m1', 'm4'], ['m2', 'm5']]);
  for (const pair of splits.pairs!.mountGroups!) {
    const nodes = pair.map(id => tree.components[0]!.children![0]!.children!.find(m => m.id === id)!);
    expect(Math.abs(Number(nodes[0]!['radialDirection']) - Number(nodes[1]!['radialDirection']))).toBeCloseTo(Math.PI);
  }
});

it.each(['spacing', 'radius', 'parent', 'cluster', 'copies', 'bore'] as const)('125 rejects %s and explains a failed ring', defect => {
  const tree = ring(); const mounts = options(tree);
  const nodes = tree.components[0]!.children![0]!.children!;
  if (defect === 'spacing') nodes[1]!['radialDirection'] = 80 * Math.PI / 180;
  if (defect === 'radius') nodes[1]!['radialPosition'] = 0.062;
  if (defect === 'cluster') nodes[1]!['cluster'] = 'double';
  if (defect === 'copies') mounts[1]!.motorCount = 2;
  if (defect === 'bore') nodes[1]!['outerRadius'] = 0.04;
  if (defect === 'parent') tree.components[0]!.children!.push({ type: 'bodytube', id: 'body2', children: [nodes.pop()!] } as ComponentNode);
  expect(batchRingSplits(tree, mounts).halves).toBeNull();
  expect(batchMountDisclosure(tree, mounts, mounts[0]!, {}, {}, {}, {}, mounts.map(m => m.id)).mixedUnavailable)
    .toContain('these 4 mounts are not evenly spaced around one ring');
});

it.each([[0.00049, true], [0.00051, false]] as const)('125 enforces the half-millimetre radius and bore limits (%s m)', (difference, eligible) => {
  const tree = ring(); const mounts = options(tree);
  const tube = tree.components[0]!.children![0]!.children![1]!;
  tube['radialPosition'] = 0.06 + difference;
  expect(batchRingSplits(tree, mounts).halves !== null).toBe(eligible);
  tube['radialPosition'] = 0.06;
  tube['outerRadius'] = 0.0385 + difference / 2;
  expect(batchRingSplits(tree, mounts).halves !== null).toBe(eligible);
});

it.each([[0.99, true], [1.01, false]] as const)('125 enforces the one-degree spacing limit (%s degrees)', (difference, eligible) => {
  const tree = ring([0, 90 + difference, 180, 270]);
  expect(batchRingSplits(tree, options(tree)).halves !== null).toBe(eligible);
});
