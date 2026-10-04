import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundledSimFiles, fileImpulseNs, headerMasses, pickSampleFile, samplesToMotorSpec } from '../src/services/thrustcurve.ts';
import { motorCorrectionsSentence } from '../../../scripts/build-user-guide.mjs';

const motors = JSON.parse(readFileSync(new URL('../src/data/motors.json', import.meta.url), 'utf8')).motors;
const cases = [
  ['F52C', { maxThrustN: 64.33 }, '5f5e57811e865c0004c955d8'],
  ['H13ST', { maxThrustN: 43.51 }, '5f5e58171e865c0004c955f8'],
  ['N2700W-PS', { totImpulseNs: 10637, maxThrustN: 5553.5 }, '6623cf91f873440002ac6a28'],
];

describe('row 57 changes catalogue figures, retaining the bundled flight inputs', () => {
  it.each(cases)('%s retains its default file and every MotorSpec field', async (_designation, old, id) => {
    const after = motors.find((m) => m.motorId === id);
    const before = { ...after, ...old };
    const files = await bundledSimFiles(id);
    expect(files.length).toBeGreaterThan(0);
    const oldPick = pickSampleFile(files, before);
    const newPick = pickSampleFile(files, after);
    expect(newPick.simfileId).toBe(oldPick.simfileId);
    // Also covers an explicit curve choice. Equality is differential, not a
    // hard-coded kernel float: the complete inputs sent to the engine agree.
    for (const f of files) {
      expect(samplesToMotorSpec(after, f.samples, Infinity, headerMasses(f)))
        .toEqual(samplesToMotorSpec(before, f.samples, Infinity, headerMasses(f)));
    }
    console.log(JSON.stringify({ designation: after.designation, files: files.length,
      picked: newPick.simfileId, flownImpulseNs: fileImpulseNs(newPick), masses: headerMasses(newPick) }));
  });

  it('can phrase both new correction fields for guide generation', () => {
    const text = motorCorrectionsSentence([{ manufacturer: 'AeroTech', designation: 'N2700W-PS', fields: {
      maxThrustN: { bad: 5553.5, good: 4624.6 }, totImpulseNs: { bad: 10637, good: 10322 },
    } }], motors);
    expect(text).toContain('peak thrust of 4,624.6 N, where thrustcurve.org lists 5,553.5 N');
    expect(text).toContain('total impulse of 10,322 N·s, where thrustcurve.org lists 10,637 N·s');
  });
});
