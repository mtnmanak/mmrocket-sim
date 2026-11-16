// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { BATCH_MY_MOTORS_KEY, batchMyCandidates, loadBatchMyMotors, saveBatchMyMotors } from './batchMyMotors.js';
import { MOTOR_DB } from './motorDb.js';
import { IMPERIAL_UNITS, INITIAL_UNITS } from '../prefs/units.js';
import * as unitsModule from '../prefs/units.js';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it('r2-7 deduplicates stored motor ids before they become candidates', () => {
  const motor = MOTOR_DB[0]!;
  localStorage.setItem(BATCH_MY_MOTORS_KEY, JSON.stringify([motor.motorId, motor.motorId, 'ex:owned', 'ex:owned']));
  expect(loadBatchMyMotors()).toEqual([motor.motorId, 'ex:owned']);
  const targets = [{ id: 'a', label: 'Target', diameterMm: motor.diameter, motorCount: 1, maxMotorLengthM: null }];
  expect(batchMyCandidates(loadBatchMyMotors(), [motor], targets, INITIAL_UNITS).candidates).toHaveLength(1);
});

it('r2-4 distinguishes colliding display designations in exclusion notes', () => {
  const motors = ['123E999-9A', '234E999-9A'].map((designation, i) => ({ ...MOTOR_DB[0]!,
    motorId: `collision-${i}`, manufacturerAbbrev: 'Cesaroni', designation, diameter: 24, length: 150 }));
  const targets = [{ id: 'a', label: 'Target', diameterMm: 24, motorCount: 1, maxMotorLengthM: 0.1 }];
  const { excluded } = batchMyCandidates(motors.map(m => m.motorId), motors, targets, INITIAL_UNITS);
  motors.forEach((m, i) => expect(excluded[i]).toContain(`Cesaroni ${m.designation}: too long`));
});

it('r2-5 names a near-boundary maximum as just below the motor length', () => {
  const motor = { ...MOTOR_DB[0]!, length: 100 + 2e-6, diameter: 24 };
  const targets = [{ id: 'a', label: 'Target', diameterMm: 24, motorCount: 1, maxMotorLengthM: 0.1 }];
  for (const units of [INITIAL_UNITS, IMPERIAL_UNITS]) {
    expect(batchMyCandidates([motor.motorId], [motor], targets, units).excluded[0]).toContain('(max just below ');
  }
});

it('r2-5 formats the excluded bore against the motor diameter', () => {
  const format = vi.spyOn(unitsModule, 'noticeQuantity');
  const motor = { ...MOTOR_DB[0]!, diameter: 38 };
  const targets = [{ id: 'a', label: 'Target', diameterMm: 24, motorCount: 1, maxMotorLengthM: null }];
  for (const units of [INITIAL_UNITS, IMPERIAL_UNITS]) {
    expect(batchMyCandidates([motor.motorId], [motor], targets, units).excluded[0]).toContain('too wide');
    expect(format).toHaveBeenLastCalledWith('motorDimensions', 0.024, units, { against: 0.038 });
  }
});

it('138 persists catalogue and EX ids and treats corrupt storage as empty', () => {
  const ids = [MOTOR_DB[0]!.motorId, 'ex:owned'];
  saveBatchMyMotors(ids);
  expect(loadBatchMyMotors()).toEqual(ids);
  for (const value of ['{', '{}', '[1]', 'null']) {
    localStorage.setItem(BATCH_MY_MOTORS_KEY, value);
    expect(loadBatchMyMotors()).toEqual([]);
  }
});

it('138 names width, length and unavailable exclusions and keeps OOP/EX without catalogue filters', () => {
  const base = MOTOR_DB[0]!;
  const motors = [
    { ...base, motorId: 'wide', designation: 'Too\u202ewide', diameter: 38, length: 50 },
    { ...base, motorId: 'long', designation: 'Too long', diameter: 18, length: 150 },
    { ...base, motorId: 'ex:owned', designation: 'Owned', diameter: 18, length: 50, availability: 'OOP' },
  ];
  const targets = [{ id: 'a', label: 'Wide target', diameterMm: 38, motorCount: 1, maxMotorLengthM: null },
    { id: 'b', label: 'Small target', diameterMm: 24, motorCount: 1, maxMotorLengthM: 0.1 }];
  const result = batchMyCandidates([...motors.map(m => m.motorId), 'missing\u202eid'], motors, targets, INITIAL_UNITS);
  expect(result.candidates.map(m => m.motorId)).toEqual(['ex:owned']);
  expect(result.excluded[0]).toContain('Too[U+202E]wide: too wide for Small target');
  expect(result.excluded[1]).toContain('Too long: too long for Small target (max');
  expect(result.excluded[2]).toContain('missing[U+202E]id: unavailable');
  const imperial = batchMyCandidates(['wide', 'long'], motors, targets, IMPERIAL_UNITS);
  expect(imperial.excluded[0]).toContain('in');
  expect(imperial.excluded[1]).toContain('in');
  const boundary = [{ ...motors[1]!, length: 100 + 5e-7 }];
  expect(batchMyCandidates(['long'], boundary, targets, INITIAL_UNITS).candidates).toHaveLength(1);
  boundary[0]!.length = 100 + 2e-6;
  expect(batchMyCandidates(['long'], boundary, targets, INITIAL_UNITS).excluded[0]).toContain('too long');
});
