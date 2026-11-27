import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec, type RocketTree } from '@online-openrocket/engine';
import { engineTree, findNode, referenceArea, referenceRadius } from './treeModel.js';
import { num, numOpt } from './nodeNum.js';

const MOTOR: MotorSpec = {
  designation: 'Separation test', diameter: 0.024, length: 0.1,
  times: [0, 0.05, 1, 1.2], thrusts: [0, 30, 30, 0],
  masses: [0.1, 0.099, 0.075, 0.07], cgX: 0.05, ejectionDelay: 1000,
};

function design(kind: 'plate' | 'streamlined' | 'streamlinedbase' | 'fairing', staged = true): RocketTree {
  const body = (booster: boolean): ComponentNode => ({
    type: 'bodytube', id: booster ? 'booster-tube' : 'tube',
    length: booster ? 0.2 : 0.4, outerRadius: booster ? 0.05 : 0.025,
    thickness: 0.0005, density: 950,
    children: [
      // Zero drag fins keep this fixture's Cdf/Cdp/Cdb BODY-only. The carrier
      // ratio can then be checked from the flight's own recorded body buckets.
      { type: 'trapezoidfinset', finCount: 3, rootChord: 0.1, tipChord: 0.05,
        sweep: 0.03, height: 0.06, thickness: 0.002, crossSection: 'rounded', overrideCD: 0,
        position: { method: 'bottom', offset: 0 } },
      ...(booster || !staged ? [{ type: 'innertube', id: 'mount', motorMount: true,
        length: 0.1, outerRadius: 0.013, thickness: 0.0005,
        position: { method: 'bottom', offset: 0 } }] : []),
      ...(!booster ? [{
        type: kind === 'fairing' ? 'fairing' : 'protuberance', id: 'bump',
        name: 'Camera', width: 0.02, height: 0.01, length: 0.08, mass: 0,
        count: 1, dragClass: kind, fairingShape: 'streamlined', plateAngle: Math.PI / 2,
        position: { method: 'middle', offset: 0 },
      }] : []),
    ],
  } as unknown as ComponentNode);
  return { name: 'App separation', components: [
    { type: 'stage', id: 's', name: 'Sustainer', children: [
      { type: 'nosecone', length: 0.15, aftRadius: 0.025, thickness: 0.001, overrideMass: 0.1 }, body(false),
    ] },
    ...(staged ? [{ type: 'stage', id: 'b', name: 'Booster', separationEvent: 'burnout', children: [body(true)] }] : []),
  ] } as unknown as RocketTree;
}

describe('engineTree carries the design area into a staged flight', () => {
  it('uses a radius and preserves the exact area arithmetic, including the fallback', () => {
    const tiny = { name: 'tiny', components: [{ type: 'stage', children: [
      { type: 'bodytube', outerRadius: 0.0001 },
    ] }] } as unknown as RocketTree;
    for (const tree of [design('plate'), design('fairing', false), tiny, { name: 'empty', components: [] }]) {
      expect(Math.PI * referenceRadius(tree) ** 2).toBe(referenceArea(tree));
    }
    expect(referenceRadius(tiny)).toBe(0.005);
    const tree = design('plate');
    expect(referenceRadius(tree)).toBe(0.05);
    expect(findNode(engineTree(tree), 'bump')!['overrideCDReferenceRadius']).toBe(0.05);
  });

  it.each(['plate', 'streamlined', 'streamlinedbase', 'fairing'] as const)('preserves the generated %s area after separation', (kind) => {
    const tree = design(kind);
    const lowered = engineTree(tree);
    const carrier = findNode(lowered, 'bump')!;
    expect(carrier['overrideCDReferenceRadius']).toBe(0.05);
    const ratio = numOpt(carrier, 'overrideCDBodyRatio');
    if (kind !== 'plate') expect(ratio).toBeDefined();
    const rocket = OrkRocket.buildTree(lowered);
    rocket.setMotorById('mount', MOTOR);
    const result = rocket.simulate({ series: 'full', randomSeed: 7, windAverage: 0, windStdDeviation: 0 });
    expect(result.events.some(e => e.type === 'SIM_ABORT')).toBe(false);
    expect(result.events.some(e => e.type === 'STAGE_SEPARATION')).toBe(true);
    expect(result.branches).toHaveLength(2);
    const separation = result.events.find(e => e.type === 'STAGE_SEPARATION')!.time;
    const branch = result.branches!.find(b => b.name === 'Sustainer')!;
    const apogee = branch.events.find(e => e.type === 'APOGEE')!.time;
    // Only RK4/Barrowman rows have the body and generated override drag buckets.
    const end = Math.min(apogee, branch.events.find(e => e.type === 'TUMBLE')?.time ?? Infinity);
    const s = branch.series;
    let before = 0, after = 0;
    s.time.forEach((t, i) => {
      if (t >= end || Math.abs(t - separation) < 1e-6 || !Number.isFinite(s['Cd']![i])) return;
      expect(s['Ar']![i]! / (Math.PI * (t < separation ? 0.05 : 0.025) ** 2) - 1).toBeCloseTo(0, 12);
      const body = s['Cdf']![i]! + s['Cdp']![i]! + s['Cdb']![i]!;
      const override = s['Cd']![i]! - body;
      const refBody = body - (carrier['overrideCDBodyIncludesBase'] === false ? s['Cdb']![i]! : 0);
      const expected = (ratio === undefined ? num(carrier, 'overrideCD', 0) : ratio * refBody) * referenceArea(tree);
      expect(override * s['Ar']![i]! / expected - 1, `${kind} t=${t}`).toBeCloseTo(0, 10);
      if (t < separation) before++; else after++;
    });
    expect(before).toBeGreaterThan(5);
    expect(after).toBeGreaterThan(5);
  }, 60_000);

  it.each(['plate', 'streamlinedbase', 'fairing'] as const)('leaves every single-stage %s flight column bit-identical', (kind) => {
    const lowered = engineTree(design(kind, false));
    const without = structuredClone(lowered);
    delete findNode(without, 'bump')!['overrideCDReferenceRadius'];
    const fly = (tree: RocketTree) => {
      const rocket = OrkRocket.buildTree(tree);
      rocket.setMotorById('mount', MOTOR);
      return rocket.simulate({ series: 'full', randomSeed: 7, windAverage: 0, windStdDeviation: 0 }).series;
    };
    expect(fly(lowered)).toEqual(fly(without));
  }, 60_000);
});
