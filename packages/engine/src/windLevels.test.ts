import { describe, expect, it } from 'vitest';
import * as ork from '../vendor/orkengine.mjs';
import {
  OrkRocket, type MotorSpec, type RocketTree, type SimulationOptions, type WindLevel,
} from './orkEngine.js';

/**
 * WINDS ALOFT — desktop OpenRocket 24.12's multi-level wind model
 * (`MultiLevelPinkNoiseWindModel`) through `SimulationOptions.windLevels`
 * (kernel pass 2, 2026-09-22 audit). The class was carved on day one but nothing
 * constructed it, so TeaVM dead-code-eliminated it from the artifact: 0
 * occurrences in orkengine.mjs until the bridge (`api.OrkEngine.windModelFor`)
 * gave it a caller. Engine API only — no app control sets it yet.
 *
 * These are the BEHAVIOURAL guards: engine-java's difftest compares a JVM run
 * against a TeaVM run with no stored baseline, so it proves the two runtimes
 * agree, never that either one interpolates the right wind (LEDGER 2026-08-25b).
 * The before/after goldenJvm diff — every pre-existing line bit-identical — is in
 * the LEDGER entry.
 *
 * WHY THE PROFILE CAN BE CHECKED ROW BY ROW. The "Vw" series is the length of the
 * wind vector the stepper computed for that row, and every stepper computes it
 * from the SAME status it records the row's altitude from (RK4 and Euler both
 * call `status.storeData()` and then `calculateFlightConditions(status, …)` on
 * the step's start). With every level steady (σ = 0) a level's speed is its
 * average exactly — `average + noise × 0 / STDDEV` — so each row's wind is a pure
 * function of that row's altitude, and this file recomputes it with the kernel's
 * own interpolation (`Coordinate.interpolate`, per component).
 */

