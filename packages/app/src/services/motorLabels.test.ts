import { describe, expect, it } from 'vitest';
import { displayMotorManufacturer } from './motorDb.js';
import { exToDbEntry, exToMotorSpec, parseEng } from './exMotors.js';
import { mountMotorFromDb } from './motorMatch.js';
import { restoreMotorLabels, motorTooltip } from './motorLabels.js';
import { batchMotorNames, candidateIdentity } from './batchSweep.js';

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
    expect([...batchMotorNames([db, other], false).values()]).toEqual(['EX F67', 'EX F67']);
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
