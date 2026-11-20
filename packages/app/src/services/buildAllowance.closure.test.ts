import { expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from '@online-openrocket/engine';
import { bareWithoutAllowance, coveringCGOverride } from './buildAllowance.js';

it('J4 S7b-g7 backs out every allowance instance inside a pod assembly', () => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [
    { type: 'bodytube', id: 'core', length: 1, outerRadius: 0.05, density: 500, children: [
      { type: 'podset', id: 'pods', instanceCount: 2, children: [
        { type: 'bodytube', id: 'pod', length: 0.3, outerRadius: 0.02, density: 500, children: [
          { type: 'masscomponent', id: 'allowance', name: 'Build allowance', mass: 0.05, length: 0.02 },
        ] },
      ] },
    ] },
  ] }] };
  const rocket = OrkRocket.buildTree(tree);
  const info = rocket.staticInfo();
  const bare = bareWithoutAllowance(tree, 'allowance', info.massEmpty, info.cgEmpty, id => rocket.componentInfo(id));
  const without = structuredClone(tree);
  without.components[0]!.children![0]!.children![0]!.children![0]!.children = [];
  const expected = OrkRocket.buildTree(without).staticInfo();
  expect(bare.massKg).toBeCloseTo(expected.massEmpty, 10);
  expect(bare.cgM).toBeCloseTo(expected.cgEmpty, 10);
}, 30000);

it.each(['stage', 'body'])('backs out allowance mass at the covering %s CG override station', owner => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 'stage', children: [{ type: 'bodytube', id: 'body',
    length: 1, outerRadius: 0.05, overrideMass: 1, children: [{ type: 'masscomponent', id: 'allowance',
      name: 'Build allowance', mass: 0.2, length: 0.02, position: { method: 'top', offset: 0.79 } }] }] }] };
  const node = owner === 'stage' ? tree.components[0]! : tree.components[0]!.children![0]!;
  node['overrideCGX'] = 0.3; node['overrideSubcomponentsCG'] = true;
  const rocket = OrkRocket.buildTree(tree);
  const info = rocket.staticInfo();
  expect(coveringCGOverride(tree, 0.8, 0.02)?.id).toBe(owner);
  const bare = bareWithoutAllowance(tree, 'allowance', info.massEmpty, info.cgEmpty, id => rocket.componentInfo(id));
  const without = structuredClone(tree);
  without.components[0]!.children![0]!.children = [];
  const reference = OrkRocket.buildTree(without).staticInfo();
  expect(bare.massKg).toBeCloseTo(reference.massEmpty, 12);
  expect(bare.cgM).toBeCloseTo(reference.cgEmpty, 12);
});
