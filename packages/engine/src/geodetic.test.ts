import { describe, expect, it } from 'vitest';
import {
  OrkRocket, resetEngine, type ComponentNode, type FlightResult, type MotorSpec, type RocketTree, type SimulationOptions,
} from './orkEngine.js';

/**
 * THE GEODETIC MODEL (board Tier 1 row 2, GS1): `geodeticMethod`, desktop
 * OpenRocket's "Geodetic calculations" option. Until it existed the bridge
 * forced SPHERICAL on every flight (OrkEngine.simulateJson), so a desktop file
 * that flew FLAT — every file desktop opens without naming a method — gained a
 * Coriolis term here, and a WGS84 one lost its ellipsoid. These are the claims
 * the app's selector and its .ork import rest on, held against the real kernel:
 *
 *  - sending nothing and sending 'spherical' are the same flight, byte for
 *    byte, so every design flown before the option is untouched;
 *  - 'flat' really drops Coriolis: in the northern AND southern hemisphere a
 *    rising body is deflected WEST (the vertical-velocity term,
 *    −2Ω·v_up·cos φ, is negative at either latitude sign), and a vertical
 *    flight in still air stops landing west of the pad;
 *  - on a long flight the two part by metres downrange and by centimetres at
 *    apogee;
 *  - 'wgs84' flies the spherical trajectory (the same Coriolis formula) and
 *    places it on the ellipsoid: the reported longitude offset shrinks by the
 *    ratio of the sphere's radius to the ellipsoid's prime-vertical radius.
 *
 * Bounds, never exact kernel floats (CI runs Node 22, the desktop 24). The
 * measured values, for scale (2026-10-01, this kernel): the reference C6 lands
 * 0.147 m west of its flat-Earth twin; the 2 km J flight 1.99 m west in still
 * air and 1.93 m apart off a 5° rod in 4 m/s, with apogees 0.6 mm and 14.7 mm
 * apart; WGS84 is within 2.2e-7 m of spherical on the ground.
 *
 * That last figure is THIS flight's, not a bound for WGS84. The two models share
 * every formula, but each places the rocket at its own latitude, which the
 * Coriolis term and the gravity model read, and a flight can amplify that minute
 * difference: a tester's desktop file (ninja_4in_54mm-MMT.ork, to 2.2 km),
 * opened and flown through the app, parts by 1.4 cm at apogee and 1.1 cm on the
 * ground in still air, and by 3 mm and 6.3 cm in its own wind with the gusts
 * off. Gusts are not what parts them.
 */

