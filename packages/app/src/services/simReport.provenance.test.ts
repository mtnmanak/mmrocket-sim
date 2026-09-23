import { describe, expect, it } from 'vitest';
import type { MountMotor } from '../App.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import {
  changedSinceRun, conditionsKeyOf, designMatchKeyOf, motorSetKeyOf, runMatchesDesign, shortHash,
  type DesignMatchInput, type SimRun,
} from './simReport.js';

/**
 * THE RUN-PROVENANCE KEY, pinned (audit 2026-09-22). It used to be produced in
 * App.tsx and parsed here, and assembled term by term in four places there, so
 * nothing could test it: a changed format would have passed CI while every run
 * in every user's history started reading "the motor changed".
 *
 * The literals below ARE the persisted format. A change that makes one of them
 * fail is a change to what every stored run carries — do it only with a
 * migration, never by updating the literal.
 */

const mm = (over: {
  designation?: string; delay?: number; manufacturer?: string; exMotorId?: string;
  event?: MountMotor['ignition']['event']; igDelay?: number;
} = {}): MountMotor => ({
  label: 'x',
  spec: { designation: over.designation ?? 'C6', ejectionDelay: over.delay ?? 5 },
  meta: {
    label: 'x',
    ...(over.manufacturer !== undefined ? { manufacturer: over.manufacturer } : { manufacturer: 'Estes' }),
    ...(over.exMotorId ? { exMotorId: over.exMotorId } : {}),
  },
  ignition: { event: over.event ?? 'automatic', delay: over.igDelay ?? 0 },
}) as unknown as MountMotor;

describe('motorSetKeyOf — the persisted format', () => {
  it('writes mount:identity:delay:event:ignitionDelay, one entry per mount', () => {
    expect(motorSetKeyOf([['m1', mm()]], 0)).toBe('m1:Estes/C6:5:automatic:0');
  });

  it('sorts the entries, so assignment order never changes the key', () => {
    const booster = mm({ designation: 'D12', delay: 0 });
    const sustainer = mm({ designation: 'C6', delay: 7, event: 'burnout', igDelay: 1 });
    const key = 'b:Estes/D12:0:automatic:0|s:Estes/C6:7:burnout:1';
    expect(motorSetKeyOf([['s', sustainer], ['b', booster]], 0)).toBe(key);
    expect(motorSetKeyOf([['b', booster], ['s', sustainer]], 0)).toBe(key);
  });

  it('keys an EX motor on its library entry, and a plugged motor as Infinity', () => {
    expect(motorSetKeyOf([['m1', mm({ manufacturer: 'EX', exMotorId: 'ex:cti-j350', delay: Infinity })]], 0))
      .toBe('m1:ex:cti-j350:Infinity:automatic:0');
  });

  it('appends the weighed hardware ONLY when there is some, to 0.1 g', () => {
    expect(motorSetKeyOf([['m1', mm()]], 0)).not.toContain('|hw:');
    expect(motorSetKeyOf([['m1', mm()]], 0.01234)).toBe('m1:Estes/C6:5:automatic:0|hw:123');
  });

  it('carries the SPEC delay: an auto-delay pick keys the same as the same motor typed', () => {
    // The optimum is only known after flying, so a key built before a flight
    // cannot contain it; what a run flew is SimRun.delayS.
    const auto = { ...mm({ delay: 7 }), meta: { ...mm().meta, autoDelay: true } } as MountMotor;
    expect(motorSetKeyOf([['m1', auto]], 0)).toBe(motorSetKeyOf([['m1', mm({ delay: 7 })]], 0));
  });
});

const INPUT: DesignMatchInput = {
  physicsKey: '{"stages":[1]}',
  assigned: [['m1', mm()]],
  hardwareDeltaKg: 0,
  launch: DEFAULT_CONDITIONS,
  aeroMode: 'auto',
  effectiveKbf: true,
  autoSupersonic: false,
  hasNozzle: false,
};

describe('changedSinceRun reads the hardware term motorSetKeyOf writes', () => {
  const current = (hw: number, motor = mm()) => designMatchKeyOf({ ...INPUT, assigned: [['m1', motor]], hardwareDeltaKg: hw });
  const stamped = (hw: number, motor = mm()) => {
    const k = current(hw, motor);
    return { designKey: k.designKey, motorSetKey: k.motorSetKey, conditionsKey: k.conditionsKey } as SimRun;
  };

  it('a run flown before the weighing differs only in the pad mass', () => {
    expect(changedSinceRun(stamped(0), current(0.25))).toEqual(['the weighed pad mass']);
  });

  it('a different motor is the motor, whatever the hardware', () => {
    expect(changedSinceRun(stamped(0.25), current(0.25, mm({ designation: 'D12' })))).toEqual(['the motor']);
  });
});

describe('designMatchKeyOf — the ONE assembly', () => {
  it('is every term, each from its own function', () => {
    expect(designMatchKeyOf(INPUT)).toEqual({
      designKey: shortHash(INPUT.physicsKey),
      motorSetKey: 'm1:Estes/C6:5:automatic:0',
      conditionsKey: conditionsKeyOf(DEFAULT_CONDITIONS),
      aeroMode: 'auto',
      effectiveKbf: true,
      autoSupersonic: false,
      hasNozzle: false,
    });
  });

  it('a run stamped from it matches it — the stamp and the comparison cannot drift', () => {
    const key = designMatchKeyOf(INPUT);
    const run = {
      designKey: key.designKey, motorSetKey: key.motorSetKey, conditionsKey: key.conditionsKey,
      aeroModel: 'classic', rogersKbf: true,
    } as SimRun;
    expect(changedSinceRun(run, key)).toEqual([]);
    expect(runMatchesDesign(run, key)).toBe(true);
  });

  it('moves with each of its three stamped terms', () => {
    const run = (() => {
      const k = designMatchKeyOf(INPUT);
      return { designKey: k.designKey, motorSetKey: k.motorSetKey, conditionsKey: k.conditionsKey } as SimRun;
    })();
    expect(changedSinceRun(run, designMatchKeyOf({ ...INPUT, physicsKey: '{"stages":[2]}' })))
      .toEqual(['the design']);
    expect(changedSinceRun(run, designMatchKeyOf({ ...INPUT, assigned: [['m1', mm({ delay: 7 })]] })))
      .toEqual(['the motor']);
    expect(changedSinceRun(run, designMatchKeyOf({ ...INPUT, launch: { ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5 } })))
      .toEqual(['the launch conditions']);
  });
});
