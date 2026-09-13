import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import { equivalentExitDiameterM, followNozzle, stageMotorKey, stageMotors } from './nozzleFollow.js';

/**
 * The nozzle exit diameter follows the motor (Eric, 2026-09-13). Three pure
 * pieces: which motors a stage has, what their published exits add up to, and
 * what to do about it. App keeps only the bookkeeping that cannot be pure —
 * remembering the loadout it last saw, so that OPENING A FILE seeds the record
 * and a motor swap fires against it.
 */

const spec = (d: number): MotorSpec => ({
  designation: `M${d}`, diameter: d / 1000, length: 0.3,
  times: [0, 1, 2], thrusts: [0, 100, 0], masses: [0.5, 0.3, 0.2],
  cgX: 0.15, ejectionDelay: 5,
});

const mm = (motorId: string, label = motorId): MountMotor => ({
  label, spec: spec(38), meta: { label, motorId },
  ignition: { event: 'automatic', delay: 0 },
});

/** One stage per entry; each entry lists its mounts as `[mountId, cluster?]`. */
const design = (stagesIn: { id: string; name?: string; mounts: [string, string?][] }[]): RocketTree => ({
  name: 'Test',
  components: stagesIn.map((s) => ({
    type: 'stage', id: s.id, name: s.name ?? s.id,
    children: [{
      type: 'bodytube', id: `${s.id}-bt`, length: 0.5,
      children: s.mounts.map(([mountId, cluster]) => ({
        type: 'innertube', id: mountId, length: 0.2,
        ...(cluster ? { cluster } : {}),
      } as ComponentNode)),
    } as ComponentNode],
  } as ComponentNode)),
});

describe('stageMotors', () => {
  it('lists every stage, including one with no motor at all', () => {
    // A stage that dropped out of the list when its motor was removed would be
    // indistinguishable from one that never changed — and "the motor was
    // removed" is the first of the two reports this module answers.
    const tree = design([{ id: 'sus', mounts: [['m1']] }, { id: 'boost', mounts: [['m2']] }]);
    const out = stageMotors(tree, [['m1', mm('aero-1')]]);
    expect(out.map((s) => s.stageId)).toEqual(['sus', 'boost']);
    expect(out[0]!.motors.map((m) => m.motorId)).toEqual(['aero-1']);
    expect(out[1]!.motors).toEqual([]);
  });

  it('reads the cluster count off the tree, not off the motor record', () => {
    // Nothing in the app writes a count onto a MountMotor; it lives on the
    // mount NODE, which is why `mm()` above deliberately has none.
    const tree = design([{ id: 'sus', mounts: [['m1', '4-ring']] }]);
    const out = stageMotors(tree, [['m1', mm('aero-1')]]);
    expect(out[0]!.motors[0]!.count).toBe(4);
  });

  it('ignores a record whose mount the tree no longer has', () => {
    const tree = design([{ id: 'sus', mounts: [['m1']] }]);
    const out = stageMotors(tree, [['m1', mm('aero-1')], ['gone', mm('aero-2')]]);
    expect(out[0]!.motors.map((m) => m.motorId)).toEqual(['aero-1']);
  });

  it('joins a mount to its own stage, not to the first one', () => {
    const tree = design([{ id: 'sus', mounts: [['m1']] }, { id: 'boost', mounts: [['m2']] }]);
    const out = stageMotors(tree, [['m2', mm('aero-2')]]);
    expect(out[0]!.motors).toEqual([]);
    expect(out[1]!.motors.map((m) => m.motorId)).toEqual(['aero-2']);
  });
});

describe('stageMotorKey', () => {
  const tree = design([{ id: 'sus', mounts: [['m1']] }]);
  const clustered = design([{ id: 'sus', mounts: [['m1', '4-ring']] }]);

  it('is stable while nothing changes', () => {
    const a = stageMotorKey(stageMotors(tree, [['m1', mm('aero-1')]])[0]!);
    const b = stageMotorKey(stageMotors(tree, [['m1', mm('aero-1')]])[0]!);
    expect(a).toBe(b);
  });

  it('changes when the motor changes', () => {
    const a = stageMotorKey(stageMotors(tree, [['m1', mm('aero-1')]])[0]!);
    const b = stageMotorKey(stageMotors(tree, [['m1', mm('aero-2')]])[0]!);
    expect(a).not.toBe(b);
  });

  it('changes when the motor is removed', () => {
    const a = stageMotorKey(stageMotors(tree, [['m1', mm('aero-1')]])[0]!);
    const b = stageMotorKey(stageMotors(tree, [])[0]!);
    expect(a).not.toBe(b);
    expect(b).toBe('');
  });

  it('changes when the SAME motor becomes a cluster', () => {
    // The count is in the key because it moves the number: four motors is
    // twice the equivalent exit diameter of one. A key built from ids alone
    // would leave a four-motor cluster flying one motor's nozzle.
    const one = stageMotorKey(stageMotors(tree, [['m1', mm('aero-1')]])[0]!);
    const four = stageMotorKey(stageMotors(clustered, [['m1', mm('aero-1')]])[0]!);
    expect(one).not.toBe(four);
  });

  it('does not change when only the label does', () => {
    const a = stageMotorKey(stageMotors(tree, [['m1', mm('aero-1', 'D13-10')]])[0]!);
    const b = stageMotorKey(stageMotors(tree, [['m1', mm('aero-1', 'D13-7')]])[0]!);
    expect(a).toBe(b);
  });
});