/** The reference C6 and "Chuted" rocket the app's kernel tests fly (simReport.kernel.test.ts). */
const C6: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035, ejectionDelay: 5.0,
};
const CHUTED: RocketTree = {
  name: 'Chuted',
  components: [
    { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' } as ComponentNode,
    {
      type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [
        { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
        { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true },
        { type: 'parachute', diameter: 0.3 } as ComponentNode,
      ],
    } as ComponentNode,
  ],
};

/**
 * A LONG flight: a 54 mm, 1.5 m rocket on a synthetic 1,000 N·s J that goes to
 * about 2 km and comes down under a 1.2 m chute opened near apogee — some 390 s
 * in the air, long enough for the Coriolis term to move the landing by metres.
 * Under a chute, not ballistic: a finned rocket with no recovery noses over
 * after apogee and glides wherever the last bits of its attitude send it, and a
 * ballistic C6 measured hundreds of metres from the pad in still air — a chaotic
 * landing says nothing about the Earth model.
 */
const J: MotorSpec = {
  designation: 'J500', diameter: 0.054, length: 0.4,
  times: [0, 0.05, 1.0, 1.9, 2.0],
  thrusts: [0, 550, 500, 450, 0],
  masses: [1.2, 1.19, 0.9, 0.62, 0.6],
  cgX: 0.2, ejectionDelay: 16,
};
const LONG: RocketTree = {
  name: 'Long',
  components: [
    { type: 'nosecone', length: 0.3, aftRadius: 0.0285, thickness: 0.003, shape: 'ogive' } as ComponentNode,
    {
      type: 'bodytube', length: 1.2, outerRadius: 0.0285, thickness: 0.0015, density: 1850,
      children: [
        { type: 'trapezoidfinset', finCount: 3, rootChord: 0.15, tipChord: 0.06, sweep: 0.08, height: 0.08, thickness: 0.004 },
        { type: 'innertube', id: 'mount', length: 0.4, outerRadius: 0.028, thickness: 0.001, motorMount: true },
        { type: 'parachute', diameter: 1.2 } as ComponentNode,
      ],
    } as ComponentNode,
  ],
};

function fly(tree: RocketTree, motor: MotorSpec, options: SimulationOptions): FlightResult {
  resetEngine();
  const r = OrkRocket.buildTree(tree);
  r.setMotorById('mount', motor);
  return r.simulate({ randomSeed: 42, series: 'full', ...options });
}

/** Where the flight came down: east (Px) and north (Py) of the pad (m), and as latitude and longitude (°). */
function landing(f: FlightResult): { x: number; y: number; lat: number; lon: number } {
  const last = (key: string): number => {
    const s = f.series[key];
    const v = s?.[s.length - 1];
    if (typeof v !== 'number') throw new Error(`no ${key} series`);
    return v;
  };
  return { x: last('Px'), y: last('Py'), lat: last('φ'), lon: last('λ') };
}

const VERTICAL_CALM = { launchRodLength: 1, windAverage: 0, windStdDeviation: 0 };
const LONG_TILTED = {
  launchRodLength: 2, launchRodAngle: (5 * Math.PI) / 180, windAverage: 4, windStdDeviation: 0,
};

describe('geodeticMethod reaches the kernel', () => {
  it('flies its default, spherical, byte-identically to not sending it', () => {
    const o = { launchRodLength: 1, launchRodAngle: (5 * Math.PI) / 180, windAverage: 4, windStdDeviation: 1 };
    expect(JSON.stringify(fly(CHUTED, C6, { ...o, geodeticMethod: 'spherical' })))
      .toBe(JSON.stringify(fly(CHUTED, C6, o)));
  }, 60000);

  it('flat drops the Coriolis term: a vertical flight in still air stops landing west of the pad', () => {
    const lat = (launchLatitude: number) => {
      const sphere = landing(fly(CHUTED, C6, { ...VERTICAL_CALM, launchLatitude }));
      const flat = landing(fly(CHUTED, C6, { ...VERTICAL_CALM, launchLatitude, geodeticMethod: 'flat' }));
      return sphere.x - flat.x;
    };
    // West in both hemispheres: the rising leg's deflection, −2Ω·v_up·cos φ.
    // Measured −0.147 m at the kernel's default 28.61° N.
    expect(lat(28.61)).toBeLessThan(-0.1);
    expect(lat(-35)).toBeLessThan(-0.05);
  }, 60000);

  it('flat and spherical part by metres downrange and by centimetres at apogee on a long flight', () => {
    const sphere = fly(LONG, J, LONG_TILTED);
    const flat = fly(LONG, J, { ...LONG_TILTED, geodeticMethod: 'flat' });
    const s = landing(sphere);
    const f = landing(flat);
    // Over a kilometre downrange either way, and some 2 m apart (1.93 measured).
    expect(Math.hypot(s.x, s.y)).toBeGreaterThan(1000);
    const apart = Math.hypot(s.x - f.x, s.y - f.y);
    expect(apart).toBeGreaterThan(1);
    expect(apart).toBeLessThan(5);
    // Apogee near 2 km moves by centimetres at most (14.7 mm measured).
    expect(sphere.summary.maxAltitude).toBeGreaterThan(1500);
    expect(Math.abs(sphere.summary.maxAltitude - flat.summary.maxAltitude)).toBeLessThan(0.05);
  }, 120000);

  it('wgs84 flies the spherical trajectory and reports it on the ellipsoid', () => {
    const sphere = landing(fly(LONG, J, LONG_TILTED));
    const ellipsoid = landing(fly(LONG, J, { ...LONG_TILTED, geodeticMethod: 'wgs84' }));
    // The same Coriolis formula: on the ground they agree to well under a millimetre.
    expect(Math.abs(ellipsoid.x - sphere.x)).toBeLessThan(1e-4);
    expect(Math.abs(ellipsoid.y - sphere.y)).toBeLessThan(1e-4);
    // But the longitude the flight data reports is the ellipsoid's: an east
    // offset d spans d / (R cos φ) on the kernel's sphere and d / (N cos φ) on
    // WGS84, N the prime-vertical radius, so the two offsets stand in the ratio
    // R / N (0.99811 at the kernel's default 28.61° N).
    const a = 6378137;
    const f = 1 / 298.25722210088;
    const e2 = f * (2 - f);
    const sinLat = Math.sin((28.61 * Math.PI) / 180);
    const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const ratio = (ellipsoid.lon - -80.6) / (sphere.lon - -80.6);
    expect(ratio).toBeCloseTo(6371000 / n, 4);
    expect(ratio).not.toBeCloseTo(1, 4);
  }, 120000);

  it('refuses a method it does not know, by name', () => {
    resetEngine();
    const r = OrkRocket.buildTree(CHUTED);
    r.setMotorById('mount', C6);
    expect(() => r.simulate({ geodeticMethod: 'ellipsoid' as never }))
      .toThrow("geodeticMethod must be 'flat', 'spherical' or 'wgs84', not 'ellipsoid'.");
  });
});
