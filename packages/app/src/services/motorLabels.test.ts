import { describe, expect, it } from 'vitest';
import { displayMotorManufacturer } from './motorDb.js';
import { exToDbEntry, exToMotorSpec, parseEng } from './exMotors.js';
import { mountMotorFromDb } from './motorMatch.js';
import { restoreMotorLabels, motorTooltip, loadoutMotorNames, motorEntryForIdentity, designationForMotorIdentity } from './motorLabels.js';
import { batchMotorNames, candidateIdentity } from './batchSweep.js';
import { catalogueSuffixPair, labelMotor } from './motorLabels.testSupport.js';

describe('Round 4 loadout motor identities', () => {
  it('Round 7 preserves quoted motor names on unquoted loadout surfaces', () => {
    expect(loadoutMotorNames([{ designation: '“K500”\n', manufacturerAbbrev: 'Home”' }], [])).toEqual(['“K500”']);
    expect(loadoutMotorNames(['Home”', 'Other”'].map(manufacturerAbbrev => ({ designation: '“K500”', manufacturerAbbrev })), []))
      .toEqual(['Home” “K500”', 'Other” “K500”']);
  });
  it('distinguishes EX definitions with the same maker and designation without exposing their real makers', () => {
    const motors = ['alpha', 'beta'].map(id => ({ designation: 'K500', manufacturerAbbrev: 'EX', motorId: `ex:${id}`,
      realManufacturer: 'Private maker' }));
    expect(loadoutMotorNames(motors)).toEqual(['EX K500 (1)', 'EX K500 (2)']);
    expect(loadoutMotorNames([motors[0]!, motors[0]!])).toEqual(['K500', 'K500']);
  });
  it('retains synthetic catalogue clash distinctions', () => {
    const motors = ['229H255-14A', '315H255-14A'].map(d => labelMotor(d, 'Cesaroni'));
    const labels = loadoutMotorNames(motors, motors);
    expect(new Set(labels).size).toBe(motors.length);
    for (const label of labels) expect(label).toMatch(/^\d+H255$/);
  });
  it('strips catalogue delay suffixes even when different makers need prefixes', () => {
    const delayed = labelMotor('381I224-15A', 'Cesaroni');
    const sameName = { designation: 'I224', manufacturerAbbrev: 'Other', motorId: 'other-i224' };
    expect(loadoutMotorNames([delayed, sameName], [delayed])).toEqual(['Cesaroni I224', 'Other I224']);
  });
  it('treats non-catalogue maker/designation identities as one motor regardless of delay or ids', () => {
    const motors = ['one', 'two'].map(motorId => ({ designation: 'C6-5', manufacturerAbbrev: 'Acme', motorId }));
    expect(loadoutMotorNames(motors)).toEqual(['C6', 'C6']);
  });
});

