import { describe, expect, it } from 'vitest';
import { flightDataForExport, summaryOf, type FlightDataForExportInput } from './orkFlightData.js';
import type { SimRun } from './simReport.js';
import type { MountMotor, SavedConfig } from '../App.js';

/**
 * SIX INDEPENDENT REFUSAL RULES, none of which had a test until this function
 * left App.tsx (docs/AUDIT.md, 2026-09-08). Every one of them guards the same
 * thing: desktop OpenRocket renders a `<flightdata>` block indistinguishably
 * from a result it computed itself, so a stale number written there is
 * authoritative-looking and wrong, with nothing on screen to say so. An ABSENT
 * number is honest; a stale one is not.
 *
 * Table-driven from one qualifying baseline, so each case says exactly which
 * rule it is about — change one field, lose the run.
 */

const MOTOR: MountMotor = {
  label: 'H128-M',
  spec: { designation: 'H128W', diameter: 0.029, length: 0.194, ejectionDelay: 7 },
  meta: { label: 'H128-M' },
  ignition: { event: 'automatic', delay: 0 },
} as unknown as MountMotor;

const RUN: SimRun = {
  id: 'r1',
  flightConfigId: 'c1',
  designKey: 'design-A',
  conditionsKey: 'cond-A',
  motorSetKey: 'set-A',
  delayS: 7,
  aeroModel: 'supersonic',
  rogersKbf: true,
  nozzleStamp: 'v119',
  maxAltitude: 1234.5,
  maxVelocity: 210.1,
  maxAcceleration: 190.2,
  maxMach: 0.62,
  timeToApogee: 15.9,
  totalFlightTime: 88.4,
  groundHitVelocity: 5.6,
  rodExitVelocity: 19.3,
  velocityAtDeployment: 12.1,
  optimumDelayS: 7,
} as unknown as SimRun;

const CONFIG: SavedConfig = {
  id: 'c1', name: 'Main', isDefault: true, motors: { m1: MOTOR },
} as unknown as SavedConfig;

const base = (over: Partial<FlightDataForExportInput> = {}): FlightDataForExportInput => ({
  runs: [RUN],
  savedConfigs: [CONFIG],
  activeConfigId: 'c1',
  assigned: [['m1', MOTOR]],
  mountIds: ['m1'],
  designKey: 'design-A',
  conditionsKey: 'cond-A',
  model: { aeroMode: 'supersonic', effectiveKbf: true, autoSupersonic: false },
  hasNozzle: false,
  motorSetKeyOf: () => 'set-A',
  hardwareDeltaKg: 0,
  primaryMountOf: (mountIds) => mountIds[0] ?? null,
  ...over,
});

const ids = (over: Partial<FlightDataForExportInput> = {}) =>
  Object.keys(flightDataForExport(base(over)));

describe('flightDataForExport — the baseline qualifies', () => {
  it('writes the run for a configuration whose design, conditions, model and motors all match', () => {
    expect(ids()).toEqual(['c1']);
  });

  it('writes the ten values desktop OpenRocket stores, in its units', () => {
    const out = flightDataForExport(base());
    expect(out['c1']).toEqual({
      maxAltitude: 1234.5,
      maxVelocity: 210.1,
      maxAcceleration: 190.2,
      maxMach: 0.62,
      timeToApogee: 15.9,
      flightTime: 88.4,
      groundHitVelocity: 5.6,
      launchRodVelocity: 19.3,
      deploymentVelocity: 12.1,
      optimumDelay: 7,
    });
    // The ONE mapping — `summaryOf` sat unreferenced in App.tsx while this
    // function built the identical literal inline, so a units or field-name fix
    // made in the obvious place changed nothing in the file that came out.
    expect(out['c1']).toEqual(summaryOf(RUN));
  });
});

describe('flightDataForExport — each refusal, one at a time', () => {
  it('refuses a run whose DESIGN has changed since it flew', () => {
    expect(ids({ designKey: 'design-B' })).toEqual([]);
  });

  it('refuses a run whose launch CONDITIONS have changed', () => {
    expect(ids({ conditionsKey: 'cond-B' })).toEqual([]);
  });

  it('refuses a run flown on a DIFFERENT aero model', () => {
    expect(ids({ model: { aeroMode: 'classic', effectiveKbf: false, autoSupersonic: false } }))
      .toEqual([]);
  });

  it('refuses a run whose model is UNKNOWN, not just different', () => {
    // A run predating the field. `runMatchesModel` returns null, and null is a
    // refusal here — "I cannot tell" must never be written as "it matches".
    const old = { ...RUN, aeroModel: undefined } as unknown as SimRun;
    expect(ids({ runs: [old] })).toEqual([]);
  });

  it('refuses a run with no pressure-thrust stamp on a nozzle-bearing design', () => {
    // The v0.119 kernel change. None of the design/conditions/model keys can
    // see a KERNEL change, so without this a pre-v0.119 run of a design that
    // carries a nozzle would be written as that configuration's current result.
    const unstamped = { ...RUN, nozzleStamp: undefined } as unknown as SimRun;
    expect(ids({ runs: [unstamped], hasNozzle: true })).toEqual([]);
    // ...and is fine when the design has no nozzle for the term to apply to.
    expect(ids({ runs: [unstamped], hasNozzle: false })).toEqual(['c1']);
  });

  it('refuses a run whose MOTOR SET no longer matches', () => {
    expect(ids({ motorSetKeyOf: () => 'set-B' })).toEqual([]);
  });

  it('refuses a run whose configuration no longer exists', () => {
    expect(ids({ savedConfigs: [] })).toEqual([]);
  });

  it('refuses a run with no configuration id at all', () => {
    const loose = { ...RUN, flightConfigId: undefined } as unknown as SimRun;
    expect(ids({ runs: [loose] })).toEqual([]);
  });
});

