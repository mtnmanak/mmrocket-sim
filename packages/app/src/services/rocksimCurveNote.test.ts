import { describe, expect, it, vi } from 'vitest';
import { findDbMotor } from './motorDb.js';
import { matchImportedMotor } from './motorMatch.js';
import type { OrkMotorRef } from './orkFile.js';
import { rocksimCurveNote } from './rocksimCurveNote.js';
import { bundledOnlyFetchSpec, bundledSimFiles, headerMasses, samplesToMotorSpec } from './thrustcurve.js';

const ref = (designation = 'E15', rktBurnTimeS = 2.7225): OrkMotorRef => ({
  designation, rktBurnTimeS, manufacturer: 'AeroTech', diameter: 0, length: 0, delay: 7,
  matchContext: { source: 'rocksim' },
});
const e15 = findDbMotor('E15', undefined, undefined, 'AeroTech')!;

describe('RockSim published-curve disclosure', () => {
  it('names all three historical E15 alternatives while keeping the certified default', async () => {
    const spec = await bundledOnlyFetchSpec(e15, 7);
    const result = await matchImportedMotor(ref(), { fetchSpec: bundledOnlyFetchSpec });
    expect(result.motor?.spec).toEqual(spec);
    expect(result.openNote).toContain('2.72 s from ignition to burnout');
    expect(result.openNote).toContain('1.76 s (34.7 N·s)');
    for (const id of ['5f4294d20002e90000000284', '5f4294d20002e9000000037d', '5f4294d20002e9000000041d']) {
      expect(result.openNote).toContain(`https://www.thrustcurve.org/simfiles/${id}/`);
    }
    expect(result.openNote).toContain('cert RASP (39.7 N·s, 2.60 s');
    expect(result.openNote).toContain('cert RASP (39.9 N·s, 2.62 s');
    expect(result.openNote).toContain('user RockSim (39.8 N·s, 2.64 s');
    expect(result.openNote).toContain('user RockSim');
    expect(result.openNote).toContain('Duration alone does not identify');
    expect(result.openNote).toContain('“Import .eng/.rse”');
    expect(result.motor?.openNote).toBe(result.openNote);
  });
  it('keeps the H55 match and its existing maker warning, naming the other published file', async () => {
    const result = await matchImportedMotor({ ...ref('H55', 3.641), manufacturer: 'unknown' }, { fetchSpec: bundledOnlyFetchSpec });
    expect(result.motor?.meta.motorId).toBe('5f4294d20002310000000076');
    expect(result.openNote).toContain('out of production');
    expect(result.openNote).toContain('5f4294d20002e90000000390');
    expect(result.openNote).toContain('200.1 N·s, 3.64 s');
  });
  it('compares the actual loaded curve, including a cached alternative, not a new default pick', async () => {
    const files = await bundledSimFiles(e15.motorId);
    const f = files.find(f => f.simfileId === '5f4294d20002e9000000037d')!;
    const oldSpec = samplesToMotorSpec(e15, f.samples!, 7, headerMasses(f));
    expect(await rocksimCurveNote(ref(), e15, oldSpec)).toBeUndefined();
  });
  it('does not diagnose absent, invalid, non-RockSim or agreeing stored evidence', async () => {
    const spec = await bundledOnlyFetchSpec(e15, 7), files = vi.fn(async () => []);
    for (const stored of [undefined, NaN, Infinity, -1, 0, 1.7579, 1.8]) {
      expect(await rocksimCurveNote({ ...ref(), rktBurnTimeS: stored }, e15, spec, files)).toBeUndefined();
    }
    expect(await rocksimCurveNote({ ...ref(), matchContext: { source: 'ork' } }, e15, spec, files)).toBeUndefined();
    expect(files).not.toHaveBeenCalled();
  });
  it('requires a real published alternative near the stored duration; optional load failure stays silent', async () => {
    const spec = await bundledOnlyFetchSpec(e15, 7);
    expect(await rocksimCurveNote(ref('E15', 5), e15, spec)).toBeUndefined();
    expect(await rocksimCurveNote(ref(), e15, spec, async () => { throw Error('offline chunk'); })).toBeUndefined();
    expect(await rocksimCurveNote(ref(), e15, spec, async () => [{ samples: [{ time: 0, thrust: 0 }, { time: 2.7, thrust: 0 }] }])).toBeUndefined();
  });
});
