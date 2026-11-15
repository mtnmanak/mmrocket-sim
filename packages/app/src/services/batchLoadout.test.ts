import { describe, expect, it, vi } from 'vitest';
import * as exMotors from './exMotors.js';
import * as motorLabels from './motorLabels.js';
import { batchLoadoutText, batchOtherMountsText, delayReportMotorNames, namedBatchMounts, validBatchMounts } from './batchLoadout.js';
import { runConfigurationHeading, runConfigurationLabel } from './runConfiguration.js';
import { designationForMotorIdentity } from './motorLabels.js';
import { MOTOR_DB, motorLabel } from './motorDb.js';
import { testMotor, testResolution } from './autoDelay.testSupport.js';
import type { BatchMountRecord } from './simReport.js';

const mount = (n: number, role: BatchMountRecord['role'] = 'kept', motor: string | null = 'K1499N', count = 1): BatchMountRecord =>
  ({ mountId: `m${n}`, mountName: `75mm MMT ${n}`, role, motor, count });
const four = [mount(1, 'candidate', 'M1780NT'), mount(2), mount(3), mount(4)];

describe('batch loadout evidence', () => {
  it('Round 7 repeats legacy duplicate names instead of assigning design numbers in solver order', () => {
    const delayResolution = testResolution(['b', 'c', 'd', 'a'].map(id => [id, testMotor(false, 5)]), [5, 5, 5, 5]);
    delayResolution.mounts.forEach(m => {
      m.mountName = 'Inner Tube (⌀ 75 mm)';
      m.motorIdentity = m.mountId === 'a' ? 'Acme/M1780NT' : 'Acme/K1499N';
    });
    expect(batchLoadoutText({ batch: true, delayResolution })).toBe(
      'K1499N in Inner Tube (⌀ 75 mm), Inner Tube (⌀ 75 mm), Inner Tube (⌀ 75 mm); M1780NT in Inner Tube (⌀ 75 mm)');
  });
  it('Round 7 resolves a legacy label only once per stored run object', () => {
    const delayResolution = testResolution([['a', testMotor(false, 5)], ['b', testMotor(false, 5)]], [5, 5]);
    const run = { batch: true, delayResolution };
    const spy = vi.spyOn(motorLabels, 'labelCatalogue');
    try {
      const text = batchLoadoutText(run);
      expect(text).not.toBeNull();
      expect(batchLoadoutText(run)).toBe(text);
      expect(batchLoadoutText(run)).toBe(text);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(batchLoadoutText({ ...run })).toBe(text);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
  it('Round 7 preserves typographic quotes on unquoted mount and motor surfaces while scrubbing controls', () => {
    const batchMounts = [
      { ...four[0]!, mountName: '3” MMT\n', motor: '“Candidate”\n' },
      { ...mount(2), mountName: '54mm “main” tube\u202e', motor: '“Kept”' },
    ];
    expect(namedBatchMounts(batchMounts).map(m => m.mountName)).toEqual(['3” MMT', '54mm “main” tube[U+202E]']);
    expect(batchLoadoutText({ batch: true, batchMounts })).toBe('“Candidate” in 3” MMT; “Kept” in 54mm “main” tube[U+202E]');
    expect(batchOtherMountsText({ batch: true, batchMounts })).toBe('“Kept” in 54mm “main” tube[U+202E]');
  });
  it('Round 6 resolves legacy reports in design order with stable ids for missing design mounts', () => {
    const delayResolution = testResolution(['b', 'missing-z', 'a', 'missing-c'].map(id => [id, testMotor(false, 5)]), [5, 5, 5, 5]);
    delayResolution.mounts.forEach(m => { m.motorIdentity = 'AeroTech/K1499N'; });
    const names = delayReportMotorNames(delayResolution.mounts, {}, ['a', 'b']);
    expect([...names!]).toEqual([['a', 'K1499N'], ['b', 'K1499N'], ['missing-c', 'K1499N'], ['missing-z', 'K1499N']]);
    expect(delayReportMotorNames([...delayResolution.mounts].reverse(), {}, ['a', 'b'])).toEqual(names);
  });
  it('Round 4 distinguishes different manufacturers in legacy delay evidence', () => {
    const delayResolution = testResolution([['a', testMotor(false, 5)], ['b', testMotor(false, 5)]], [5, 5]);
    delayResolution.mounts.forEach((m, i) => { m.mountName = `MMT ${i + 1}`; m.motorIdentity = `${i ? 'Klima' : 'Estes'}/C6`; });
    expect(batchLoadoutText({ batch: true, delayResolution })).toBe('Estes C6 in MMT 1; Klima C6 in MMT 2');
  });
  it.each(['\n', '   ', '\u0000\r\n'].flatMap(blank => (['mountName', 'motor'] as const).map(field => ({ blank, field }))))(
    'Round 4 rejects batch $field empty after scrubbing: $blank', ({ blank, field }) => {
      expect(validBatchMounts([four[0]!, { ...mount(2), [field]: blank }])).toBe(false);
    });
  it.each(['\n', '   ', '\u0000\r\n'].flatMap(blank => (['mountName', 'motorIdentity'] as const).map(field => ({ blank, field }))))(
    'Round 4 rejects legacy $field empty after scrubbing: $blank', ({ blank, field }) => {
      const delayResolution = testResolution([['a', testMotor(false, 5)], ['b', testMotor(false, 5)]], [5, 5]);
      delayResolution.mounts[0]![field] = blank;
      expect(batchLoadoutText({ batch: true, delayResolution })).toBeNull();
  });
  it.each(['Maker/\n', 'Maker/   ', 'Maker/\u0000'])('Round 4 rejects legacy identities resolving to blank motor names: %j', identity => {
    const delayResolution = testResolution([['a', testMotor(false, 5)], ['b', testMotor(false, 5)]], [5, 5]);
    delayResolution.mounts[0]!.motorIdentity = identity;
    expect(batchLoadoutText({ batch: true, delayResolution })).toBeNull();
  });
  it('groups four separate mounts and supplies every configuration surface', () => {
    const run = { batch: true, batchMounts: four, flightConfig: 'Club', flightOverrides: [] };
    const text = 'M1780NT in 75mm MMT 1; K1499N in 75mm MMT 2, 75mm MMT 3, 75mm MMT 4';
    expect(batchLoadoutText(run)).toBe(text);
    expect(batchOtherMountsText(run)).toBe('K1499N in 75mm MMT 2, 75mm MMT 3, 75mm MMT 4');
    expect(runConfigurationLabel(run)).toBe(`Batch · ${text}`);
    expect(runConfigurationHeading(run, 'm')).toBe(`Batch from “Club” · overrides: none · Flew: ${text}.`);
    expect(batchLoadoutText({ ...run, batch: false })).toBeNull();
  });
  it('keeps different motors, empty mounts, unlit motors and physical counts explicit', () => {
    expect(batchLoadoutText({ batch: true, batchMounts: [four[0]!, mount(2, 'kept', 'H128W', 4),
      { ...mount(3), ignition: 'never' }, mount(4, 'empty', null), mount(5, 'empty', null)] }))
      .toBe('M1780NT in 75mm MMT 1; H128W ×4 in 75mm MMT 2; K1499N (never ignites) in 75mm MMT 3; 75mm MMT 4, 75mm MMT 5 empty');
  });
  it('groups by motor and ignition regardless of role, but counts each mount separately', () => {
    expect(batchLoadoutText({ batch: true, batchMounts: [mount(1, 'candidate'), mount(2, 'kept', 'K1499N', 4)] }))
      .toBe('K1499N ×1 in 75mm MMT 1, ×4 in 75mm MMT 2');
  });
  it('leaves single mounts and mixed groups alone when there is nothing kept or empty', () => {
    expect(batchLoadoutText({ batch: true, batchMounts: [four[0]!] })).toBeNull();
    expect(batchLoadoutText({ batch: true, batchMounts: [mount(1, 'candidate', 'A', 2), mount(2, 'candidate', 'B', 2)] })).toBeNull();
    expect(batchLoadoutText({ batch: true })).toBeNull();
  });
  it('uses only validated legacy delay vectors, without inventing roles, counts or empty mounts', () => {
    const delayResolution = testResolution([['a', testMotor(false, 5)], ['b', testMotor(false, 5)]], [5, 5]);
    delayResolution.mounts.forEach((m, i) => { m.mountName = `MMT ${i + 1}`; m.motorIdentity = 'AeroTech/K1499N'; });
    const run = { batch: true, delayResolution };
    expect(batchLoadoutText(run)).toBe('K1499N in MMT 1, MMT 2');
    expect(batchLoadoutText({ ...run, batchMounts: [{ ...four[0], count: 0 }] as BatchMountRecord[] })).toBe('K1499N in MMT 1, MMT 2');
    expect(batchLoadoutText({ batch: true, batchMounts: 'bad' as never })).toBeNull();
    expect(batchLoadoutText({ ...run, delayResolution: { ...delayResolution, probes: -1 } })).toBeNull();
    expect(batchOtherMountsText(run)).toBe('');
  });
  it('scrubs file names and motor designations before forming text', () => {
    expect(batchLoadoutText({ batch: true, batchMounts: [four[0]!, { ...mount(2), mountName: 'Left\n\u202e', motor: 'K\n1499N' }] }))
      .toBe('M1780NT in 75mm MMT 1; K1499N in Left[U+202E]');
  });
  it.each([
    { case: 'null vector', value: null }, { case: 'object vector', value: {} },
    { case: 'null record', value: [mount(0, 'candidate'), null] },
    { case: '65 records', value: Array.from({ length: 65 }, (_, i) => mount(i, 'candidate')) },
    { case: 'empty id', value: [{ ...mount(1, 'candidate'), mountId: '' }] },
    { case: 'long id', value: [{ ...mount(1, 'candidate'), mountId: 'x'.repeat(1025) }] },
    { case: 'long name', value: [{ ...mount(1, 'candidate'), mountName: 'x'.repeat(1025) }] },
    { case: 'long motor', value: [{ ...mount(1, 'candidate'), motor: 'x'.repeat(1025) }] },
    { case: 'unknown role', value: [mount(0, 'candidate'), { ...mount(1), role: 'unknown' }] },
    { case: 'candidate without motor', value: [{ ...mount(1, 'candidate'), motor: null }] },
    { case: 'empty with motor', value: [mount(0, 'candidate'), mount(1, 'empty', 'K')] },
    { case: 'zero count', value: [{ ...mount(1, 'candidate'), count: 0 }] },
    { case: '1001 count', value: [{ ...mount(1, 'candidate'), count: 1001 }] },
    { case: 'fractional count', value: [{ ...mount(1, 'candidate'), count: 1.5 }] },
    { case: 'infinite count', value: [{ ...mount(1, 'candidate'), count: Infinity }] },
    { case: 'unknown ignition', value: [mount(0, 'candidate'), { ...mount(1), ignition: 'automatic' }] },
    { case: 'empty ignition', value: [mount(0, 'candidate'), { ...mount(1, 'empty', null), ignition: 'never' }] },
    { case: 'duplicate id', value: [mount(1, 'candidate'), mount(1)] },
  ])('drops invalid vectors whole: $case', ({ value }) => {
    expect(validBatchMounts(value)).toBe(false);
  });
  it('accepts bounded vectors with kept-never and empty mounts', () => {
    expect(validBatchMounts([...four, { ...mount(5), ignition: 'never' }, mount(6, 'empty', null)])).toBe(true);
    expect(validBatchMounts([{ ...mount(1, 'candidate'), count: 1000 }])).toBe(true);
  });
});

it('Round 5 normalizes mount whitespace before reserving, counting and emitting names', () => {
  expect(namedBatchMounts([' MMT', 'MMT ', ' MMT   1 '].map(mountName => ({ mountName }))).map(m => m.mountName))
    .toEqual(['MMT 2', 'MMT 3', 'MMT 1']);
});

it('Round 5 bounds resolved EX names and scrub-expanded new records', () => {
  const ex = exMotors.parseEng('E20 29 100 5 0.05 0.1 Home\n0 0\n0.5 40\n1 0')[0]!;
  const spy = vi.spyOn(exMotors, 'getExMotor').mockReturnValue({ ...ex, designation: 'K'.repeat(1_000_000) });
  try {
    const delayResolution = testResolution([['a', testMotor(false, 5)], ['b', testMotor(false, 5)]], [5, 5]);
    delayResolution.mounts[0]!.motorIdentity = 'ex:oversized-round5';
    expect(batchLoadoutText({ batch: true, delayResolution })).toBeNull();
    expect(validBatchMounts([{ ...mount(1, 'candidate'), motor: '\u202e'.repeat(200) }])).toBe(false);
  } finally { spy.mockRestore(); }
});

describe('Round 3 bounded and uniquely named evidence', () => {
  it.each([
    [['X', 'X', 'X 2'], ['X 1', 'X 3', 'X 2']],
    [['Sweep', 'Inner Tube', 'Inner Tube', 'Inner Tube 1'], ['Sweep', 'Inner Tube 2', 'Inner Tube 3', 'Inner Tube 1']],
  ])('reserves existing names and formats subsets without renumbering: %j', (input, expected) => {
    const batchMounts = input.map((mountName, i) => ({ ...mount(i, i ? 'kept' : 'candidate'), mountName }));
    expect(namedBatchMounts(batchMounts).map(m => m.mountName)).toEqual(expected);
    expect(batchOtherMountsText({ batch: true, batchMounts }))
      .toBe(`K1499N in ${expected.slice(1).join(', ')}`);
    expect(batchLoadoutText({ batch: true, batchMounts })).toBe(`K1499N in ${expected.join(', ')}`);
  });
  it.each([
    [], [mount(1)], [mount(1, 'empty', null)],
    [{ ...mount(1, 'candidate'), mountName: '' }],
    [{ ...mount(1, 'candidate'), motor: '' }],
    [mount(1, 'candidate'), { ...mount(2), motor: '' }],
  ].map(value => ({ value })))('rejects incomplete sweep evidence whole: $value', ({ value }) => {
    expect(validBatchMounts(value)).toBe(false);
    expect(batchLoadoutText({ batch: true, batchMounts: value })).toBeNull();
  });
  it.each(['mountId', 'mountName', 'motorIdentity'] as const)('bounds legacy %s before formatting', field => {
    const delayResolution = testResolution([['a', testMotor(false, 5)], ['b', testMotor(false, 5)]], [5, 5]);
    delayResolution.mounts[0]![field] = 'x'.repeat(1025);
    expect(batchLoadoutText({ batch: true, delayResolution })).toBeNull();
  });
  it('bounds the legacy mount population', () => {
    const delayResolution = testResolution(Array.from({ length: 65 }, (_, i) => [`m${i}`, testMotor(false, 5)]), Array(65).fill(5));
    expect(batchLoadoutText({ batch: true, delayResolution })).toBeNull();
  });
});

it('resolves catalogue, EX, maker/designation and unknown recorded motor identities', async () => {
  const m = MOTOR_DB[0]!;
  expect(designationForMotorIdentity(m.motorId, MOTOR_DB)).toBe(motorLabel(m, 0).replace(/-0$/, ''));
  expect(designationForMotorIdentity('AeroTech/K1499N', MOTOR_DB)).toBe('K1499N');
  expect(designationForMotorIdentity('/K1499N', MOTOR_DB)).toBe('K1499N');
  expect(designationForMotorIdentity('unresolved-id', MOTOR_DB)).toBe('unknown motor');
  expect(designationForMotorIdentity('unresolved-id-5', MOTOR_DB)).toBe('unknown motor');
  expect(designationForMotorIdentity('ex:missing', MOTOR_DB)).toBe('experimental motor (no longer in your library)');
  expect(designationForMotorIdentity('0123456789abcdef01234567', MOTOR_DB)).toBe('unknown motor');
  expect(designationForMotorIdentity('/E22', MOTOR_DB)).toBe('E22');
  const { parseEng, addExMotors } = await import('./exMotors.js');
  const ex = parseEng('E20 29 100 5 0.05 0.1 Home\n0 0\n0.5 40\n1 0')[0]!;
  addExMotors([ex]);
  expect(designationForMotorIdentity(ex.motorId, MOTOR_DB)).toBe('E20');
});

describe('Round 2 loadout disclosure', () => {
  it.each([
    ['0123456789abcdef01234567', 'unknown motor'],
    ['ex:missing-round2', 'experimental motor (no longer in your library)'],
    ['/E22', 'E22'],
  ])('names unresolved identity %s explicitly', (identity, expected) => {
    expect(designationForMotorIdentity(identity, MOTOR_DB)).toBe(expected);
  });
  it('numbers every duplicate in design order before grouping or filtering', () => {
    const batchMounts = four.map(m => ({ ...m, mountName: 'Inner Tube' }));
    expect(batchLoadoutText({ batch: true, batchMounts })).toBe('M1780NT in Inner Tube 1; K1499N in Inner Tube 2, Inner Tube 3, Inner Tube 4');
    expect(batchOtherMountsText({ batch: true, batchMounts })).toBe('K1499N in Inner Tube 2, Inner Tube 3, Inner Tube 4');
    const delayResolution = testResolution(['a', 'b', 'c', 'd'].map(id => [id, testMotor(false, 5)]), [5, 5, 5, 5]);
    delayResolution.mounts.forEach(m => { m.mountName = 'Inner Tube'; m.motorIdentity = 'Acme/E22'; });
    // Legacy vectors have solver order, so their duplicate names stay unnumbered.
    expect(batchLoadoutText({ batch: true, delayResolution })).toBe('E22 in Inner Tube, Inner Tube, Inner Tube, Inner Tube');
  });
  it('shows each unequal multiplier, including one, and abbreviates equal counts', () => {
    const batchMounts = [mount(1, 'candidate', 'K1499N', 2), mount(2)];
    expect(batchLoadoutText({ batch: true, batchMounts })).toBe('K1499N ×2 in 75mm MMT 1, ×1 in 75mm MMT 2');
    expect(batchLoadoutText({ batch: true, batchMounts: batchMounts.map(m => ({ ...m, count: 2 })) }))
      .toBe('K1499N ×2 in 75mm MMT 1, 75mm MMT 2');
  });
  it('prefers the stored loadout over legacy delay evidence', () => {
    const delayResolution = testResolution([['m1', testMotor(false, 5)], ['m2', testMotor(false, 5)]], [5, 5]);
    delayResolution.mounts[0]!.motorIdentity = '0123456789abcdef01234567';
    expect(batchLoadoutText({ batch: true, batchMounts: four, delayResolution })).toContain('M1780NT in 75mm MMT 1');
  });
  it.each(['true', 1, {}, false, undefined])('requires the exact batch flag: %j', batch => {
    const run = { batch: batch as boolean, batchMounts: four, flightConfig: 'Club', flightOverrides: [] };
    expect(batchLoadoutText(run)).toBeNull();
    expect(batchOtherMountsText(run)).toBe('');
    expect(runConfigurationLabel(run)).toBe('Club');
    expect(runConfigurationHeading(run, 'm')).toBe('Flown in “Club” · overrides: none');
  });
});
