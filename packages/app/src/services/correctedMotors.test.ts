import { describe, expect, it } from 'vitest';
import { MOTOR_CORRECTIONS } from '../../scripts/motor-corrections.mjs';
import { MOTOR_DB, filterMotors } from './motorDb.js';
import { bundledSimFiles, defaultDelay, fetchMotorSpec, pickSampleFile } from './thrustcurve.js';

/**
 * The corrected catalogue rows as the app USES them, where
 * scripts/motor-corrections.test.mjs holds them as motors.json stores them
 * (board Tier 1 rows 6 and 37). A motor's catalogued length is its MotorSpec's
 * length and, at half of it, its CG (samplesToMotorSpec), and it is what a
 * mount's maximum motor length is held to in the motor browser and the batch
 * run (filterMotors). These run the shipped catalogue and curve bundle through
 * those paths, as a flight does.
 */
const byId = new Map(MOTOR_DB.map((m) => [m.motorId, m]));

/** Is the motor offered on a mount of its own bore with this much room for a motor (m)? */
function offered(motorId: string, roomM: number): boolean {
  const m = byId.get(motorId)!;
  return filterMotors({
    manufacturers: new Set(), classes: new Set(), boreMm: m.diameter, includeOOP: true, maxLengthM: roomM, text: '',
  }, MOTOR_DB).some((x) => x.motorId === motorId);
}

describe('a corrected length, as the app flies and filters it', () => {
  const lengths = MOTOR_CORRECTIONS.filter((c) => c.fields['length'] !== undefined);

  it('has corrections to test', () => {
    expect(lengths.length).toBeGreaterThan(0);
  });

  it.each(lengths.map((c) => [`${c.manufacturer} ${c.designation}`, c] as const))('%s', async (_name, c) => {
    const { good } = c.fields['length']!;
    const row = byId.get(c.motorId)!;
    const spec = await fetchMotorSpec(row, defaultDelay(row) ?? 0);
    expect(spec.length).toBeCloseTo(good / 1000, 9);
    expect(spec.cgX).toBeCloseTo(good / 2000, 9);
    expect(offered(c.motorId, good / 1000)).toBe(true);
    expect(offered(c.motorId, (good - 1) / 1000)).toBe(false);
  });
});

describe('the AeroTech K62N: 374.25 mm by its certification letter, 274 mm on thrustcurve.org', () => {
  const K62N = '63bb643e1d26f30004b4b077';

  it('flies the curve and masses it flew before: its one bundled file, the TMT certification data', async () => {
    const row = byId.get(K62N)!;
    const file = pickSampleFile(await bundledSimFiles(K62N), row)!;
    expect([file.simfileId, file.source, file.format]).toEqual(['63bd1c3e292aef00048b8be1', 'cert', 'RASP']);
    const spec = await fetchMotorSpec(row, defaultDelay(row)!);
    // The file's own masses, which are the letter's: 1,277 g loaded, 831 g of propellant.
    expect(spec.masses[0]).toBeCloseTo(1.277, 6);
    expect(spec.masses.at(-1)).toBeCloseTo(1.277 - 0.831, 6);
    expect(spec.diameter).toBeCloseTo(0.054, 9);
    // The file's 15 samples, flown from a zero-thrust point at t = 0 (its first is at 0.05 s).
    expect(spec.times).toHaveLength(file.samples!.length + 1);
    expect(spec.ejectionDelay).toBe(Infinity);
  });

  it('is refused by a mount with room for the 274 mm thrustcurve.org gives it, and offered on 374.25', () => {
    expect(offered(K62N, 0.274)).toBe(false);
    expect(offered(K62N, 0.374)).toBe(false);
    expect(offered(K62N, 0.37425)).toBe(true);
  });
});
