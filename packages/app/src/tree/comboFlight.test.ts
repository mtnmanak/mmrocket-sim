import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import { engineTree, splitClusterTree } from './treeModel.js';

/**
 * Combination batching, end-to-end through the real kernel: the split-mount
 * variant must fly, must match the original single-mount cluster when both
 * groups carry the SAME motor, and must respond to a mixed pair.
 */

const spec = (name: string, scale: number): MotorSpec => ({
  designation: name,
  diameter: 0.018,
  length: 0.07,
  cgX: 0.035,
  ejectionDelay: 5,
  times: [0, 0.05, 0.1, 0.4, 1.0, 2.0, 2.5],
  thrusts: [0, 3.8, 11.75, 4.0, 3.2, 3.0, 0].map((t) => t * scale),
  masses: [0.021, 0.02, 0.019, 0.016, 0.012, 0.01, 0.009],
});

const clusterTree = (): RocketTree => ({
  name: 'combo',
  components: [{
    type: 'stage', id: 's1', name: 'Sustainer',
    children: [
      { type: 'nosecone', id: 'n1', length: 0.1, aftRadius: 0.025, thickness: 0.002 } as ComponentNode,
      {
        type: 'bodytube', id: 'b1', length: 0.5, outerRadius: 0.025, thickness: 0.0005, density: 950,
        children: [
          {
            type: 'trapezoidfinset', id: 'f1', finCount: 3, rootChord: 0.07, tipChord: 0.04,
            sweep: 0.03, height: 0.04, thickness: 0.003, position: { method: 'bottom', offset: 0 },
          } as ComponentNode,
          {
            type: 'innertube', id: 'm1', length: 0.08, outerRadius: 0.0095, thickness: 0.0005,
            motorMount: true, cluster: '4-ring', position: { method: 'bottom', offset: 0 },
          } as ComponentNode,
          { type: 'parachute', id: 'p1', diameter: 0.45 } as ComponentNode,
        ],
      } as ComponentNode,
    ],
  } as ComponentNode],
});

describe('combination batch flight path (split cluster through the kernel)', () => {
  it('split tree flies; same-motor split matches the original 4-ring; mixed pair differs', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();

    const tree = clusterTree();

    // Original: one 4-ring mount, one motor type ×4.
    const orig = OrkRocket.buildTree(engineTree(tree));
    orig.setMotorById('m1', spec('C6', 4));
    const origRes = orig.simulate({});
    expect(origRes.summary.maxAltitude).toBeGreaterThan(20);

    // Split: two double mounts on the diagonals, SAME motor in both groups —
    // physically the identical rocket, so the flight must agree closely.
    const split = splitClusterTree(tree, 'm1')!;
    expect(split).not.toBeNull();
    const same = OrkRocket.buildTree(engineTree(split.tree));
    same.setMotorById(split.mountIds[0], spec('C6', 4));
    same.setMotorById(split.mountIds[1], spec('C6', 4));
    const sameRes = same.simulate({});
    expect(Math.abs(sameRes.summary.maxAltitude - origRes.summary.maxAltitude)
      / origRes.summary.maxAltitude).toBeLessThan(0.01);

    // Mixed pair: one hotter group — must fly higher than the baseline.
    const mixed = OrkRocket.buildTree(engineTree(split.tree));
    mixed.setMotorById(split.mountIds[0], spec('C6', 4));
    mixed.setMotorById(split.mountIds[1], spec('D9', 8));
    const mixedRes = mixed.simulate({});
    expect(mixedRes.summary.maxAltitude).toBeGreaterThan(origRes.summary.maxAltitude * 1.1);
  }, 30000);
});
