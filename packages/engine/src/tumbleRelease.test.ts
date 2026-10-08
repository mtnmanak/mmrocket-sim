import { describe, expect, it } from 'vitest';
import { OrkRocket, type MotorSpec, type RocketTree } from './orkEngine.js';

// Real TeaVM artifact, classic Barrowman, three rounded uncanted fins. Clock
// them away from a single fin's zero-weight normalization plane (as in the CP test).
const tree: RocketTree = { name: 'Tumble release series control', components: [
  { type: 'nosecone', shape: 'ogive', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
  { type: 'bodytube', length: 0.30, outerRadius: 0.012, thickness: 0.0003, density: 950, children: [
    { type: 'trapezoidfinset', finCount: 3, rotation: 0.2, rootChord: 0.05, tipChord: 0.03,
      sweep: 0.02, height: 0.03, thickness: 0.003, crossSection: 'rounded' },
    { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005,
      motorMount: true, position: { method: 'bottom', offset: 0 } },
  ] },
] };
const times = [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2];
const motor: MotorSpec = {
  designation: 'T2', diameter: 0.018, length: 0.07, times,
  thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
  masses: times.map((t) => 0.024 - 0.0108 * t / 2), cgX: 0.035, ejectionDelay: 1000,
};
const options = { launchRodLength: 1, guideAllowance: false, windAverage: 0,
  windStdDeviation: 0, randomSeed: 0x3183, timeStep: 0.01, maxTime: 1.8 };

function rocket(input = tree): OrkRocket {
  const r = OrkRocket.buildTree(input);
  r.setMotorById('mount', motor);
  return r;
}

// A 30 g nose (override) gives a clear positive restoring arm; the bare tree's
// static margin is within about a millimetre of zero, so its post-rail omega is
// small or undefined and would make a weak oracle.
function ballasted(): RocketTree {
  const input = structuredClone(tree);
  input.components[0]!.overrideMass = 0.03;
  return input;
}

function finite(value: number | null | undefined): number {
  expect(typeof value).toBe('number');
  expect(Number.isFinite(value)).toBe(true);
  return value as number;
}

describe('tumble release real-kernel bridge contract', () => {
  it('exports full-length angular frequency, rail zero and a recorded-field oracle', () => {
    // Mutations: missing producer/catalog/bridge series, use roll inertia,
    // omit sqrt, convert rad/s to Hz, use stale rather than recorded inputs.
    const r = rocket(ballasted());
    const result = r.simulate({ ...options, series: 'full' });
    expect(result.events.some((event) => event.type === 'SIM_ABORT')).toBe(false);
    const s = result.series;
    const omega = s['\u03c9n'];
    expect(omega).toBeDefined();
    expect(omega!.length).toBe(s.time.length);
    expect(s['tc']).toBeUndefined(); // Computation time is wall-clock noise, never full-series data.
    const rail = result.events.find((event) => event.type === 'LAUNCHROD');
    expect(rail).toBeDefined();
    const ascent: number[] = [];
    let railRows = 0;
    s.time.forEach((time, i) => {
      if (time < rail!.time) {
        expect(finite(omega![i])).toBe(0); // Exact rail sentinel, not a kernel floating-point golden.
        railRows++;
      } else if (finite(s['Vz']![i]) > 0) ascent.push(i);
    });
    expect(railRows).toBeGreaterThan(0);
    expect(ascent.length).toBeGreaterThanOrEqual(20);
    const positive = ascent.filter((i) => typeof omega![i] === 'number' && Number.isFinite(omega![i]) && omega![i]! > 0);
    expect(positive.length / ascent.length).toBeGreaterThan(0.9);
    // Representative early/middle/late ASCENT rows; no zero/NaN oracle can pass.
    for (const i of [positive[0]!, positive[Math.floor(positive.length / 2)]!, positive[positive.length - 1]!]) {
      const actual = finite(omega![i]);
      expect(actual).toBeGreaterThan(1);
      const mach = finite(s.mach[i]);
      const cna = finite(r.aeroDiagnostics(mach, finite(s.aoa[i])).cp[3]);
      const v = mach * finite(s['Vs']![i]);
      const expected = Math.sqrt(0.5 * finite(s['\u03c1']![i]) * v * v * finite(s['Ar']![i]) * cna
        * (finite(s.cpLocation[i]) - finite(s.cgLocation[i])) / finite(s['Il']![i]));
      // Diagnostics recomputes CNa at default theta/rates; the symmetric fixture
      // removes material theta dependence. Allow independent-path roundoff and
      // Node 22/24 last-bit differences, not a change of physical units.
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 + 1e-6 * Math.abs(expected));
    }
  }, 60000);

  it('keeps natural frequency and computation time out of summary mode', () => {
    // Mutation: leak the new full-series symbol (or wall-clock tc) into summary payloads.
    const result = rocket().simulate({ ...options, series: 'summary' });
    expect(result.series.time.length).toBeGreaterThan(20);
    expect(result.series['\u03c9n']).toBeUndefined();
    expect(result.series['tc']).toBeUndefined();
  }, 60000);

  it('exports a deterministic wind-layer LargeAOA warning at LOW priority', () => {
    // Mutation: restore NORMAL priority in Warning.LargeAOA. The bridge exposes
    // wind levels but no AOA listener. A late wind layer causes high AOA after
    // the rail-clearance warning delay, with a heavier nose to keep it stable.
    const result = rocket(ballasted()).simulate({ ...options, maxTime: 2, series: 'full',
      windAltitudeReference: 'AGL', windLevels: [
        { altitude: 0, speed: 0, direction: Math.PI / 2, standardDeviation: 0 },
        { altitude: 20, speed: 0, direction: Math.PI / 2, standardDeviation: 0 },
        { altitude: 21, speed: 25, direction: Math.PI / 2, standardDeviation: 0 },
      ] });
    const warnings = result.warnings?.filter((warning) => warning.key === 'LargeAOA') ?? [];
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) expect(warning.priority).toBe('LOW');
  }, 60000);
});
