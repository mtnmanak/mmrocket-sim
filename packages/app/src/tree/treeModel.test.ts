import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { engineTree, findNode, hasParallelStage, makeNode, motorMounts, normalizeTree, splitClusterTree } from './treeModel.js';
import { clusterOffsets } from './cluster.js';
import { allowedChildren, defaultParams, DISPLAY_NAME, FIELDS } from './schema.js';

describe('engineTree — spill-hole Cd reduction at the engine boundary', () => {
  const chuteTree = (params: Record<string, unknown>): RocketTree => ({
    name: 's',
    components: [{
      type: 'stage', id: 's1',
      children: [{
        type: 'bodytube', id: 'b1', length: 0.3, outerRadius: 0.02,
        children: [{ type: 'parachute', id: 'p1', diameter: 0.6, ...params } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode],
  });

  it('reduces cd by the hole/canopy area ratio (explicit cd)', () => {
    const out = engineTree(chuteTree({ cd: 2.2, spillHoleDiameter: 0.15 }));
    const chute = findNode(out, 'p1')!;
    // 2.2 · (1 − (0.15/0.6)²) = 2.2 · 0.9375
    expect(chute['cd']).toBeCloseTo(2.0625, 9);
  });

  it('applies the reduction to the kernel default 0.8 when cd is auto', () => {
    const out = engineTree(chuteTree({ spillHoleDiameter: 0.3 }));
    expect(findNode(out, 'p1')!['cd']).toBeCloseTo(0.8 * 0.75, 9);
  });

  it('leaves the editing tree untouched and no-hole chutes alone', () => {
    const src = chuteTree({ cd: 1.5 });
    const out = engineTree(src);
    expect(findNode(out, 'p1')!['cd']).toBe(1.5);
    const withHole = chuteTree({ cd: 1.5, spillHoleDiameter: 0.1 });
    engineTree(withHole);
    expect(findNode(withHole, 'p1')!['cd']).toBe(1.5); // source unmodified
  });
});

describe('splitClusterTree — symmetric group split for combination batching', () => {
  const clusterTree = (cluster: string, extra: Record<string, unknown> = {}): RocketTree => ({
    name: 'c',
    components: [{
      type: 'stage', id: 's1',
      children: [{
        type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.05,
        children: [{
          type: 'innertube', id: 'm1', length: 0.1, outerRadius: 0.015,
          motorMount: true, cluster, ...extra,
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode],
  });

  /** Union of the split groups must occupy the ORIGINAL cluster's positions. */
  const positionsMatch = (cluster: string, scale: number, rotation: number) => {
    const split = splitClusterTree(clusterTree(cluster, { clusterScale: scale, clusterRotation: rotation }), 'm1')!;
    expect(split).not.toBeNull();
    const r = 0.015;
    const original = clusterOffsets(cluster, r, scale, rotation);
    const got = split.mountIds.flatMap((id) => {
      const m = findNode(split.tree, id)!;
      return clusterOffsets(m['cluster'] as string, r,
        m['clusterScale'] as number, m['clusterRotation'] as number);
    });
    expect(got.length).toBe(original.length);
    for (const o of original) {
      const hit = got.find((g) => Math.hypot(g.y - o.y, g.z - o.z) < 1e-9);
      expect(hit, `original tube at (${o.y}, ${o.z}) missing from split`).toBeDefined();
    }
  };

  it('4-ring → two doubles on the diagonals (exact positions)', () => {
    positionsMatch('4-ring', 1, 0);
    positionsMatch('4-ring', 1.3, Math.PI / 5);
  });

  it('6-ring → two 3-rings on alternating tubes (exact positions)', () => {
    positionsMatch('6-ring', 1, 0);
    positionsMatch('6-ring', 1.15, -Math.PI / 7);
  });

  it('returns null for non-splittable mounts', () => {
    expect(splitClusterTree(clusterTree('3-ring'), 'm1')).toBeNull();
    expect(splitClusterTree(clusterTree('single'), 'm1')).toBeNull();
    expect(splitClusterTree(clusterTree('4-ring'), 'nope')).toBeNull();
  });

  it('keeps the original tree untouched and both groups carry children', () => {
    const src = clusterTree('4-ring');
    const split = splitClusterTree(src, 'm1')!;
    expect(findNode(src, 'm1')).not.toBeNull(); // source intact
    expect(findNode(split.tree, 'm1')).toBeNull(); // replaced in the copy
    expect(split.groupSize).toBe(2);
  });
});

describe('engineTree — camera shroud (fairing) lowering', () => {
  const fairingTree = (params: Record<string, unknown>): RocketTree => ({
    name: 'f',
    components: [{
      type: 'stage', id: 's1',
      children: [{
        type: 'bodytube', id: 'b1', length: 0.6, outerRadius: 0.05,
        children: [{
          type: 'fairing', id: 'f1', length: 0.08, width: 0.025, height: 0.02,
          mass: 0.045, position: { method: 'middle', offset: 0 }, ...params,
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode],
  });

  it('lowers to a 1-fin strake with mass + CD overrides, same id', () => {
    const out = engineTree(fairingTree({ fairingShape: 'halfround' }));
    const strake = findNode(out, 'f1')!;
    expect(strake.type).toBe('freeformfinset');
    expect(strake['finCount']).toBe(1);
    expect(strake['thickness']).toBeCloseTo(0.025, 9);
    expect(strake['overrideMass']).toBeCloseTo(0.045, 9);
    // Hoerner half-round 0.55 · frontal (0.025·0.02) / (π·0.05²)
    expect(strake['overrideCD']).toBeCloseTo((0.55 * 0.025 * 0.02) / (Math.PI * 0.05 * 0.05), 9);
    const pts = strake['points'] as [number, number][];
    expect(pts[2]).toEqual([0.08, 0.02]);
  });

  it('streamlined shape ramps the profile and drops the CD', () => {
    const out = engineTree(fairingTree({ fairingShape: 'streamlined' }));
    const strake = findNode(out, 'f1')!;
    const pts = strake['points'] as [number, number][];
    expect(pts[1]![0]).toBeCloseTo(0.024, 9); // 0.3·L ramp
    expect(strake['overrideCD']).toBeCloseTo((0.25 * 0.025 * 0.02) / (Math.PI * 0.05 * 0.05), 9);
  });
});

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

  it('exposes pod-internal motor mounts to motorMounts() (pods now build in the engine)', () => {
    const full = withPod();
    expect(motorMounts(full).map((m) => m.id).sort()).toEqual(['c4', 'c7']);
  });

  it('hasParallelStage detects a nested booster (drives the batch-sim gate)', () => {
    expect(hasParallelStage(withPod())).toBe(true);
    const podOnly: RocketTree = {
      name: 'p',
      components: [{
        type: 'stage', id: 's',
        children: [{ type: 'bodytube', id: 'b', length: 0.3, children: [{ type: 'podset', id: 'pd' } as ComponentNode] } as ComponentNode],
      } as ComponentNode],
    };
    // A non-separating pod is NOT a parallel stage.
    expect(hasParallelStage(podOnly)).toBe(false);
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
