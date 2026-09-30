import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { affectsPodsOnlyBase, affectsStrapOnNozzle } from './revisionNozzle.js';

const tree = (...children: ComponentNode[]): RocketTree => ({
  name: 'Revision', components: [{ type: 'stage', children }],
});
const mount: ComponentNode = { type: 'innertube', motorMount: true };

describe('nozzle revision predicates (tree only)', () => {
  it('finds a nested strap-on exit or owned mount, even empty, OFF or never separating', () => {
    for (const detail of [{ nozzleExitDiameter: 0.02 }, { nozzleExitDiameter: 0, children: [mount] }]) {
      expect(affectsStrapOnNozzle(tree({ type: 'bodytube', children: [{
        type: 'parallelstage', separationEvent: 'never', ...detail,
      }] }))).toBe(true);
    }
    for (const d of [undefined, 0, -1, NaN, Infinity]) {
      expect(affectsStrapOnNozzle(tree({ type: 'parallelstage', nozzleExitDiameter: d }))).toBe(false);
    }
    expect(affectsStrapOnNozzle(tree(mount))).toBe(false);
    expect(affectsStrapOnNozzle(tree({ type: 'podset', children: [mount] }))).toBe(false);
    expect(affectsStrapOnNozzle(tree({ type: 'parallelstage', children: [
      { type: 'bodytube', motorMount: false },
    ] }))).toBe(false);
  });

  it('finds pod mounts on serial or parallel stages, including mixed loadouts', () => {
    const pod: ComponentNode = { type: 'podset', children: [{ type: 'bodytube', children: [mount] }] };
    expect(affectsPodsOnlyBase(tree(pod, mount))).toBe(true);
    expect(affectsPodsOnlyBase(tree({ type: 'parallelstage', children: [pod] }))).toBe(true);
    expect(affectsPodsOnlyBase(tree(mount))).toBe(false);
    expect(affectsPodsOnlyBase(tree({ type: 'podset', children: [{ type: 'bodytube' }] }))).toBe(false);
    // The outer pod is not a pod line of the nested parallel stage's core motor.
    expect(affectsPodsOnlyBase(tree({ type: 'podset', children: [
      { type: 'parallelstage', children: [mount] },
    ] }))).toBe(false);
  });
});
