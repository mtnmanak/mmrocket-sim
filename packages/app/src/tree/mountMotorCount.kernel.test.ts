import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import { engineTree, mountMotorCount } from './treeModel.js';

/**
 * EVERY MOTOR COUNT CHECKED AGAINST THE KERNEL THAT FLIES IT (audit
 * 2026-09-22, rows 351/352 — the audit's Step 4: kernel-backed fixtures first).
 *
 * `mountMotorCount` is the ONE app-side answer to "how many motors does this
 * mount fire", and since v0.136 the pad-mass arithmetic, the recovery weight
 * and the nozzle sums all multiply by it. A count that disagrees with the
 * kernel is therefore a mass that disagrees with the flight. So nothing below
 * asserts arithmetic the test wrote down: each count is read back out of the
 * shipped TeaVM kernel as `(loaded mass − empty mass) / one motor's loaded
 * mass`, on a pod-set fixture and a strap-on fixture built the way the app
 * builds them (`engineTree`).
 */

/** A flat 0.1 kg motor: one motor's loaded mass is exactly 0.1 kg. */
const MOTOR = (): MotorSpec => ({
  designation: 'T100',
  diameter: 0.018,
  length: 0.07,
  cgX: 0.035,
  ejectionDelay: 5,
  times: [0, 0.1, 1.0, 1.1],
  thrusts: [0, 20, 20, 0],
  masses: [0.1, 0.095, 0.06, 0.055],
});

/**
 * A core airframe with one assembly on it. `assembly` is spread over the
 * assembly node, so a test can leave `instanceCount` out altogether, or give it
 * a value no app path writes, and see what the KERNEL builds.
 */
const withAssembly = (
  type: 'podset' | 'parallelstage',
  assembly: Record<string, unknown>,
  mount: Partial<ComponentNode> = {},
): RocketTree => ({
  name: type,
  components: [{
    type: 'stage', id: 's1', name: 'Sustainer',
    children: [
      { type: 'nosecone', id: 'n1', length: 0.1, aftRadius: 0.025, thickness: 0.002 } as ComponentNode,
      {
        type: 'bodytube', id: 'b1', length: 0.5, outerRadius: 0.025, thickness: 0.0005, density: 950,
        children: [
          {
            type: 'innertube', id: 'core', length: 0.08, outerRadius: 0.0095, thickness: 0.0005,
            motorMount: true, position: { method: 'bottom', offset: 0 },
          } as ComponentNode,
          {
            type, id: 'asm', name: type === 'podset' ? 'Pods' : 'Strap-ons',
            radiusMethod: 'relative', radiusOffset: 0, angleOffset: 0,
            position: { method: 'bottom', offset: 0 },
            ...(type === 'parallelstage' ? { separationEvent: 'never' } : {}),
            ...assembly,
            children: [
              { type: 'nosecone', id: 'pn', length: 0.05, aftRadius: 0.012, thickness: 0.002 } as ComponentNode,
              {
                type: 'bodytube', id: 'pb', length: 0.25, outerRadius: 0.012, thickness: 0.0005, density: 950,
                children: [{
                  type: 'innertube', id: 'pm', length: 0.08, outerRadius: 0.0095, thickness: 0.0005,
                  motorMount: true, position: { method: 'bottom', offset: 0 }, ...mount,
                } as ComponentNode],
              } as ComponentNode,
            ],
          } as ComponentNode,
        ],
      } as ComponentNode,
    ],
  } as ComponentNode],
});

/** How many motors the kernel carries on `mountId`, read off its own static mass. */
async function kernelCount(tree: RocketTree, mountId: string): Promise<number> {
  const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
  resetEngine();
  const rocket = OrkRocket.buildTree(engineTree(tree));
  rocket.setMotorById(mountId, MOTOR());
  const info = rocket.staticInfo();
  return (info.mass - info.massEmpty) / 0.1;
}

