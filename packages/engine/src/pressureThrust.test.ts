import { describe, expect, it } from 'vitest';
import { OrkRocket, type MotorSpec, type RocketTree } from './orkEngine.js';

/**
 * RASAero PRESSURE THRUST — F(h) = F_curve(t) + A_exit x (P_ref - P(h)), added once
 * per thrusting stage in the kernel's RK4SimulationStepper.calculateThrust (see
 * engine-java/patches/LEDGER.md, feature #5, and
 * docs/research/thrust-with-altitude-2026-09-08.md).
 *
 * These are the BEHAVIOURAL guards. engine-java's goldens cannot be: difftest
 * compares a JVM run against a TeaVM run with no stored baseline, so a change that
 * moved both runtimes together — dropping a gate, crediting a cluster N times,
 * charging a booster's nozzle to the sustainer — passes it (LEDGER, 2026-08-25b).
 *
 * WHY THE FORMULA CAN BE ASSERTED TO THE BIT. The plateau of CONST_MOTOR is 32 N, a
 * POWER OF TWO, and that is not decoration. ThrustCurveMotor.interpolateAtIndex
 * reconstructs a value between two knots as `lower*(1-frac) + upper*frac`; with
 * lower == upper == F and F a power of two both products are exact, and
 * `fl(1-frac) + frac` rounds to exactly 1.0 for every frac in (0,1) (its error is
 * bounded by half an ulp of the subtraction, which is under half an ulp of 1), so
 * the curve returns EXACTLY 32.0 anywhere on the plateau. A non-dyadic plateau
 * would wobble by an ulp and this file would have to assert approximately.
 *
 * The assertions are therefore on the TOTAL, `curve + term`, never on the
 * difference `thrust - curve`: the kernel stores one rounded sum, and near the pad
 * the term is 1e-4 N against a 32 N curve, so differencing it back out costs up to
 * half an ulp of the SUM (7e-15 N) — thousands of ulps of the term. Comparing the
 * sums reproduces the kernel's own arithmetic exactly, `0 + curve` then `+= term`.
 */

/** The kernel's reference pressure (RK4SimulationStepper.PRESSURE_THRUST_REFERENCE_PRESSURE). */
const P_REF = 101325.0;

/**
 * Exit area exactly as the kernel spells it — `Math.PI * pow2(d / 2.0)`, evaluated
 * left to right. Written as the same expression rather than `Math.PI * (d/2)**2`
 * so the comparison cannot fail on an association difference instead of on physics.
 */
const exitArea = (d: number) => Math.PI * ((d / 2) * (d / 2));

/** The term the kernel must add, in the kernel's own multiplication order. */
const pressureTerm = (d: number, pressurePa: number) => exitArea(d) * (P_REF - pressurePa);

/**
 * A 32 N plateau between 0.001 s and 3.999 s. The leading and trailing zeros make
 * the "no term before ignition / after burnout" cases readable: the curve itself is
 * 0 there, so any term that appears is the bug being hunted.
 */
const PLATEAU_N = 32.0;
const CONST_MOTOR: MotorSpec = {
  designation: 'CONST32',
  diameter: 0.029,
  length: 0.2,
  times: [0, 0.001, 3.999, 4.0],
  thrusts: [0, PLATEAU_N, PLATEAU_N, 0],
  masses: [0.35, 0.3499, 0.1501, 0.15],
  cgX: 0.1,
  ejectionDelay: 8.0,
};

/** 29 mm airframe, ~1.5 kg, flies to a few hundred metres on the 128 N-s plateau. */
const oneStage = (nozzleExitDiameter: number): RocketTree => ({
  name: 'PThrust',
  components: [{
    type: 'stage', name: 'S', nozzleExitDiameter,
    children: [
      { type: 'nosecone', length: 0.2, aftRadius: 0.029, thickness: 0.002 },
      {
        type: 'bodytube', length: 0.8, outerRadius: 0.029, thickness: 0.001, density: 950,
        children: [
          { type: 'trapezoidfinset', finCount: 3, rootChord: 0.12, tipChord: 0.06, sweep: 0.06, height: 0.07, thickness: 0.003 },
          {
            type: 'innertube', id: 'mount', length: 0.2, outerRadius: 0.0155, thickness: 0.0005,
            motorMount: true, position: { method: 'bottom', offset: 0 },
          },
          { type: 'parachute', diameter: 0.6 },
        ],
      },
    ],
  }],
});

