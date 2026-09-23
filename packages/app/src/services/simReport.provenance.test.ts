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

  it('writes every event the kernel knows exactly as stored — no stored run moves', () => {
    for (const event of ['automatic', 'launch', 'ejectioncharge', 'burnout', 'never'] as const) {
      expect(motorSetKeyOf([['m1', mm({ event, igDelay: 1 })]], 0)).toBe(`m1:Estes/C6:5:${event}:1`);
    }
    // A spelling the kernel normalises flies the same event, and keeps its key too.
    expect(motorSetKeyOf([['m1', mm({ event: 'EJECTION_CHARGE' as never })]], 0))
      .toBe('m1:Estes/C6:5:EJECTION_CHARGE:0');
  });

  /**
   * An event the kernel does not know is REFUSED at the write since the
   * 22 September audit (flightRunner.writeMountMotor): the motor stays off the
   * handle. Hashed raw, a run stored before that — flown WITH the motor, on
   * AUTOMATIC, 240.34 m on the seam review's two-mount design — kept matching,
   * and Show charts re-flew it at 122.06 m without the motor, under the stored
   * run's name (seam review of audit 2026-09-22).
   */
  it('spells an event the kernel refuses differently, so a run flown before the refusal stops matching', () => {
    const side = mm({ event: 'bogus' as never });
    const set: [string, MountMotor][] = [['mount', mm()], ['side', side]];
    const key = motorSetKeyOf(set, 0);
    expect(key).toBe('mount:Estes/C6:5:automatic:0|side:Estes/C6:5:refused:bogus:0');
    // The v0.137 stamp of the same set.
    const stored = { ...INPUT_RUN, motorSetKey: 'mount:Estes/C6:5:automatic:0|side:Estes/C6:5:bogus:0' } as SimRun;
    const cur = designMatchKeyOf({ ...INPUT, assigned: set });
    expect(runMatchesDesign(stored, cur)).toBe(false);
    expect(changedSinceRun(stored, cur)).toEqual(['the motor']);
    // A run flown NOW, without the refused motor, still matches itself.
    expect(runMatchesDesign({ ...stored, motorSetKey: key } as SimRun, cur)).toBe(true);
  });
});

/**
 * What a run stamped by v0.137 carries for INPUT (below), spelled out — the
 * keys a stored run already holds are literals, never recomputed.
 */
const DEFAULT_CONDITIONS_KEY =
  'latitudeDeg=28.61|launchAltitudeM=0|launchRodAngleDeg=0|launchRodLengthM=1|pressureHPa=|temperatureC=|windAverage=0|windStdDev=0';
const INPUT_RUN = {
  designKey: shortHash('{"stages":[1]}'),
  motorSetKey: 'm1:Estes/C6:5:automatic:0',
  conditionsKey: DEFAULT_CONDITIONS_KEY,
  aeroModel: 'classic',
  rogersKbf: true,
} as SimRun;

/**
 * THE PAD'S AIR IS HASHED AS FLOWN (seam review of audit 2026-09-22).
 * `kernelSimOptions` has flown the pad through `padAir` since the audit: a
 * temperature or pressure outside the panel's envelope flies BLANK (the site's
 * standard day) and the altitude is clamped to 0–10,000 m. Hashed raw, a run
 * stored before that at such a value kept matching the design, and Show charts
 * and the flight-data download re-flew it in different air under its name —
 * 39.75 m stored, 280.38 m re-flown, for a pressure of 1013.25 typed into
 * RASAero's in-Hg field.
 */
describe('conditionsKeyOf — the pad air as it is flown', () => {
  it('keeps every in-envelope key byte-identical, so no stored run moves', () => {
    expect(conditionsKeyOf(DEFAULT_CONDITIONS)).toBe(DEFAULT_CONDITIONS_KEY);
    // The envelope's own bounds are inside it.
    expect(conditionsKeyOf({ ...DEFAULT_CONDITIONS, temperatureC: 60, pressureHPa: 300, launchAltitudeM: 10000 }))
      .toBe('latitudeDeg=28.61|launchAltitudeM=10000|launchRodAngleDeg=0|launchRodLengthM=1|pressureHPa=300'
        + '|temperatureC=60|windAverage=0|windStdDev=0');
    expect(conditionsKeyOf({ ...DEFAULT_CONDITIONS, temperatureC: -60, pressureHPa: 1100, timeStepS: 0.02 }))
      .toBe('latitudeDeg=28.61|launchAltitudeM=0|launchRodAngleDeg=0|launchRodLengthM=1|pressureHPa=1100'
        + '|temperatureC=-60|timeStepS=0.02|windAverage=0|windStdDev=0');
  });

  const cases: [string, Partial<typeof DEFAULT_CONDITIONS>, string][] = [
    ['a pressure in the wrong unit', { pressureHPa: 34312.6 }, 'pressureHPa=34312.6'],
    ['a temperature in the wrong unit', { temperatureC: -184.44 }, 'temperatureC=-184.44'],
    ['an altitude above the site range', { launchAltitudeM: 10500 }, 'launchAltitudeM=10500'],
    ['an altitude below it', { launchAltitudeM: -60 }, 'launchAltitudeM=-60'],
  ];
  for (const [what, over, rawSegment] of cases) {
    it(`a run stored at ${what} no longer reads as reproducible`, () => {
      const field = Object.keys(over)[0]!;
      const stored = {
        ...INPUT_RUN,
        conditionsKey: DEFAULT_CONDITIONS_KEY.replace(new RegExp(`${field}=[^|]*`), rawSegment),
      } as SimRun;
      const cur = designMatchKeyOf({ ...INPUT, launch: { ...DEFAULT_CONDITIONS, ...over } });
      expect(runMatchesDesign(stored, cur)).toBe(false);
      expect(changedSinceRun(stored, cur)).toEqual(['the launch conditions']);
    });
  }

  it('hashes an out-of-envelope value as the air it flies', () => {
    expect(conditionsKeyOf({ ...DEFAULT_CONDITIONS, pressureHPa: 34312.6 })).toBe(DEFAULT_CONDITIONS_KEY);
    expect(conditionsKeyOf({ ...DEFAULT_CONDITIONS, temperatureC: -184.44, pressureHPa: 900 }))
      .toBe(conditionsKeyOf({ ...DEFAULT_CONDITIONS, pressureHPa: 900 }));
    expect(conditionsKeyOf({ ...DEFAULT_CONDITIONS, launchAltitudeM: 10500 }))
      .toBe(conditionsKeyOf({ ...DEFAULT_CONDITIONS, launchAltitudeM: 10000 }));
    expect(conditionsKeyOf({ ...DEFAULT_CONDITIONS, launchAltitudeM: -60 })).toBe(DEFAULT_CONDITIONS_KEY);
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
