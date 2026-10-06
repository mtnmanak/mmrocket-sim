import { describe, expect, it } from 'vitest';
import { displayMotorManufacturer } from './motorDb.js';
import { exToDbEntry, exToMotorSpec, parseEng } from './exMotors.js';
import { mountMotorFromDb } from './motorMatch.js';
import { motorTooltip } from './motorLabels.js';
import { batchMotorNames, candidateIdentity } from './batchSweep.js';

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
