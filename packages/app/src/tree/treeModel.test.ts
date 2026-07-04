import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { findNode, makeNode, normalizeTree } from './treeModel.js';

describe('normalizeTree id reseeding', () => {
  it('mints ids past the ones in a restored tree (no duplicates after reload)', () => {
    // Simulate a restored session whose previous page load minted c500/c501.
    const restored: RocketTree = {
      name: 'r',
      components: [{
        type: 'stage', id: 'c500', name: 'Sustainer',
        children: [{ type: 'bodytube', id: 'c501', length: 0.3 } as ComponentNode],
      } as ComponentNode],
    };
    normalizeTree(restored);
    const fresh = makeNode('bodytube');
    expect(Number(fresh.id!.slice(1))).toBeGreaterThan(501);
  });
});

describe('normalizeTree mixed lists', () => {
  it('folds loose nodes into the nearest preceding stage (never nests stages)', () => {
    const mixed: RocketTree = {
      name: 'm',
      components: [
        { type: 'stage', id: 'c1', name: 'Sustainer', children: [] } as ComponentNode,
        { type: 'bodytube', id: 'c2', length: 0.3 } as ComponentNode,
      ],
    };
    const out = normalizeTree(mixed);
    expect(out.components.every((n) => n.type === 'stage')).toBe(true);
    expect(out.components).toHaveLength(1);
    expect(out.components[0]!.children!.map((c) => c.id)).toEqual(['c2']);
  });
});

describe('normalizeTree absolute positions', () => {
  it('rewrites rocket-origin absolute offsets into parent-relative top offsets', () => {
    const tree: RocketTree = {
      name: 'a',
      components: [{
        type: 'stage', id: 's', name: 'Sustainer',
        children: [
          { type: 'bodytube', id: 'b1', length: 0.2 } as ComponentNode,
          {
            type: 'bodytube', id: 'b2', length: 0.3,
            children: [{
              type: 'launchlug', id: 'l', length: 0.05,
              position: { method: 'absolute', offset: 0.25 },
            } as ComponentNode],
          } as ComponentNode,
        ],
      } as ComponentNode],
    };
    const out = normalizeTree(tree);
    const lug = findNode(out, 'l')!;
    // b2 starts at 0.2 from the nose tip → absolute 0.25 = 0.05 into b2.
    expect(lug.position?.method).toBe('top');
    expect(lug.position?.offset).toBeCloseTo(0.05, 12);
  });
});