describe('Round 5 readable motor names', () => {
  it('Round 6 allocates collision ordinals independently of input order, including reserved names', () => {
    const entries = [
      { designation: 'K500', manufacturerAbbrev: 'EX', motorId: 'ex:beta' },
      { designation: 'K500', manufacturerAbbrev: 'EX', motorId: 'ex:alpha' },
      { designation: 'EX K500 (1)', motorId: 'reserved' },
    ];
    const names = ['EX K500 (3)', 'EX K500 (2)', 'EX K500 (1)'];
    expect(loadoutMotorNames(entries, [])).toEqual(names);
    for (const indices of [[2, 1, 0], [1, 0, 2], [0, 2, 1]]) {
      expect(loadoutMotorNames(indices.map(i => entries[i]!), [])).toEqual(indices.map(i => names[i]));
    }
  });
  it.each([['D5', 'D5-P'], ['B4', 'B4-4']])('preserves synthetic catalogue suffix distinction %s / %s', (a, b) => {
    const motors = [a, b].map(designation => labelMotor(designation));
    expect(loadoutMotorNames(motors, motors)).toEqual([`Acme ${a}`, `Acme ${b}`]);
    expect(designationForMotorIdentity(motors[1]!.motorId, motors)).toBe(b);
    expect(designationForMotorIdentity(`Acme/${b}`, motors)).toBe(b);
  });
  it.skipIf(!catalogueSuffixPair)('Round 7 preserves a structurally selected shipped suffix pair', () => {
    const motors = [...catalogueSuffixPair!];
    expect(loadoutMotorNames(motors)).toEqual(motors.map(m => `${m.manufacturerAbbrev} ${m.designation}`));
    expect(designationForMotorIdentity(motors[1]!.motorId)).toBe(motors[1]!.designation);
  });
  it('uses readable raw names for uncatalogued reloads and groups delay variants', () => {
    expect(loadoutMotorNames(['229H255-14A', '315H255-14A'].map(designation => ({ designation, manufacturerAbbrev: 'Cesaroni' })), []))
      .toEqual(['Cesaroni 229H255', 'Cesaroni 315H255']);
    expect(loadoutMotorNames(['Estes/C6-5', 'Estes/C6-7'].map(id => motorEntryForIdentity(id, [])), []))
      .toEqual(['C6', 'C6']);
  });
  it('uses ordinals for removed catalogue identities without leaking hashes', () => {
    const identities = ['0123456789abcdef01234567', '0123456789abcdef01234568'];
    expect(loadoutMotorNames(identities.map(id => motorEntryForIdentity(id, [])), []))
      .toEqual(['unknown motor (1)', 'unknown motor (2)']);
  });
  it('never presents an opaque id or serialized key as an unresolved motor name', () => {
    const identities = ['removed-catalogue-row', JSON.stringify(['Cesaroni', '229H255-14A']), JSON.stringify(['Cesaroni', '229/H255-14A'])];
    expect(loadoutMotorNames(identities.map(id => motorEntryForIdentity(id, [])), []))
      .toEqual(['unknown motor (3)', 'unknown motor (2)', 'unknown motor (1)']);
  });
  it('uses ordinals when catalogue records have exactly the same raw designation', () => {
    const motors = ['id-one', 'id-two'].map(motorId => labelMotor('C6', 'Acme', motorId));
    expect(loadoutMotorNames(motors, motors)).toEqual(['Acme C6 (1)', 'Acme C6 (2)']);
  });
});

it.each(['5', true, null])('never calls invalid live delay %j plugged in its tooltip', delay => {
  const ex = parseEng('C6 18 70 5 0.01 0.02 Home\n0 0\n0.5 6\n1 0')[0]!;
  const mm = mountMotorFromDb(exToDbEntry(ex), exToMotorSpec(ex, 5), 5, { event: 'automatic', delay: 0 }, { exMotorId: ex.motorId });
  Object.assign(mm.spec, { ejectionDelay: delay });
  expect(motorTooltip(mm)).toContain('unknown delay');
  expect(motorTooltip(mm)).not.toContain('plugged');
});

describe('EX maker labels — @atestani, TRF #162, 2026-10-06', () => {
  const ex = parseEng('F67 28.6 127 6 0.0430 0.1120 Enerjet\n0 0\n0.5 67\n1.2 0\n')[0]!;

  it.each([['Enerjet', 'Enerjet (EX)'], [' Enerjet ', 'Enerjet (EX)'], ['EX', 'EX'], [' ex ', 'EX'], ['', 'EX'], [undefined, 'EX']])(
    'shows maker %s as %s', (realManufacturer, expected) => {
      expect(displayMotorManufacturer({ manufacturerAbbrev: 'EX', realManufacturer })).toBe(expected);
    });

  it.each([7, { toString: 0 }, null])('ignores a stored maker %j that is not text', realManufacturer => {
    expect(displayMotorManufacturer({ manufacturerAbbrev: 'EX', realManufacturer: realManufacturer as never })).toBe('EX');
    expect(displayMotorManufacturer({ manufacturerAbbrev: 'AeroTech', realManufacturer: realManufacturer as never })).toBe('AeroTech');
  });

  it('keeps catalogue makers unchanged', () => {
    expect(displayMotorManufacturer({ manufacturerAbbrev: 'AeroTech', realManufacturer: 'ignored' })).toBe('AeroTech');
  });

  it('shows the captured maker in the vitals tooltip without changing EX identity', () => {
    const db = exToDbEntry(ex);
    const mm = mountMotorFromDb(db, exToMotorSpec(ex, 9), 9, { event: 'automatic', delay: 0 }, { exMotorId: ex.motorId });
    expect(motorTooltip(mm)).toBe('Enerjet (EX) F67, 9 s delay (F67-9)');
    expect(mm.meta.manufacturer).toBe('EX');
    expect(mm.meta.exMotorId).toBe(ex.motorId);
  });

  it('keeps EX for an old session without a captured maker', () => {
    const { exDefinition: _definition, ...spec } = exToMotorSpec(ex, 9);
    const mm = mountMotorFromDb(exToDbEntry(ex), spec, 9, { event: 'automatic', delay: 0 }, { exMotorId: ex.motorId });
    expect(motorTooltip(mm)).toBe('EX F67, 9 s delay (F67-9)');
  });

  it('names each batch candidate by its maker while keeping its identity', () => {
    const db = exToDbEntry(ex);
    const other = exToDbEntry({ ...ex, motorId: 'ex:other-f67', realManufacturer: 'Other' });
    expect([...batchMotorNames([db, other]).values()]).toEqual(['Enerjet (EX) F67', 'Other (EX) F67']);
    expect([...batchMotorNames([db, other], false).values()]).toEqual([
      `EX F67 [${db.motorId}]`, `EX F67 [${other.motorId}]`,
    ]);
    expect(candidateIdentity(db)).toBe(ex.motorId);
    expect(db.manufacturerAbbrev).toBe('EX');
  });
});