/** The goldens' C6 reference rocket (GoldenMain.conditionsScenarios): 24 mm, ~350 m. */
const REF: RocketTree = {
  name: 'Ref',
  components: [
    { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
    {
      type: 'bodytube', length: 0.30, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [
        { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
        { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true },
        { type: 'parachute', diameter: 0.30 },
      ],
    },
  ],
};

const C6: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.070,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.0240, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035, ejectionDelay: 5.0,
};

const HALF_PI = Math.PI / 2;

/**
 * The goldens' pad: 1,400 m, 303.15 K, 86 kPa, 5 degree rod, seed 7 — cut at 3 s,
 * about 150 m up and a second into the coast. Every flight on this pad is judged on
 * its ascent, and the cut keeps the file's TeaVM flights cheap: flown on to the 8 s
 * the goldens use, the same assertions cost several times as long.
 */
const PAD: SimulationOptions = {
  launchRodLength: 1.2, launchRodAngle: 0.087, launchAltitude: 1400,
  temperature: 303.15, pressure: 86000, randomSeed: 7, maxTime: 3, series: 'full',
};

function fly(options: SimulationOptions) {
  const rocket = OrkRocket.buildTree(REF);
  rocket.setMotorById('mount', C6);
  return rocket.simulate(options);
}

/** A series by symbol, nulls (NaN on the wire) kept as NaN so indices line up. */
function series(r: ReturnType<typeof fly>, symbol: string): number[] {
  const s = r.series[symbol];
  expect(s, `the kernel must emit "${symbol}" in full mode`).toBeTruthy();
  return s!.map((v) => (v == null ? Number.NaN : v));
}

/**
 * The kernel's wind vector at altitude `h` for steady levels: PinkNoiseWindModel's
 * `speed × (sin d, cos d, 0)`, held outside the levels and interpolated per
 * component between them, exactly as MultiLevelPinkNoiseWindModel.getWindVelocity
 * and Coordinate.interpolate spell it.
 */
function windAt(levels: readonly WindLevel[], h: number): { x: number; y: number } {
  const sorted = [...levels].sort((a, b) => a.altitude - b.altitude);
  const v = (l: WindLevel) => ({ x: l.speed * Math.sin(l.direction), y: l.speed * Math.cos(l.direction) });
  if (h <= sorted[0]!.altitude) return v(sorted[0]!);
  const top = sorted[sorted.length - 1]!;
  if (h >= top.altitude) return v(top);
  const i = sorted.findIndex((l) => l.altitude > h);
  const lo = sorted[i - 1]!;
  const hi = sorted[i]!;
  const f = (h - lo.altitude) / (hi.altitude - lo.altitude);
  const a = v(lo);
  const b = v(hi);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** The "Vw" the kernel must record at altitude `h`: the length of {@link windAt}. */
const speedAt = (levels: readonly WindLevel[], h: number) => {
  const w = windAt(levels, h);
  return Math.hypot(w.x, w.y);
};

describe('winds aloft (SimulationOptions.windLevels)', () => {
  it('is the single-level flight, bit for bit, with ONE level at the single-level wind', () => {
    // The lowest level is seeded with randomSeed itself, so one level carrying the
    // single-level model's speed, sigma and its default direction pi/2 draws the
    // very same turbulence. A single level is held at every altitude, so where it
    // sits does not matter; and windAverage / windStdDeviation are ignored once
    // levels are given (desktop ignores its average model the same way).
    const single = fly({ ...PAD, windAverage: 3.0, windStdDeviation: 0.6 });
    for (const altitude of [0, 5000]) {
      const one = fly({
        ...PAD, windAverage: 9.0, windStdDeviation: 2.0,
        windLevels: [{ altitude, speed: 3.0, direction: HALF_PI, standardDeviation: 0.6 }],
      });
      expect(one.summary).toEqual(single.summary);
      expect(one.series).toEqual(single.series);
    }
    // And the turbulence really is on in both — otherwise this compares two calm
    // flights and proves nothing about the seed.
    const vw = series(single, 'Vw').filter((v) => !Number.isNaN(v));
    expect(Math.max(...vw) - Math.min(...vw)).toBeGreaterThan(0.5);
    // An EMPTY list is no list: the single-level wind, windAverage and all.
    const empty = fly({ ...PAD, windAverage: 3.0, windStdDeviation: 0.6, windLevels: [] });
    expect(empty.series).toEqual(single.series);
  });

  it('interpolates the wind VECTOR linearly in altitude and holds it outside the levels', () => {
    // Sea-level pad, so MSL is the rocket's own altitude, and flown to the ground so
    // the descent crosses every level again. 2 m/s from the east at the
    // pad, 8 m/s from the east at 100 m, 8 m/s from the WEST at 250 m: between 100
    // and 250 m the vector swings through zero at 175 m, where a scheme that
    // interpolated speed and direction separately would still read 8 m/s.
    const levels: WindLevel[] = [
      { altitude: 0, speed: 2.0, direction: HALF_PI },
      { altitude: 100, speed: 8.0, direction: HALF_PI },
      { altitude: 250, speed: 8.0, direction: 3 * HALF_PI },
    ];
    const r = fly({ launchRodLength: 1.2, randomSeed: 7, series: 'full', windLevels: levels });
    const h = r.series.altitude;
    const vw = series(r, 'Vw');
    const dir = series(r, 'θw');
    const rows = h.map((_v, i) => i).filter((i) => !Number.isNaN(vw[i]!));

    // The flight must actually visit every regime, or a row check proves little.
    expect(rows.filter((i) => h[i]! < 100).length).toBeGreaterThan(20);
    expect(rows.filter((i) => h[i]! > 100 && h[i]! < 250).length).toBeGreaterThan(20);
    expect(rows.filter((i) => h[i]! > 250).length).toBeGreaterThan(20);

    for (const i of rows) expect(vw[i]).toBeCloseTo(speedAt(levels, h[i]!), 9);
    // Direction held on each side of the swing: from the east low, from the west high.
    for (const i of rows.filter((j) => h[j]! < 90)) expect(dir[i]).toBeCloseTo(HALF_PI, 9);
    for (const i of rows.filter((j) => h[j]! > 260)) expect(dir[i]).toBeCloseTo(3 * HALF_PI, 9);
    // The swing itself: near 175 m the wind all but vanishes.
    const nearNull = rows.filter((i) => Math.abs(h[i]! - 175) < 5).map((i) => vw[i]!);
    expect(nearNull.length).toBeGreaterThan(0);
    expect(Math.max(...nearNull)).toBeLessThan(0.6);
  });

  it('measures the levels from sea level by default, and from the pad under AGL', () => {
    // A 1,400 m pad under a profile that is calm at 0 m and 4 m/s at 100 m.
    const levels: WindLevel[] = [
      { altitude: 0, speed: 0, direction: HALF_PI },
      { altitude: 100, speed: 4.0, direction: HALF_PI },
    ];
    const msl = fly({ ...PAD, windLevels: levels });
    const explicit = fly({ ...PAD, windLevels: levels, windAltitudeReference: 'MSL' });
    const agl = fly({ ...PAD, windLevels: levels, windAltitudeReference: 'AGL' });

    expect(explicit.series).toEqual(msl.series);

    // MSL: the whole flight is above the top level, so a steady 4 m/s throughout.
    for (const v of series(msl, 'Vw').filter((x) => !Number.isNaN(x))) {
      expect(v).toBeCloseTo(4.0, 12);
    }
    // AGL: calm on the pad, building with height above it.
    const h = agl.series.altitude;
    const vw = series(agl, 'Vw');
    expect(vw[0]).toBeCloseTo(0, 12);
    h.forEach((alt, i) => {
      if (!Number.isNaN(vw[i]!)) expect(vw[i]).toBeCloseTo(speedAt(levels, alt), 9);
    });
    expect(Math.max(...vw.filter((v) => !Number.isNaN(v)))).toBeGreaterThan(3.9);
    expect(agl.summary.maxAltitude).not.toBe(msl.summary.maxAltitude);
  });

  it('sorts the levels before seeding them, so their order in the list does not matter', () => {
    // Seeds are assigned by altitude rank, never by list position: the same
    // profile written top-down is the same flight, turbulence included. Three
    // turbulent, veering levels at 0, 50 and 100 m above the 1,400 m pad, all
    // of which the rocket passes inside the 3 s cut.
    const levels: WindLevel[] = [
      { altitude: 1400, speed: 1.0, direction: HALF_PI, standardDeviation: 0.2 },
      { altitude: 1450, speed: 6.0, direction: 2.0, standardDeviation: 0.8 },
      { altitude: 1500, speed: 12.0, direction: Math.PI, standardDeviation: 1.5 },
    ];
    const up = fly({ ...PAD, windLevels: levels });
    const down = fly({ ...PAD, windLevels: [...levels].reverse() });
    expect(Math.max(...up.series.altitude)).toBeGreaterThan(110);
    expect(down.series).toEqual(up.series);
  });

  it('gives every level a turbulence stream of its own, seeded from randomSeed', () => {
    const gust = { speed: 3.0, direction: HALF_PI, standardDeviation: 0.6 };
    const single = fly({ ...PAD, windAverage: 3.0, windStdDeviation: 0.6 });
    // Two identical levels bracketing the flight (0 m and 5,000 m MSL): the wind is
    // a blend of their two streams. Were both seeded alike, the blend would BE the
    // single-level stream.
    const two = { ...PAD, windLevels: [{ altitude: 0, ...gust }, { altitude: 5000, ...gust }] };
    const a = fly(two);
    expect(series(a, 'Vw')).not.toEqual(series(single, 'Vw'));
    // Reproducible for a seed, and moved by another seed — desktop, which seeds
    // every level from new Random(), is neither.
    expect(fly(two).series).toEqual(a.series);
    expect(series(fly({ ...two, randomSeed: 8 }), 'Vw')).not.toEqual(series(a, 'Vw'));
  });

  it('refuses a level it cannot fly, naming it, before the kernel sees it', () => {
    const rocket = OrkRocket.buildTree(REF);
    rocket.setMotorById('mount', C6);
    const at = (i: number, patch: Partial<WindLevel>) => {
      const levels: WindLevel[] = [
        { altitude: 0, speed: 2, direction: HALF_PI },
        { altitude: 100, speed: 5, direction: HALF_PI },
      ];
      levels[i] = { ...levels[i]!, ...patch };
      return () => rocket.simulate({ windLevels: levels });
    };
    expect(at(0, { altitude: Number.NaN })).toThrow(/Wind level 1: .*finite/);
    expect(at(1, { direction: Number.POSITIVE_INFINITY })).toThrow(/Wind level 2: .*finite/);
    expect(at(1, { standardDeviation: Number.NaN })).toThrow(/Wind level 2: .*finite/);
    expect(at(1, { speed: -1 })).toThrow(/Wind level 2: .*cannot be negative/);
    expect(at(0, { standardDeviation: -0.1 })).toThrow(/Wind level 1: .*cannot be negative/);
    expect(at(1, { altitude: 0 })).toThrow(/Wind level 2: another level is already at 0 m/);
    expect(() => rocket.simulate({
      windLevels: [{ altitude: 0, speed: 2, direction: 0 }],
      windAltitudeReference: 'agl' as 'AGL',
    })).toThrow(/windAltitudeReference must be 'MSL' or 'AGL'/);
  });

  it('is refused by the kernel too, for a caller that goes around the wrapper', () => {
    // The raw bridge is what the harness and any non-TypeScript caller reach. A
    // missing number must not fly as a default, and a malformed list must not fly
    // as a shorter one.
    const h = ork.buildRocket(JSON.stringify(REF));
    ork.setMotorById(h, 'mount', C6.designation, C6.diameter, C6.length,
      C6.times, C6.thrusts, C6.masses, C6.cgX, C6.ejectionDelay);
    const sim = (extra: Record<string, unknown>) => () => ork.simulateJson(h, JSON.stringify(extra));
    expect(sim({ windLevels: [{ altitude: 0, speed: 3 }] })).toThrow(/windLevels\[0\]: .*finite/);
    expect(sim({ windLevels: [{ altitude: 0, speed: 3, direction: 0 }, 7] }))
      .toThrow(/every level must be an object/);
    expect(sim({ windLevels: [{ altitude: 0, speed: 3, direction: 0 }], windAltitudeReference: 'agl' }))
      .toThrow(/windAltitudeReference must be "MSL" or "AGL"/);
    // Upstream's own check, reached through the seeded overload.
    expect(sim({ windLevels: [{ altitude: 50, speed: 3, direction: 0 }, { altitude: 50, speed: 4, direction: 0 }] }))
      .toThrow(/Wind level already exists for altitude: 50/);
  });
});
