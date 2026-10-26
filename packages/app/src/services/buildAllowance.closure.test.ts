import { expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from '@online-openrocket/engine';
import { bareWithoutAllowance, coveringCGOverride } from './buildAllowance.js';

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