describe('flightDataForExport — the rules that are about OTHER configurations', () => {
  const OTHER: SavedConfig = {
    id: 'c2', name: 'Booster test', isDefault: false, motors: { m1: MOTOR },
  } as unknown as SavedConfig;
  const RUN2 = { ...RUN, id: 'r2', flightConfigId: 'c2' } as SimRun;

  it('exports a NON-active configuration’s stored result too', () => {
    // The user has since switched configurations; the others' results are still
    // theirs to save.
    expect(ids({
      runs: [RUN, RUN2], savedConfigs: [CONFIG, OTHER], activeConfigId: 'c1',
    }).sort()).toEqual(['c1', 'c2']);
  });

  it('charges the hardware term ONLY to the active configuration', () => {
    // A non-active configuration's run keeps matching only if it flew with no
    // hardware — refusal is the safe direction for numbers written into a file.
    const keyOf = (_m: [string, MountMotor][], hw: number) => (hw === 0 ? 'set-A' : 'set-hw');
    expect(ids({
      runs: [RUN, RUN2], savedConfigs: [CONFIG, OTHER], activeConfigId: 'c1',
      motorSetKeyOf: keyOf, hardwareDeltaKg: 0.25,
    })).toEqual(['c2']);
  });

  it('ignores a configuration motor whose mount no longer exists', () => {
    // configSync writes the working set verbatim, so a stored config can hold a
    // stale mount id the run's own key never had. Filtering by the live mounts
    // keeps that from costing the configuration its result.
    const stale = {
      ...OTHER, motors: { m1: MOTOR, gone: MOTOR },
    } as unknown as SavedConfig;
    const keyOf = (m: [string, MountMotor][]) => (m.length === 1 ? 'set-A' : 'set-stale');
    expect(ids({
      runs: [RUN2], savedConfigs: [stale], activeConfigId: 'c1',
      mountIds: ['m1'], motorSetKeyOf: keyOf,
    })).toEqual(['c2']);
  });

  it('takes the NEWEST qualifying run per configuration and ignores older ones', () => {
    const newer = { ...RUN, id: 'r0', maxAltitude: 999 } as SimRun;
    const out = flightDataForExport(base({ runs: [newer, RUN] }));
    expect(Object.keys(out)).toEqual(['c1']);
    expect(out['c1']!.maxAltitude).toBe(999);
  });
});

/**
 * THE DELAY A RUN FLEW (audit 2026-09-22). The motor-set key carries each
 * motor's SPEC delay — the one the file's `<delay>` names — never an auto-delay
 * optimum, which is only known after flying. So an auto-delay run matched its
 * configuration, and its flight went into the file under a delay it never
 * flew. Measured on the starter rocket with an Estes C6 whose spec says 3 s:
 * auto flew 5 s, and the file said the chute opened at 3.81 m/s where the 3 s
 * motor it names deploys at 16.81 m/s.
 */
describe('flightDataForExport — the flown delay must be the one the file names', () => {
  const withDelay = (delay: number): MountMotor =>
    ({ ...MOTOR, spec: { ...MOTOR.spec, ejectionDelay: delay } }) as MountMotor;

  it('refuses an auto-delay run that flew a delay other than its configuration’s', () => {
    // RUN flew 7 s; the configuration's motor now says 3 s, with the same key.
    expect(ids({ assigned: [['m1', withDelay(3)]] })).toEqual([]);
  });

  it('writes an auto-delay run whose optimum rounded to the configuration’s own delay', () => {
    // It flew exactly what the file will say — nothing to refuse.
    const auto = { ...MOTOR, meta: { ...MOTOR.meta, autoDelay: true } } as MountMotor;
    expect(ids({ assigned: [['m1', auto]] })).toEqual(['c1']);
  });

  it('reads the delay off the configuration’s PRIMARY, not its first mount', () => {
    // `delayS` is the primary's: auto delay writes no other mount.
    const booster = withDelay(0);
    const staged = (primary: string) => ids({
      assigned: [['b', booster], ['m1', MOTOR]], mountIds: ['b', 'm1'],
      primaryMountOf: () => primary,
    });
    expect(staged('m1')).toEqual(['c1']);
    expect(staged('b')).toEqual([]);
  });

  it('reads a NON-active configuration against its own motors', () => {
    const other = {
      id: 'c2', name: 'Longer delay', isDefault: false, motors: { m1: withDelay(10) },
    } as unknown as SavedConfig;
    const run2 = { ...RUN, id: 'r2', flightConfigId: 'c2' } as SimRun;
    expect(ids({ runs: [run2], savedConfigs: [CONFIG, other] })).toEqual([]);
    expect(ids({ runs: [{ ...run2, delayS: 10 } as SimRun], savedConfigs: [CONFIG, other] })).toEqual(['c2']);
  });

  it('refuses when the configuration has no primary to read the delay against', () => {
    expect(ids({ primaryMountOf: () => null })).toEqual([]);
  });

  it('writes a plugged motor’s run — Infinity is the delay it flew and the one the file names', () => {
    const plugged = withDelay(Infinity);
    expect(ids({ runs: [{ ...RUN, delayS: Infinity } as SimRun], assigned: [['m1', plugged]] })).toEqual(['c1']);
  });
});