describe('mountMotorCount — what the kernel flies (pod set)', () => {
  const cases: [string, Record<string, unknown>, Partial<ComponentNode>, number][] = [
    ['three pods', { instanceCount: 3 }, {}, 3],
    ['two pods, each a 3-ring cluster', { instanceCount: 2 }, { cluster: '3-ring' }, 6],
    // The kernel's own default, ComponentFactory.applyAssembly's
    // `(int) dbl(node, "instanceCount", 2)` — the Instances field is nullable,
    // so clearing it stores nothing and the kernel still builds two.
    ['instanceCount absent', {}, {}, 2],
    ['instanceCount null (a cleared field)', { instanceCount: null }, {}, 2],
    // `(int)` truncates: 2.7 builds two, where rounding said three.
    ['instanceCount 2.7', { instanceCount: 2.7 }, {}, 2],
    // PodSet.setInstanceCount ignores anything below one, so the constructor's
    // two stands.
    ['instanceCount 0', { instanceCount: 0 }, {}, 2],
    ['instanceCount -3', { instanceCount: -3 }, {}, 2],
    ['one pod', { instanceCount: 1 }, {}, 1],
  ];
  for (const [label, assembly, mount, expected] of cases) {
    it(`${label}: ${expected}`, async () => {
      const tree = withAssembly('podset', assembly, mount);
      expect(await kernelCount(tree, 'pm')).toBeCloseTo(expected, 9);
      expect(mountMotorCount(tree, 'pm')).toBe(expected);
    });
  }

  it('leaves a core mount beside the pods at its own cluster count', async () => {
    const tree = withAssembly('podset', { instanceCount: 3 });
    expect(await kernelCount(tree, 'core')).toBeCloseTo(1, 9);
    expect(mountMotorCount(tree, 'core')).toBe(1);
  });
});

describe('mountMotorCount — what the kernel flies (strap-on booster)', () => {
  const cases: [string, Record<string, unknown>, Partial<ComponentNode>, number][] = [
    ['two strap-ons', { instanceCount: 2 }, {}, 2],
    ['three strap-ons, each a double', { instanceCount: 3 }, { cluster: 'double' }, 6],
    // ParallelStage's constructor sets two as well, and applyAssembly passes
    // the same default for both assembly types.
    ['instanceCount absent', {}, {}, 2],
    ['instanceCount 0', { instanceCount: 0 }, {}, 2],
    ['instanceCount 4.9', { instanceCount: 4.9 }, {}, 4],
  ];
  for (const [label, assembly, mount, expected] of cases) {
    it(`${label}: ${expected}`, async () => {
      const tree = withAssembly('parallelstage', assembly, mount);
      expect(await kernelCount(tree, 'pm')).toBeCloseTo(expected, 9);
      expect(mountMotorCount(tree, 'pm')).toBe(expected);
    });
  }

  it('multiplies a pod set nested inside a strap-on ring', async () => {
    // Two strap-ons, each carrying a two-pod set with a 3-ring in each pod:
    // 2 × 2 × 3 = 12 motors on one mount node.
    const tree = withAssembly('parallelstage', { instanceCount: 2 });
    const strap = tree.components[0]!.children![1]!.children![1]!;
    const podBody = strap.children![1]!;
    const mount = podBody.children!.pop()!;
    podBody.children!.push({
      type: 'podset', id: 'inner', instanceCount: 2, radiusMethod: 'relative', radiusOffset: 0,
      angleOffset: 0, position: { method: 'bottom', offset: 0 },
      children: [{
        type: 'bodytube', id: 'ib', length: 0.1, outerRadius: 0.011, thickness: 0.0005, density: 950,
        children: [{ ...mount, cluster: '3-ring' }],
      } as ComponentNode],
    } as ComponentNode);
    expect(await kernelCount(tree, 'pm')).toBeCloseTo(12, 9);
    expect(mountMotorCount(tree, 'pm')).toBe(12);
  });
});