type Model = 'classic' | 'kbf' | 'supersonic';

interface Flown {
  time: number[];
  thrust: number[];
  pressure: number[];
  altitude: number[];
  apogee: number;
}

/** Flies `tree` in `model` and returns the series the pressure term is judged on. */
function fly(tree: RocketTree, model: Model, options: Record<string, unknown> = {},
             motor: MotorSpec = CONST_MOTOR, mountId = 'mount'): Flown {
  const rocket = OrkRocket.buildTree(tree);
  rocket.setMotorById(mountId, motor);
  if (model === 'kbf') rocket.setRogersModifiedBarrowman(true);
  if (model === 'supersonic') rocket.setSupersonicAero(true);
  // 'full' is what carries the "P" (air pressure) series, and P is the whole point:
  // it is read out of the SAME DataStore, at the same RK4 sub-step, that produced
  // the thrust value beside it, so the identity below is exact rather than nearly.
  const r = rocket.simulate({ launchRodLength: 1.0, series: 'full', ...options });
  const pressure = r.series['P'];
  expect(pressure, 'the kernel must emit the P (air pressure) series in full mode').toBeTruthy();
  return {
    time: r.series.time,
    thrust: r.series.thrust,
    pressure: pressure!.map((p) => p as number),
    altitude: r.series.altitude,
    apogee: r.summary.maxAltitude,
  };
}

/** Row indices where the motor is on the plateau (the only rows carrying a term). */
const plateauRows = (f: Flown) =>
  f.time.map((_t, i) => i).filter((i) => f.time[i]! > 0.05 && f.time[i]! < 3.9);

