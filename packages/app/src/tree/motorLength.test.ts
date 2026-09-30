// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { legacyStageLimits, migrateMotorLengths, motorLengthLimit, motorLengthLossNotes } from './motorLength.js';
import { findNode, motorMounts, splitClusterTree, updateNode } from './treeModel.js';
import { scaleRocket } from './scaleRocket.js';
import { exportOrk, importOrk } from '../services/orkFile.js';
import { encodeShareFragment, decodeShareFragment } from '../services/shareLink.js';

/** Synthetic geometry in SI: core 0.60 m, pod 0.25 m, both body-tube mounts. */
const fixture = (): RocketTree => ({ name: 'Core and pods', components: [{
  type: 'stage', id: 's', children: [{
    type: 'bodytube', id: 'core', name: 'Core', length: 0.60, outerRadius: 0.03,
    thickness: 0.001, motorMount: true, maxMotorLength: 0.60,
    children: [{ type: 'podset', id: 'pods', instanceCount: 2, children: [{
      type: 'bodytube', id: 'pod', name: 'Pod', length: 0.25, outerRadius: 0.015,
      thickness: 0.001, motorMount: true, maxMotorLength: 0.25,
    }] }],
  }, { type: 'innertube', id: 'inner', name: 'Inner', length: 0.2, outerRadius: 0.01,
    thickness: 0.001, motorMount: true, cluster: '4-ring' }],
}] });

describe('per-mount motor lengths', () => {
  it('resolves each mount alone, including zero, blank and invalid values', () => {
    const tree = fixture();
    expect(motorMounts(tree).map(motorLengthLimit)).toEqual([0.60, 0.25, null]);
    for (const value of [undefined, null, NaN, Infinity, -1]) {
      expect(motorLengthLimit({ type: 'innertube', maxMotorLength: value })).toBeNull();
    }
    expect(motorLengthLimit({ type: 'innertube', maxMotorLength: 0 })).toBe(0);
  });

  it('fills only empty mounts in their own stage, preserving zero and source tree', () => {
    const before = fixture();
    before.components.push({ type: 'stage', id: 'booster', children: [
      { type: 'innertube', id: 'other', motorMount: true },
      { type: 'innertube', id: 'zero', motorMount: true, maxMotorLength: 0 },
    ] });
    const after = migrateMotorLengths(before, { s: 0.4, booster: 0.1 });
    expect(motorMounts(after).map(motorLengthLimit)).toEqual([0.60, 0.25, 0.4, 0.1, 0]);
    expect(findNode(before, 'inner')!['maxMotorLength']).toBeUndefined();
    expect(migrateMotorLengths(after, { s: 0.3 })).toBe(after);
    expect(migrateMotorLengths(before, { s: NaN, booster: -1 })).toBe(before);
    expect(motorLengthLimit(findNode(migrateMotorLengths(before, { s: 0 }), 'inner'))).toBe(0);
  });

  it('reads stage, universal and motor-filter legacy keys once with their original precedence', () => {
    const tree = fixture();
    expect(legacyStageLimits(tree, { maxMotorLengthByStage: { s: 0.3 }, maxMotorLengthM: 0.4 }, 0.5)).toEqual({ s: 0.3 });
    expect(legacyStageLimits(tree, { maxMotorLengthByStage: {} }, 0.5)).toEqual({});
    expect(legacyStageLimits(tree, { maxMotorLengthM: 0.4 }, 0.5)).toEqual({ s: 0.4 });
    expect(legacyStageLimits(tree, { maxMotorLengthM: null }, 0.5)).toEqual({});
    expect(legacyStageLimits(tree, { maxMotorLengthM: 0 }, 0.5)).toEqual({ s: 0 });
    expect(legacyStageLimits(tree, {}, 0.5)).toEqual({ s: 0.5 });
    expect(legacyStageLimits(tree, { motorLengthLimitsMigrated: true }, 0.5)).toEqual({});
    expect(legacyStageLimits(tree, null, 0.5)).toEqual({});
  });

  it('round trips both tube types, nested pods, zero and blank through .ork and share codec', async () => {
    const tree = updateNode(fixture(), 'inner', { maxMotorLength: 0 });
    const xml = exportOrk({ name: tree.name!, tree });
    for (const payload of [xml, await decodeShareFragment(await encodeShareFragment(xml))]) {
      const mounts = motorMounts(importOrk(payload).tree);
      expect(mounts.map(motorLengthLimit)).toEqual([0.60, 0.25, 0]);
      expect(mounts.map((m) => m.id)).not.toEqual(['core', 'pod', 'inner']);
    }
    const blank = importOrk(exportOrk({ name: 'Blank', tree: fixture() })).tree;
    expect(motorMounts(blank).map(motorLengthLimit)).toEqual([0.60, 0.25, null]);
  });

  it('scales both tube types and retains the source limit on split cluster groups', () => {
    const tree = updateNode(fixture(), 'inner', { maxMotorLength: 0.3 });
    const scaled = scaleRocket(tree, 2).tree;
    expect(motorMounts(scaled).map(motorLengthLimit)).toEqual([1.2, 0.5, 0.6]);
    const split = splitClusterTree(tree, 'inner')!;
    expect(split.mountIds.map((id) => motorLengthLimit(findNode(split.tree, id)))).toEqual(split.mountIds.map(() => 0.3));
    expect(motorLengthLimit(findNode(scaleRocket(fixture(), 2).tree, 'inner'))).toBeNull();
  });

  it('reports losses only when a motor mount has a limit, including zero', () => {
    for (const format of ['.rkt', '.CDX1']) {
      expect(motorLengthLossNotes(fixture(), format)).toEqual([
        `Maximum motor length settings are not saved in ${format}. Save a .ork file to keep them.`,
      ]);
      const tree: RocketTree = { components: [{ type: 'bodytube', motorMount: true, maxMotorLength: 0 }] };
      expect(motorLengthLossNotes(tree, format)).toHaveLength(1);
      tree.components[0]!.maxMotorLength = undefined;
      expect(motorLengthLossNotes(tree, format)).toEqual([]);
      tree.components[0]!.motorMount = false;
      tree.components[0]!.maxMotorLength = 0.3;
      expect(motorLengthLossNotes(tree, format)).toEqual([]);
    }
  });
});
