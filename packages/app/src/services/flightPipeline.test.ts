import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { stages } from '../tree/treeModel.js';
import { aeroModelFor, rogersKbfFor, stageMotorInfo } from './flightPipeline.js';

const spec: MotorSpec = {
  designation: 'H220', diameter: 0.029, length: 0.194,
  times: [0, 1], thrusts: [0, 0], masses: [0.2, 0.1], cgX: 0.09, ejectionDelay: 6,
};

const motor = (label: string, highPower: boolean): MountMotor => ({
  label,
  spec: { ...spec, designation: label },
  meta: { label, highPower },
  ignition: { event: 'automatic', delay: 0 },
});

const mount = (id: string): ComponentNode =>
  ({ id, type: 'innertube', name: 'Motor mount', children: [] } as unknown as ComponentNode);

const stage = (id: string, name: string, children: ComponentNode[]): ComponentNode =>
  ({ id, type: 'stage', name, children } as unknown as ComponentNode);

describe('stageMotorInfo', () => {
  it('retains serial-stage motor facts when the flight tree clones the listed stages', () => {
    const tree: RocketTree = { components: [
      stage('s0', 'Sustainer', [mount('m0')]),
      stage('s1', 'Booster', [mount('m1')]),
    ] };
    const stageList = stages(tree);
    const flightTree = structuredClone(tree);
    expect(stageMotorInfo(flightTree, [
      ['m0', motor('J90W', true)], ['m1', motor('I170G-0', true)],
    ], stageList)).toEqual({
      Sustainer: { label: 'J90W', highPower: true },
      Booster: { label: 'I170G-0', highPower: true },
    });
  });

  it.each([
    ['H128-0', { label: 'H128-0', highPower: true }],
    ['I600-0', { highPower: true }],
  ])('keeps agreed facts on same-name high-power strap-ons with %s', (secondLabel, expected) => {
    const tree: RocketTree = { components: [stage('s', 'Sustainer', [
      { type: 'parallelstage', id: 'p1', name: 'Strap-on booster', children: [mount('m1')] },
      { type: 'parallelstage', id: 'p2', name: 'Strap-on booster', children: [mount('m2')] },
    ])] };
    expect(stageMotorInfo(tree, [['m1', motor('H128-0', true)], ['m2', motor(secondLabel, true)]], stages(tree)))
      .toEqual({ 'Strap-on booster': expected });
  });
  it.each([true, false])('keeps the high-power safety flag with a low-power namesake assigned: %s', assignedNamesake => {
    const tree: RocketTree = { components: [
      stage('s0', 'Sustainer', [mount('m0')]),
      stage('s1', 'Booster', [mount('m1')]),
      stage('s2', 'Booster', [mount('m2')]),
    ] };
    const assigned: [string, MountMotor][] = [['m1', motor('H128', true)]];
    if (assignedNamesake) assigned.push(['m2', motor('D12', false)]);
    // Even a motorless namesake makes the label ambiguous, but not safety.
    for (const order of [assigned, [...assigned].reverse()]) {
      expect(stageMotorInfo(tree, order, stages(tree))).toEqual({ Booster: { highPower: true } });
    }
    expect(stageMotorInfo(tree, [['m1', motor('D12', false)], ['m2', motor('C6', false)]], stages(tree)))
      .toEqual({ Booster: { highPower: false } });
    expect(stageMotorInfo(tree, [['m1', motor('D12', false)]], stages(tree))).toEqual({});
  });
  it('keeps namesake attribution conservative across a projected serial tree and strap-on', () => {
    const tree: RocketTree = { components: [
      stage('s0', 'Sustainer', [{ type: 'parallelstage', id: 'p0', name: 'Booster', children: [mount('m0')] }]),
      stage('s1', 'Booster', [mount('m1')]),
    ] };
    const flightTree = structuredClone(tree);
    expect(stageMotorInfo(flightTree, [
      ['m0', motor('H128-0', true)], ['m1', motor('I170G-0', true)],
    ], stages(tree))).toEqual({ Booster: { highPower: true } });
    expect(stageMotorInfo(flightTree, [
      ['m0', motor('H128-0', true)], ['m1', motor('D12-0', false)],
    ], stages(tree))).toEqual({ Booster: { highPower: true } });
    expect(stageMotorInfo(flightTree, [['m0', motor('H128-0', true)]], stages(tree)))
      .toEqual({ Booster: { highPower: true } });
  });
  it('names a branch after the serial stage its mount lives in', () => {
    const tree: RocketTree = {
      name: 'Two-stage',
      components: [
        stage('s0', 'Sustainer', [mount('m0')]),
        stage('s1', 'Booster', [mount('m1')]),
      ],
    } as RocketTree;
    const assigned: [string, MountMotor][] = [
      ['m0', motor('H220-6', true)],
      ['m1', motor('I600R-0', true)],
    ];
    expect(stageMotorInfo(tree, assigned, stages(tree))).toEqual({
      Sustainer: { label: 'H220-6', highPower: true },
      Booster: { label: 'I600R-0', highPower: true },
    });
  });

  /**
   * A strap-on booster's mount lives INSIDE the sustainer stage, under a
   * parallelstage node. Keyed by stage name it would overwrite the sustainer's
   * own entry, so the sustainer's motor would vanish from the safety check and
   * the strap-on's chuteless-booster warning would be attributed to the
   * airframe carrying it.
   */
  it('names a parallel-stage branch after the parallelstage node, not its host', () => {
    const tree: RocketTree = {
      name: 'Strap-on',
      components: [
        stage('s0', 'Sustainer', [
          mount('m0'),
          ({
            id: 'p0', type: 'parallelstage', name: 'Strap-on booster',
            children: [mount('m1')],
          } as unknown as ComponentNode),
        ]),
      ],
    } as RocketTree;
    const assigned: [string, MountMotor][] = [
      ['m0', motor('J350-P', true)],
      ['m1', motor('H128-0', true)],
    ];
    expect(stageMotorInfo(tree, assigned, stages(tree))).toEqual({
      Sustainer: { label: 'J350-P', highPower: true },
      'Strap-on booster': { label: 'H128-0', highPower: true },
    });
  });

  it('reports highPower false rather than undefined when the meta does not say', () => {
    const tree: RocketTree = {
      name: 'One', components: [stage('s0', 'Sustainer', [mount('m0')])],
    } as RocketTree;
    const mm: MountMotor = {
      label: 'C6-5', spec, meta: { label: 'C6-5' }, ignition: { event: 'automatic', delay: 0 },
    };
    expect(stageMotorInfo(tree, [['m0', mm]], stages(tree)))
      .toEqual({ Sustainer: { label: 'C6-5', highPower: false } });
  });

  /**
   * Two mounts on ONE branch — a cluster split into individual tubes, which is
   * how a design gives each motor its own ignition. Until 2026-09-21 the entry
   * was overwritten per mount, so the LAST motor assigned decided whether the
   * branch counted as high power, and `assigned` is in assignment order rather
   * than any order the user controls. The property is order-independence, so
   * both orders are asserted; the third case stops the OR being written true.
   */
  const twoMountBranch = (): RocketTree => ({
    name: 'Split cluster',
    components: [
      stage('s0', 'Sustainer', [mount('m0')]),
      stage('s1', 'Booster', [mount('m1'), mount('m2')]),
    ],
  } as RocketTree);

  it('keeps a branch high power when ANY of its motors is', () => {
    const tree = twoMountBranch();
    const assigned: [string, MountMotor][] = [
      ['m0', motor('J350-P', true)],
      ['m1', motor('H128-0', true)],
      ['m2', motor('D12-0', false)],
    ];
    expect(stageMotorInfo(tree, assigned, stages(tree)).Booster)
      .toEqual({ label: 'H128-0 + D12-0', highPower: true });
  });

  it('is independent of the order the motors were assigned in', () => {
    const tree = twoMountBranch();
    const assigned: [string, MountMotor][] = [
      ['m0', motor('J350-P', true)],
      ['m2', motor('D12-0', false)],
      ['m1', motor('H128-0', true)],
    ];
    expect(stageMotorInfo(tree, assigned, stages(tree)).Booster)
      .toEqual({ label: 'D12-0 + H128-0', highPower: true });
  });

  it('leaves a branch low power when none of its motors is high power', () => {
    const tree = twoMountBranch();
    const assigned: [string, MountMotor][] = [
      ['m1', motor('D12-0', false)],
      ['m2', motor('C11-0', false)],
    ];
    expect(stageMotorInfo(tree, assigned, stages(tree)).Booster)
      .toEqual({ label: 'D12-0 + C11-0', highPower: false });
  });

  it('drops a mount whose stage has no name rather than keying on undefined', () => {
    const tree: RocketTree = {
      name: 'Nameless',
      components: [({ id: 's0', type: 'stage', children: [mount('m0')] } as unknown as ComponentNode)],
    } as RocketTree;
    expect(stageMotorInfo(tree, [['m0', motor('C6-5', false)]], stages(tree))).toEqual({});
  });

  it('keys a stage whose name is also a prototype key like any other', () => {
    // Audit 2026-09-22: on a plain object `out['constructor']` was Object
    // itself, taken for an earlier entry, and the branch was labelled
    // "undefined + H220-6" with its high-power flag lost.
    const tree: RocketTree = {
      name: 'Proto', components: [stage('s0', 'constructor', [mount('m0')])],
    } as RocketTree;
    const info = stageMotorInfo(tree, [['m0', motor('H220-6', true)]], stages(tree));
    expect(info['constructor']).toEqual({ label: 'H220-6', highPower: true });
  });
});

