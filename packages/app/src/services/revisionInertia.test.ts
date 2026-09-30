import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { affectsRollInertia } from './revisionInertia.js';

const tree = (...components: ComponentNode[]): RocketTree => ({ components });

describe('saved-run roll inertia eligibility', () => {
  it('excludes purely axial designs, including ordinary symmetric fins', () => {
    expect(affectsRollInertia(tree())).toBe(false);
    expect(affectsRollInertia(tree({ type: 'stage', children: [
      { type: 'bodytube', children: [
        { type: 'innertube', cluster: 'single', radialPosition: 0 },
        { type: 'masscomponent', mass: 0.1 },
        { type: 'freeformfinset', finCount: 3, crossSection: 'airfoil', cant: 0.03 },
        { type: 'tubefinset' },
      ] },
    ] }))).toBe(false);
  });

  it.each(['podset', 'parallelstage'] as const)('flags even symmetric or collapsed %s assemblies', (type) => {
    expect(affectsRollInertia(tree({ type, instanceCount: 2, radiusOffset: 0 }))).toBe(true);
  });

  it.each(['innertube', 'masscomponent'] as const)('flags radial %s placement at either sign', (type) => {
    for (const radialPosition of [-0.02, 0.02]) {
      expect(affectsRollInertia(tree({ type, radialPosition, motorMount: false }))).toBe(true);
    }
  });

  it('retains radial-reference flags on lowered geometry', () => {
    expect(affectsRollInertia(tree({ type: 'bodytube', radiusOffset: 0.01 }))).toBe(true);
  });

  it('uses default cluster spacing; excludes only actually collapsed or single clusters', () => {
    for (const cluster of ['double', '3-ring', '9-star']) {
      expect(affectsRollInertia(tree({ type: 'innertube', cluster }))).toBe(true);
      expect(affectsRollInertia(tree({ type: 'innertube', cluster, clusterScale: 0 }))).toBe(false);
    }
    expect(affectsRollInertia(tree({ type: 'innertube', cluster: 'single', clusterScale: 2 }))).toBe(false);
    expect(affectsRollInertia(tree({ type: 'innertube', cluster: 'constructor' }))).toBe(false);
  });

  it.each(['trapezoidfinset', 'ellipticalfinset', 'freeformfinset', 'tubefinset'] as const)(
    'flags a single %s, with no cant requirement', (type) => {
      expect(affectsRollInertia(tree({ type, finCount: 1, cant: 0, crossSection: 'rounded' }))).toBe(true);
      expect(affectsRollInertia(tree({ type, finCount: 2 }))).toBe(false);
      expect(affectsRollInertia(tree({ type }))).toBe(false);
    });

  it.each(['fairing', 'launchlug', 'railbutton'] as const)('flags asymmetric %s geometry', (type) => {
    expect(affectsRollInertia(tree({ type }))).toBe(true);
  });

  it('handles an editor protuberance before lowering', () => {
    const node = { type: 'protuberance' } as unknown as ComponentNode;
    expect(affectsRollInertia(tree(node))).toBe(true);
  });

  it('inspects every descendant despite overrides, empty motors, or balanced siblings', () => {
    const t = tree({ type: 'stage', overrideMass: 0, overrideSubcomponentsMass: true, children: [
      { type: 'bodytube', children: [
        { type: 'innertube', radialPosition: 0.03, radialDirection: 0 },
        { type: 'innertube', radialPosition: 0.03, radialDirection: Math.PI },
      ] },
    ] });
    const before = structuredClone(t);
    expect(affectsRollInertia(t)).toBe(true);
    expect(t).toEqual(before);
  });
});
