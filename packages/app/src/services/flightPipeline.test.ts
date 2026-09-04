import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
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

  it('drops a mount whose stage has no name rather than keying on undefined', () => {
    const tree: RocketTree = {
      name: 'Nameless',
      components: [({ id: 's0', type: 'stage', children: [mount('m0')] } as unknown as ComponentNode)],
    } as RocketTree;
    expect(stageMotorInfo(tree, [['m0', motor('C6-5', false)]], stages(tree))).toEqual({});
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