describe('aeroModelFor — the stamp that is permanent on a stored run', () => {
  it('tells an Auto upgrade apart from a chosen supersonic flight', () => {
    expect(aeroModelFor('auto', true)).toBe('auto-supersonic');
    expect(aeroModelFor('supersonic', true)).toBe('supersonic');
  });

  it('records classic whenever the flight did not use the supersonic model', () => {
    expect(aeroModelFor('classic', false)).toBe('classic');
    expect(aeroModelFor('auto', false)).toBe('classic');
    // The mode SELECTED is not the model FLOWN: a design set to 'supersonic'
    // that somehow flew classic must not be labelled supersonic, or the
    // "flown on a different model" comparison silently compares a lie.
    expect(aeroModelFor('supersonic', false)).toBe('classic');
  });
});

describe('rogersKbfFor', () => {
  it('records Kbf only on a classic flight — supersonic supersedes it', () => {
    expect(rogersKbfFor(true, false)).toBe(true);
    expect(rogersKbfFor(true, true)).toBe(false);
    expect(rogersKbfFor(false, false)).toBe(false);
    expect(rogersKbfFor(false, true)).toBe(false);
  });
});


it('records Hybrid as its own model even if a caller carries a stale Supersonic bit', () => {
  expect(aeroModelFor('hybrid', false)).toBe('hybrid');
  expect(aeroModelFor('hybrid', true)).toBe('hybrid');
});