describe('equivalentExitDiameterM', () => {
  it('is the motor’s own exit when the stage has one motor', () => {
    expect(equivalentExitDiameterM([{ count: 1, exitDiameterM: 0.02 }])).toBeCloseTo(0.02, 12);
  });

  it('sums AREAS: four identical motors is twice the diameter, not four times', () => {
    // The v0.122 auto-fill wrote one motor's diameter in whatever the count,
    // so a four-motor cluster collected a QUARTER of the exit area it has —
    // and since v0.119 the exit area is thrust, not just base drag.
    expect(equivalentExitDiameterM([{ count: 4, exitDiameterM: 0.02 }])).toBeCloseTo(0.04, 12);
    expect(equivalentExitDiameterM([{ count: 2, exitDiameterM: 0.02 }]))
      .toBeCloseTo(0.02 * Math.SQRT2, 12);
  });

  it('sums across mounts as well as within a cluster', () => {
    const out = equivalentExitDiameterM([
      { count: 1, exitDiameterM: 0.03 },
      { count: 2, exitDiameterM: 0.02 },
    ]);
    expect(out).toBeCloseTo(Math.sqrt(0.03 ** 2 + 2 * 0.02 ** 2), 12);
  });

  it('is null when the stage has no motors', () => {
    expect(equivalentExitDiameterM([])).toBeNull();
  });

  it('is null when ANY motor in the stage has no published figure', () => {
    // Not "the sum of what we know": that number is short by exactly the
    // motors it could not see, and it would look like a filled-in answer.
    expect(equivalentExitDiameterM([
      { count: 1, exitDiameterM: 0.03 },
      { count: 1, exitDiameterM: null },
    ])).toBeNull();
  });

  it('is null rather than NaN on a nonsense figure', () => {
    expect(equivalentExitDiameterM([{ count: 1, exitDiameterM: 0 }])).toBeNull();
    expect(equivalentExitDiameterM([{ count: 1, exitDiameterM: -0.02 }])).toBeNull();
    expect(equivalentExitDiameterM([{ count: 1, exitDiameterM: Number.NaN }])).toBeNull();
    expect(equivalentExitDiameterM([{ count: 0, exitDiameterM: 0.02 }])).toBeNull();
  });
});

describe('followNozzle', () => {
  const base = { hadMotorsBefore: true, previousLabel: 'K1127', currentValueM: 0.02286, publishedM: null as number | null };

  it('replaces a stale value with the new motor’s published figure', () => {
    expect(followNozzle({ ...base, publishedM: 0.0254 }))
      .toEqual({ kind: 'set', exitDiameterM: 0.0254 });
  });

  it('fills an empty field when the new motor publishes one', () => {
    expect(followNozzle({ ...base, currentValueM: null, publishedM: 0.0254 }))
      .toEqual({ kind: 'set', exitDiameterM: 0.0254 });
  });

  it('writes nothing when the value already IS the published figure', () => {
    // Down to the display's own 0.05 mm slop, so a unit round-trip through the
    // box does not churn the design (and the undo-free write with it).
    expect(followNozzle({ ...base, currentValueM: 0.0254, publishedM: 0.0254 })).toEqual({ kind: 'none' });
    expect(followNozzle({ ...base, currentValueM: 0.02542, publishedM: 0.0254 })).toEqual({ kind: 'none' });
    expect(followNozzle({ ...base, currentValueM: 0.0256, publishedM: 0.0254 }).kind).toBe('set');
  });

  it('clears a value the new motor has no figure for, and says what it was', () => {
    expect(followNozzle(base))
      .toEqual({ kind: 'clear', previousLabel: 'K1127', previousM: 0.02286 });
  });

  it('clears when the motor was taken out altogether', () => {
    // Eric's first report: "there is no motor loaded, how can there be an exit
    // diameter?" No motors now means no published figure, so it is the same
    // branch — and the notice still names what the number belonged to.
    expect(followNozzle({ ...base, publishedM: null }).kind).toBe('clear');
  });

  it('has nothing to clear when the field was already empty', () => {
    expect(followNozzle({ ...base, currentValueM: null })).toEqual({ kind: 'none' });
  });

  it('LEAVES A VALUE ALONE when the stage had no previous motor', () => {
    // The case this function exists to get right, and the one that is invisible
    // in a render. A RASAero file can carry a nozzle and no resolvable motor;
    // so can a design where the number was typed before a motor was chosen.
    // That value was never the previous motor's — there was none — so it is the
    // user's own data and the follow-the-motor rule does not apply to it. The
    // panel still shows the disagreement and still offers the one-click accept.
    expect(followNozzle({ ...base, hadMotorsBefore: false, publishedM: 0.0254 }))
      .toEqual({ kind: 'none' });
    expect(followNozzle({ ...base, hadMotorsBefore: false, publishedM: null }))
      .toEqual({ kind: 'none' });
  });

  it('names something rather than nothing when the previous label is missing', () => {
    const out = followNozzle({ ...base, previousLabel: '' });
    expect(out).toEqual({ kind: 'clear', previousLabel: 'the previous motor', previousM: 0.02286 });
  });
});
