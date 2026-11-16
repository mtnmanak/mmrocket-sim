import { describe, expect, it } from 'vitest';
import { OrkRocket, type MotorSpec, type RocketTree } from './orkEngine.js';

// Real shipped TeaVM artifact; rounded freeform fins exercise the owner's usual path.
const tree: RocketTree = { name: 'N052 recorded diagnostics', components: [
  { type: 'nosecone', shape: 'ogive', length: 0.07, aftRadius: 0.012, thickness: 0.002, overrideMass: 0.03 },
  { type: 'bodytube', length: 0.30, outerRadius: 0.012, thickness: 0.0003, density: 950, children: [
    { type: 'freeformfinset', finCount: 3, rotation: 0.2,
      points: [[0, 0], [0.02, 0.03], [0.05, 0.03], [0.05, 0]], thickness: 0.003, crossSection: 'rounded' },
    { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005,
      motorMount: true, position: { method: 'bottom', offset: 0 } },
  ] },
] };
const times = [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2];
const motor: MotorSpec = {
  designation: 'T2', diameter: 0.018, length: 0.07, times,
  thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
  masses: times.map(t => 0.024 - 0.0108 * t / 2), cgX: 0.035, ejectionDelay: 1000,
};
const options = { launchRodLength: 1, guideAllowance: false, windAverage: 0,
  windStdDeviation: 0, randomSeed: 0x3183, timeStep: 0.01, maxTime: 1.8 };

function rocket(input = tree): OrkRocket {
  const r = OrkRocket.buildTree(input);
  r.setMotorById('mount', motor);
  return r;
}
function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

describe('N052 normal-force slope and signed corrective moment bridge', () => {
  it('records full-length series, guide sentinels and the same stiffness as natural frequency', () => {
    const result = rocket().simulate({ ...options, series: 'full' });
    expect(result.events.some(e => e.type === 'SIM_ABORT')).toBe(false);
    const s = result.series;
    for (const key of ['CNα', 'Ccm']) expect(s[key]).toHaveLength(s.time.length);
    const guideExit = result.events.find(e => e.type === 'LAUNCHROD');
    expect(guideExit).toBeDefined();
    let guide = 0, ascent = 0, positiveOmega = 0;
    s.time.forEach((time, i) => {
      if (time < guideExit!.time) {
        guide++;
        expect(s.Ccm![i]).toBe(0); // Exact guide sentinel, not a kernel float golden.
        expect(finite(s['CNα']![i])).toBe(false);
      } else if (finite(s.Vz?.[i]) && s.Vz![i]! > 0) {
        ascent++;
        expect(finite(s['CNα']![i])).toBe(true);
        expect(s['CNα']![i]).toBeGreaterThan(0);
      }
      const omega = s['ωn']?.[i];
      if (!finite(omega) || omega <= 0) return;
      positiveOmega++;
      const ratio = s.Ccm![i]! / s.Il![i]!;
      expect(finite(ratio)).toBe(true);
      expect(Math.abs(ratio - omega * omega) / (omega * omega)).toBeLessThanOrEqual(1e-12);
    });
    expect(guide).toBeGreaterThan(0);
    expect(ascent).toBeGreaterThan(20);
    expect(positiveOmega).toBeGreaterThan(20);
  }, 60_000);

  it('keeps both diagnostics out of summary payloads', () => {
    const s = rocket().simulate({ ...options, series: 'summary' }).series;
    expect(s.time.length).toBeGreaterThan(20);
    expect(s['CNα']).toBeUndefined();
    expect(s.Ccm).toBeUndefined();
  }, 60_000);

  it('retains negative moments on ascent with CP ahead of CG and natural frequency blank', () => {
    const tailHeavy = structuredClone(tree);
    tailHeavy.components[0]!.overrideMass = 0.001;
    tailHeavy.components[1]!.children = tailHeavy.components[1]!.children!.filter(c => c.type !== 'freeformfinset');
    const result = rocket(tailHeavy).simulate({ ...options, series: 'full' });
    const s = result.series;
    const exit = result.events.find(e => e.type === 'LAUNCHROD');
    expect(exit).toBeDefined();
    const rows = s.time.flatMap((t, i) => t > exit!.time && finite(s.Vz?.[i]) && s.Vz![i]! > 0
      && finite(s.cpLocation[i]) && finite(s.cgLocation[i]) && s.cpLocation[i]! < s.cgLocation[i]! ? [i] : []);
    expect(rows.length).toBeGreaterThan(0);
    for (const i of rows) {
      expect(s['CNα']![i]).toBeGreaterThan(0);
      expect(s.Ccm![i]).toBeLessThan(0);
      expect(finite(s['ωn']?.[i])).toBe(false);
    }
  }, 60_000);
});
