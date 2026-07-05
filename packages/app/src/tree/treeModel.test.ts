import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { findNode, makeNode, motorMounts, normalizeTree, treeForEngine } from './treeModel.js';
import { allowedChildren, defaultParams, DISPLAY_NAME, FIELDS } from './schema.js';

describe('off-axis assemblies (pods / parallel stages) — Phase 1 foundation', () => {
  const withPod = (): RocketTree => ({
    name: 'p',
    components: [{
      type: 'stage', id: 'c1', name: 'Sustainer',
      children: [
        { type: 'nosecone', id: 'c2', length: 0.07, aftRadius: 0.012 } as ComponentNode,
        {
          type: 'bodytube', id: 'c3', length: 0.3, outerRadius: 0.024,
          children: [
            { type: 'innertube', id: 'c4', outerRadius: 0.0095, motorMount: true } as ComponentNode,
            {
              type: 'parallelstage', id: 'c5', instanceCount: 2, radiusOffset: 0, angleOffset: 0,
              children: [{
                type: 'bodytube', id: 'c6', length: 0.2, outerRadius: 0.012,
                children: [{ type: 'innertube', id: 'c7', outerRadius: 0.0095, motorMount: true } as ComponentNode],
              } as ComponentNode],
            } as ComponentNode,
          ],
        } as ComponentNode,
      ],
    } as ComponentNode],
  });

  it('schema tables are total over the new types', () => {
    for (const t of ['podset', 'parallelstage'] as const) {
      expect(DISPLAY_NAME[t]).toBeTruthy();
      expect(FIELDS[t].length).toBeGreaterThan(0);
      expect(defaultParams(t).instanceCount).toBe(2);
    }
    // Assemblies attach to body components and hold an axial chain.
    expect(allowedChildren('bodytube')).toContain('podset');
    expect(allowedChildren('bodytube')).toContain('parallelstage');
    expect(allowedChildren('podset')).toEqual(['nosecone', 'bodytube', 'transition']);
    // parallelstage carries the separation fields; podset does not.
    expect(FIELDS.parallelstage.some((f) => f.key === 'separationEvent')).toBe(true);
    expect(FIELDS.podset.some((f) => f.key === 'separationEvent')).toBe(false);
  });

  it('treeForEngine strips assembly subtrees (temporary bridge guard)', () => {
    const stripped = treeForEngine(withPod());
    const types = (function walk(ns: ComponentNode[]): string[] {
      return ns.flatMap((n) => [n.type, ...walk(n.children ?? [])]);
    })(stripped.components);
    expect(types).not.toContain('parallelstage');
    expect(types).not.toContain('podset');
    // The core rocket survives intact.
    expect(types).toEqual(['stage', 'nosecone', 'bodytube', 'innertube']);
  });

  it('treeForEngine keeps pod-internal motor mounts out of motorMounts()', () => {
    const full = withPod();
    // Full tree exposes both mounts; the engine tree only the core one.
    expect(motorMounts(full).map((m) => m.id).sort()).toEqual(['c4', 'c7']);
    expect(motorMounts(treeForEngine(full)).map((m) => m.id)).toEqual(['c4']);
  });

  it('treeForEngine returns the SAME reference when there are no assemblies', () => {
    const plain: RocketTree = {
      name: 'x',
      components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'b', length: 0.3 } as ComponentNode] } as ComponentNode],
    };
    expect(treeForEngine(plain)).toBe(plain);
  });

  it('normalizeTree leaves a nested pod nested (top-level stage invariant holds)', () => {
    const out = normalizeTree(withPod());
    expect(out.components.every((n) => n.type === 'stage')).toBe(true);
    // The parallelstage is still nested under the body tube, never promoted.
    const booster = findNode(out, 'c5');
    expect(booster?.type).toBe('parallelstage');
    expect(out.components.some((n) => n.type === 'parallelstage')).toBe(false);
  });
});

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
