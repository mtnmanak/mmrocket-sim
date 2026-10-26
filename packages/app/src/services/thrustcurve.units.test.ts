// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { IMPERIAL_UNITS } from '../prefs/units.js';
import { MOTOR_DB } from './motorDb.js';
import { bundledOnlyFetchSpec } from './thrustcurve.js';
import bundle from '../data/motorCurves.json';

// BundledSimFile permits absent masses (thrustcurve.ts); retain complete real
// file records and samples, removing only that optional header information.
vi.mock('../data/motorCurves.json', async importOriginal => {
  const real = await importOriginal<{ default: typeof bundle }>();
  const [id, files] = Object.entries(real.default.curves).find(([, files]) => files.length > 0)!;
  return { default: { ...real.default, curves: { [id]: files.map(file => ({ ...file, masses: undefined })) } } };
});

it('keeps preferred units in a headerless bundled curve mass refusal', async () => {
  const row = MOTOR_DB.find(m => Object.hasOwn(bundle.curves, m.motorId))!;
  await expect(bundledOnlyFetchSpec({ ...row, totalWeightG: 100, propWeightG: 200 }, 0, undefined, IMPERIAL_UNITS))
    .rejects.toThrow('more propellant (7.05 oz [200 g]) than loaded mass (3.53 oz [100 g])');
});