it.each(['tooltip', 'delay', 'restore', 'config'])('lane C S1c-1 keeps the H100 snapshot name through %s', async path => {
  const { withDelay } = await import('./mountDelayEdits.js');
  const { planConfigSwitch } = await import('./importApply.js');
  const source = parseEng('E20 29 100 5 0.05 0.1 Home\n0 0\n0.5 40\n1 0')[0]!;
  const ex = { ...source, flightSnapshot: {
    designation: 'H100', diameter: 0.054, length: 0.3, cgX: 0.15,
    times: [0, 1, 2], thrusts: [0, 200, 0], masses: [0.5, 0.4, 0.3],
  } };
  const mm = mountMotorFromDb(exToDbEntry(ex), exToMotorSpec(ex, 5), 5,
    { event: 'automatic', delay: 0 }, { exMotorId: ex.motorId });
  if (path === 'tooltip') expect(motorTooltip(mm)).toBe('Home (EX) H100, 5 s delay (H100-5)');
  if (path === 'delay') expect(withDelay(mm, 7).label).toBe('H100-7');
  const stale = { ...mm, label: 'E20-5', meta: { ...mm.meta, label: 'E20-5' } };
  if (path === 'restore') expect(restoreMotorLabels({ mount: stale }).mount!.label).toBe('H100-5');
  const cfg = { id: 'b', name: 'B', isDefault: false, motors: { mount: stale } };
  const switched = planConfigSwitch({ savedConfigs: [cfg], activeConfigId: null,
    mountMotors: {}, unmatchedRefs: {}, tree: { components: [] } }, cfg,
    { mass: n => String(n), length: n => String(n) });
  if (path === 'config') expect(switched.mountMotors.mount!.label).toBe('H100-5');
  expect(switched.mountMotors.mount!.spec).toBe(mm.spec);
});

it.each([
  [{ designation: 'Broken', realManufacturer: 'Home' }, 'Broken'],
  [{ designation: 'E20', realManufacturer: 'Home', flightSnapshot: { designation: 'H100' } }, 'H100'],
  [{ designation: 42 }, 'E20'],
  [{ designation: '' }, 'E20'],
] as const)('round1 labels damaged autosave definition %j without reading curve arrays', (definition, name) => {
  const source = parseEng('E20 29 100 5 0.05 0.1 Home\n0 0\n0.5 40\n1 0')[0]!;
  const spec = { ...exToMotorSpec(source, 5), exDefinition: JSON.parse(JSON.stringify(definition)) };
  const mm = mountMotorFromDb(exToDbEntry(source), spec, 5,
    { event: 'automatic', delay: 0 }, { exMotorId: source.motorId });
  const restored = restoreMotorLabels({ mount: mm });
  expect(restored.mount!.label).toBe(`${name}-5`);
  expect(motorTooltip(mm)).toContain(`${name}, 5 s delay (${name}-5)`);
  expect(restored.mount!.spec).toBe(spec);
});