describe('RASAero pressure thrust (kernel feature #5)', () => {
  it('adds exactly A_exit x (101325 - P(h)) to the curve, at every altitude in a burn', () => {
    const d = 0.02;
    for (const model of ['kbf', 'supersonic'] as const) {
      const f = fly(oneStage(d), model);
      const rows = plateauRows(f);
      expect(rows.length).toBeGreaterThan(30);

      // The burn must actually sweep a useful pressure range, or this asserts a
      // constant and proves nothing about the SLOPE, which is the whole feature.
      const deficits = rows.map((i) => P_REF - f.pressure[i]!);
      expect(Math.min(...deficits)).toBeLessThan(200);        // still near the pad
      expect(Math.max(...deficits)).toBeGreaterThan(3000);    // ~300 m up, a 20x span

      for (const i of rows) {
        // Bit-exact: the kernel's `thrust = 0; thrust += 32.0; thrust += term`,
        // reproduced here as the same sum. See the file header on why this is the
        // total and not the difference.
        expect(f.thrust[i]).toBe(PLATEAU_N + pressureTerm(d, f.pressure[i]!));
      }
      // The term is genuinely doing something: it must exceed a newton somewhere
      // in this burn, not merely survive at the level of a rounding.
      expect(Math.max(...rows.map((i) => f.thrust[i]! - PLATEAU_N))).toBeGreaterThan(1);
    }
  });

  it('approaches the vacuum limit A_exit x 101325', () => {
    // An 80 km "pad" is inside ExtendedISAModel's 84,852 m ceiling and puts the
    // ambient pressure near 1 Pa, so the term is within 0.002 % of its vacuum
    // value. maxTime keeps it to the boost; nothing here depends on the trajectory.
    const d = 0.02;
    const f = fly(oneStage(d), 'kbf', { launchAltitude: 80000, maxTime: 3 });
    const rows = plateauRows(f);
    expect(rows.length).toBeGreaterThan(5);

    const vacuum = exitArea(d) * P_REF;
    for (const i of rows) {
      expect(f.thrust[i]).toBe(PLATEAU_N + pressureTerm(d, f.pressure[i]!));
    }
    const last = rows[rows.length - 1]!;
    expect(f.pressure[last]!).toBeLessThan(1);                     // 0.81 Pa at 80 km
    // 31.83 N for a 20 mm exit — the vacuum ceiling, approached from below. The
    // differenced term is only good to ~7e-15 N here (see the header), so this one
    // is deliberately a closeness, unlike the sums above.
    expect(f.thrust[last]! - PLATEAU_N).toBeCloseTo(vacuum, 3);
    expect(f.thrust[last]! - PLATEAU_N).toBeLessThan(vacuum);      // never exceeds it
  });

  it('is exactly zero before ignition and after burnout, even on a high pad', () => {
    // 2,000 m of standard ISA is a ~22 kPa deficit, so an ungated term would put
    // 6.9 N on the pad and 6.9 N on the whole coast for this 20 mm exit. Both must
    // read a bit-exact zero: the gate is the motor's own CURVE thrust being above
    // zero, the same predicate the base-drag half switches on.
    const d = 0.02;
    const f = fly(oneStage(d), 'kbf', { launchAltitude: 2000 });
    expect(P_REF - f.pressure[0]!).toBeGreaterThan(20000);
    expect(pressureTerm(d, f.pressure[0]!)).toBeGreaterThan(6);

    expect(f.thrust[0]).toBe(0);                       // t = 0, curve knot is 0 N
    const coast = f.time.map((_t, i) => i).filter((i) => f.time[i]! > 4.2);
    expect(coast.length).toBeGreaterThan(20);
    for (const i of coast) {
      expect(f.thrust[i]).toBe(0);
    }
  });

  /**
   * THE TERM IS SIGNED, and the exit diameter is a free 1-200 mm field. A pad
   * above 101,325 Pa — an altimeter setting typed into the pressure box is the
   * everyday way to get one, and four corpus files carry 1,013-1,019 hPa — makes
   * the deficit negative, and a large enough exit then drove a BURNING 32 N motor
   * to −9.6 N and returned a 0.000 m apogee with no reason attached. A burning
   * motor cannot push the rocket backwards: in reality an over-expanded nozzle
   * separates and thrust floors near zero. The kernel clamps the corrected TOTAL
   * at zero, inside the term's own guard so nothing on the flags-off path moves
   * (2026-09-08, review). RASAero does not clamp; this is a stated deviation.
   */
  it('never lets the corrected total go negative while the motor burns', () => {
    // 0.12 m against a 105,000 Pa pad: A_e x (101325 - 105000) = -41.6 N on a
    // 32 N plateau, so every plateau row would be about -9.6 N without the floor.
    const d = 0.12;
    const f = fly(oneStage(d), 'kbf', { launchAltitude: 0, temperature: 288.15, pressure: 105000 });
    expect(pressureTerm(d, f.pressure[0]!)).toBeLessThan(-40);
    expect(Math.min(...f.thrust)).toBe(0);
    for (const i of plateauRows(f)) {
      expect(f.thrust[i]).toBe(0);
    }

    // And the clamp is a FLOOR, not a truncation: a smaller exit whose negative
    // term does not swamp the curve still reads the signed sum, bit for bit.
    const small = 0.02;
    const g = fly(oneStage(small), 'kbf',
      { launchAltitude: 0, temperature: 288.15, pressure: 105000 });
    const rows = plateauRows(g);
    expect(pressureTerm(small, g.pressure[rows[0]!]!)).toBeLessThan(0);
    expect(g.thrust[rows[0]!]).toBe(PLATEAU_N + pressureTerm(small, g.pressure[rows[0]!]!));
    expect(g.thrust[rows[0]!]).toBeLessThan(PLATEAU_N);
  });

  it('is off in the desktop-parity model, and off when no nozzle is named', () => {
    // Same gate as the nozzle's OTHER half (power-on base drag): desktop
    // OpenRocket 24.12 has no nozzle-exit model at all, so "OpenRocket — Extended
    // Barrowman" must compute what it computes with the nozzle deleted.
    // Asserted at 2,000 m so a leak would be 6.9 N, not a rounding.
    const d = 0.02;
    const classic = fly(oneStage(d), 'classic', { launchAltitude: 2000 });
    for (const i of plateauRows(classic)) {
      expect(classic.thrust[i]).toBe(PLATEAU_N);
    }

    // Flag on, nozzle absent: the input gate, asserted separately from the model
    // gate so neither can cover for the other.
    for (const model of ['kbf', 'supersonic'] as const) {
      const bare = fly(oneStage(0), model, { launchAltitude: 2000 });
      for (const i of plateauRows(bare)) {
        expect(bare.thrust[i]).toBe(PLATEAU_N);
      }
    }
  });

  it('credits a stage ONCE, not once per motor in a cluster', () => {
    // The stage field holds the cluster's SINGLE EQUIVALENT nozzle, with the exit
    // AREAS summed (the FIELDS.stage entry in packages/app/src/tree/schema.ts; RASAero Manual p.50), so
    // three 20 mm nozzles are typed as one 34.64 mm exit. Multiplying by
    // MotorClusterState.motorCount — which is what the per-motor reading of the
    // formula would do — would then count the cluster twice over.
    const single = 0.02;
    const equivalent = single * Math.sqrt(3);        // same total exit area
    const tree: RocketTree = {
      name: 'Cluster3',
      components: [{
        type: 'stage', name: 'S', nozzleExitDiameter: equivalent,
        children: [
          { type: 'nosecone', length: 0.2, aftRadius: 0.045, thickness: 0.002 },
          {
            type: 'bodytube', length: 0.9, outerRadius: 0.045, thickness: 0.0015, density: 950,
            children: [
              { type: 'trapezoidfinset', finCount: 3, rootChord: 0.14, tipChord: 0.07, sweep: 0.07, height: 0.09, thickness: 0.004 },
              {
                type: 'innertube', id: 'mount', length: 0.2, outerRadius: 0.0155, thickness: 0.0005,
                motorMount: true, cluster: '3-ring', clusterScale: 1.0,
                position: { method: 'bottom', offset: 0 },
              },
              { type: 'parachute', diameter: 0.9 },
            ],
          },
        ],
      }],
    };
    const f = fly(tree, 'kbf');
    const rows = plateauRows(f);
    expect(rows.length).toBeGreaterThan(30);

    // MotorClusterState.getThrust already scales the CURVE by the instance count,
    // so the baseline here is 3 x 32 N — also dyadic, so still bit-exact.
    const clusterCurve = 3 * PLATEAU_N;
    for (const i of rows) {
      expect(f.thrust[i]).toBe(clusterCurve + pressureTerm(equivalent, f.pressure[i]!));
      // And it is emphatically NOT three times that.
      expect(f.thrust[i]).not.toBe(clusterCurve + 3 * pressureTerm(equivalent, f.pressure[i]!));
    }
    expect(Math.max(...rows.map((i) => f.thrust[i]! - clusterCurve))).toBeGreaterThan(1);
  });

  it("never credits a booster's nozzle to the sustainer", () => {
    // Booster carries a 30 mm exit; the sustainer carries none. The sustainer
    // lights 1 s after booster burnout, by which time the booster has separated
    // and is a branch of its own — but the stage lookup is the burning motor
    // mount's OWN stage, so even an overlapping burn could not leak.
    const sustainer = {
      type: 'stage', name: 'Sustainer',
      children: [
        { type: 'nosecone', length: 0.2, aftRadius: 0.029, thickness: 0.002 },
        {
          type: 'bodytube', length: 0.8, outerRadius: 0.029, thickness: 0.001, density: 950,
          children: [
            { type: 'trapezoidfinset', finCount: 3, rootChord: 0.12, tipChord: 0.06, sweep: 0.06, height: 0.07, thickness: 0.003 },
            {
              type: 'innertube', id: 'smount', length: 0.2, outerRadius: 0.0155, thickness: 0.0005,
              motorMount: true, position: { method: 'bottom', offset: 0 },
            },
            { type: 'parachute', diameter: 0.6 },
          ],
        },
      ],
    } as const;
    const booster = {
      type: 'stage', name: 'Booster', separationEvent: 'burnout', nozzleExitDiameter: 0.03,
      children: [
        {
          type: 'bodytube', length: 0.5, outerRadius: 0.029, thickness: 0.001, density: 950,
          children: [
            { type: 'trapezoidfinset', finCount: 3, rootChord: 0.12, tipChord: 0.06, sweep: 0.07, height: 0.09, thickness: 0.003 },
            {
              type: 'innertube', id: 'bmount', length: 0.2, outerRadius: 0.0155, thickness: 0.0005,
              motorMount: true, position: { method: 'bottom', offset: 0 },
            },
          ],
        },
      ],
    } as const;

    const rocket = OrkRocket.buildTree({
      name: 'TwoStage', components: [sustainer, booster],
    } as unknown as RocketTree);
    rocket.setMotorById('bmount', CONST_MOTOR);
    rocket.setMotorById('smount', CONST_MOTOR);
    rocket.setMotorIgnitionById('smount', 'burnout', 1.0);
    rocket.setRogersModifiedBarrowman(true);
    const r = rocket.simulate({ launchRodLength: 1.0, series: 'full' });
    const f: Flown = {
      time: r.series.time,
      thrust: r.series.thrust,
      pressure: r.series['P']!.map((p) => p as number),
      altitude: r.series.altitude,
      apogee: r.summary.maxAltitude,
    };

    // Booster burn: the term is present, and it is the BOOSTER's 30 mm exit.
    const boosterRows = f.time.map((_t, i) => i).filter((i) => f.time[i]! > 0.05 && f.time[i]! < 3.9);
    expect(boosterRows.length).toBeGreaterThan(30);
    for (const i of boosterRows) {
      expect(f.thrust[i]).toBe(PLATEAU_N + pressureTerm(0.03, f.pressure[i]!));
    }

    // Sustainer burn, well above the pad and with the booster's nozzle gone with
    // the booster: the curve, and nothing else. Ungated it would be ~2 N here.
    const sustainerRows = f.time.map((_t, i) => i)
      .filter((i) => f.time[i]! > 5.1 && f.time[i]! < 8.9 && f.thrust[i]! > 0);
    expect(sustainerRows.length).toBeGreaterThan(20);
    for (const i of sustainerRows) {
      expect(f.thrust[i]).toBe(PLATEAU_N);
      expect(pressureTerm(0.03, f.pressure[i]!)).toBeGreaterThan(1); // would have shown
    }
  });

  it('leaves the minimum-diameter parity flight at 329.6097045289919 m', () => {
    // The regression that pins the WHOLE gate end to end: the mindia design carries
    // a 14 mm nozzle exit and flies flags-off, so neither half of the nozzle model
    // may touch it. Same number as orkEngine.test.ts and the flight.mindia golden.
    const rocket = OrkRocket.buildTree({
      name: 'MinDia',
      components: [{
        type: 'stage', name: 'S', nozzleExitDiameter: 0.014,
        children: [
          { type: 'nosecone', length: 0.10, aftRadius: 0.012, thickness: 0.002 },
          {
            type: 'bodytube', id: 'body', length: 0.45, outerRadius: 0.012,
            thickness: 0.0005, density: 950, motorMount: true, motorOverhang: 0.006,
            children: [
              { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.025, thickness: 0.003 },
              { type: 'parachute', diameter: 0.30 },
            ],
          },
        ],
      }],
    });
    rocket.setMotorById('body', {
      designation: 'C6', diameter: 0.018, length: 0.07,
      times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
      thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
      masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
      cgX: 0.035, ejectionDelay: 5.0,
    });
    expect(rocket.simulate({}).summary.maxAltitude).toBeCloseTo(329.6097045289919, 4);
  });
});
