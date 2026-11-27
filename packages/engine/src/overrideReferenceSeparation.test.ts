import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec, type RocketTree } from './orkEngine.js';

// Synthetic curve: no catalogue dependency. Only the booster is powered.
const MOTOR: MotorSpec = {
  designation: 'Separation test', diameter: 0.024, length: 0.1,
  times: [0, 0.05, 1, 1.2], thrusts: [0, 30, 30, 0],
  masses: [0.1, 0.099, 0.075, 0.07], cgX: 0.05, ejectionDelay: 1000,
};
const AREA = 0.001;
const CD = 0.7;

function tree(carried: boolean, boosterCarrier = false): RocketTree {
  const large = 0.05, small = 0.025;
  const body = (radius: number, booster: boolean): ComponentNode => ({
    type: 'bodytube', length: booster ? 0.2 : 0.4, outerRadius: radius,
    thickness: 0.0005, density: 950,
    children: [
      { type: 'trapezoidfinset', finCount: 3, rootChord: 0.1, tipChord: 0.05,
        sweep: 0.03, height: 0.06, thickness: 0.002, crossSection: 'rounded',
        position: { method: 'bottom', offset: 0 } },
      ...(booster ? [{ type: 'innertube', id: 'mount', motorMount: true,
        length: 0.1, outerRadius: 0.013, thickness: 0.0005,
        position: { method: 'bottom', offset: 0 } }] : []),
      ...(booster === boosterCarrier ? [{
        type: 'railbutton', outerDiameter: 0.014, launchGuide: false, overrideMass: 0,
        overrideCD: CD * AREA / (Math.PI * large ** 2),
        ...(carried ? { overrideCDReferenceRadius: large } : {}),
      }] : []),
    ],
  } as unknown as ComponentNode);
  const susR = boosterCarrier ? large : small;
  return { name: 'Override separation', components: [
    { type: 'stage', name: 'Sustainer', children: [
      { type: 'nosecone', length: 0.15, aftRadius: susR, thickness: 0.001, overrideMass: 0.1 },
      body(susR, false),
    ] },
    { type: 'stage', name: 'Booster', separationEvent: 'burnout',
      children: [body(boosterCarrier ? small : large, true)] },
  ] } as unknown as RocketTree;
}

describe('generated override area survives a change of active stages', () => {
  it.each(['classic', 'kbf', 'hybrid'] as const)('keeps scalar CdA on both sides of separation (%s)', (model) => {
    for (const carried of [true, false]) {
      const rocket = OrkRocket.buildTree(tree(carried));
      rocket.setMotorById('mount', MOTOR);
      rocket.setRogersModifiedBarrowman(model === 'kbf');
      rocket.setHybridAero(model === 'hybrid');
      // Exercise both inner calculators even in this subsonic fixture.
      if (model === 'hybrid') rocket.setHybridBand(0, 0.2);
      const result = rocket.simulate({ series: 'full', randomSeed: 7, windAverage: 0, windStdDeviation: 0 });
      expect(result.events.some(e => e.type === 'SIM_ABORT')).toBe(false);
      expect(result.events.some(e => e.type === 'STAGE_SEPARATION')).toBe(true);
      expect(result.branches).toHaveLength(2);
      const separation = result.events.find(e => e.type === 'STAGE_SEPARATION')!.time;
      const branch = result.branches!.find(b => b.name === 'Sustainer')!;
      const apogee = branch.events.find(e => e.type === 'APOGEE')!.time;
      // Tumble switches away from RK4/Barrowman and has no override drag bucket.
      const end = Math.min(apogee, branch.events.find(e => e.type === 'TUMBLE')?.time ?? Infinity);
      const s = branch.series;
      let before = 0, after = 0;
      s.time.forEach((t, i) => {
        if (t >= end || Math.abs(t - separation) < 1e-6 || !Number.isFinite(s['Cd']![i])) return;
        expect(s['Ar']![i]! / (Math.PI * (t < separation ? 0.05 : 0.025) ** 2) - 1).toBeCloseTo(0, 12);
        const override = s['Cd']![i]! - s['Cdf']![i]! - s['Cdp']![i]! - s['Cdb']![i]!;
        const want = CD * AREA;
        const actual = carried ? override * s['Ar']![i]! : override * Math.PI * 0.05 ** 2;
        // Relative error: subtraction of the four drag buckets costs a few ulps.
        expect(actual / want - 1, `${model} carried=${carried} t=${t}`).toBeCloseTo(0, 10);
        if (t < separation) before++; else after++;
      });
      expect(before).toBeGreaterThan(5);
      expect(after).toBeGreaterThan(5);
    }
  }, 60_000);

  it('also rescales a carrier on a narrower separated booster', () => {
    const rocket = OrkRocket.buildTree(tree(true, true));
    rocket.setMotorById('mount', MOTOR);
    const result = rocket.simulate({ series: 'full', randomSeed: 7, windAverage: 0, windStdDeviation: 0 });
    expect(result.events.some(e => e.type === 'SIM_ABORT')).toBe(false);
    expect(result.events.some(e => e.type === 'STAGE_SEPARATION')).toBe(true);
    expect(result.branches).toHaveLength(2);
    const separation = result.events.find(e => e.type === 'STAGE_SEPARATION')!.time;
    const branch = result.branches!.find(b => b.name === 'Booster')!;
    const apogee = branch.events.find(e => e.type === 'APOGEE')!.time;
    const end = Math.min(apogee, branch.events.find(e => e.type === 'TUMBLE')?.time ?? Infinity);
    const s = branch.series;
    let rows = 0;
    s.time.forEach((t, i) => {
      if (t <= separation + 1e-6 || t >= end || !Number.isFinite(s['Cd']![i])) return;
      expect(s['Ar']![i]! / (Math.PI * 0.025 ** 2) - 1).toBeCloseTo(0, 12);
      const override = s['Cd']![i]! - s['Cdf']![i]! - s['Cdp']![i]! - s['Cdb']![i]!;
      expect(override * s['Ar']![i]! / (CD * AREA) - 1).toBeCloseTo(0, 10);
      rows++;
    });
    expect(rows).toBeGreaterThan(5);
  }, 60_000);
});
