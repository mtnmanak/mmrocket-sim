/**
 * Tests for scripts/cdFromFlight.mjs — the Cd-from-flight-data extractor.
 *
 * WHAT THIS GUARDS. The extractor turns an accelerometer log into a Cd-vs-Mach
 * curve, and every one of its numbers is a physical claim about somebody's real
 * rocket. Four things can silently be wrong in it and none of them raise an
 * exception on their own: the integration rule, the accelerometer unit, the
 * atmosphere, and the coast window. So each has a test that would catch it.
 *
 * TWO KINDS OF TEST IN HERE, and the difference matters:
 *
 *   SYNTHETIC (always run — these are the CI gate). A flight is forward-modelled
 *   at a KNOWN constant Cd and the extractor is asked to recover it. Nothing in
 *   these depends on a file that is not in the repo, so they run everywhere and
 *   they are what actually stands between a bad edit and a shipped wrong number.
 *
 *   REAL-FLIGHT (skipped on CI). Adrian Adamson's two Blue Raven logs, pinned to
 *   the exact figures this extractor produces from them. They CANNOT be
 *   committed: `docs/` is gitignored (CLAUDE.md, "Two machines" — the bulk
 *   third-party reference files "were pulled out of the repo before it went
 *   public … and must not be re-committed"), and `docs/open-items.md` §3 — *The Adamson F10 fixture* still
 *   lists "permission to quote results" as one of three things owed to Adrian.
 *   Publishing his raw telemetry in a public repo is a strictly larger ask than
 *   quoting a derived number, and it has not been made. So they run on Eric's
 *   two machines and skip everywhere else — same posture, and the same
 *   repoRoot()/local() shape, as `src/services/lemivSweep.test.ts:37-63`.
 *   The expected numbers are written into the source anyway, so a regression is
 *   legible in a diff even where the test skips.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATM_PA,
  FT,
  G0,
  GAMMA,
  IN,
  ISA_P0,
  ISA_T0,
  LAPSE,
  MU_A,
  MU_B,
  R_AIR,
  SMOOTH_S,
  analyse,
  atmosphere,
  binByMach,
  columnIndex,
  detectAccelUnit,
  detectBurnout,
  formatReport,
  integrateVelocity,
  main,
  parseCsv,
  prepare,
  solve,
} from './cdFromFlight.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// The synthetic flight. A forward model at a KNOWN Cd, emitted in the shape of a
// Blue Raven pair: a high-rate accelerometer CSV and a low-rate baro companion.
//
// It is integrated with a 10x sub-step at the midpoint rule so the fixture
// itself is accurate to far better than the extractor's own error — otherwise
// the round trip would be measuring the fixture, not the extractor.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrust and burn time, bisected once offline so the rocket tops out at exactly
 * 300.0 m/s, 926.8 m AGL — near enough the spec's "v = 300 m/s at 1,000 m", and
 * the fixture test asserts on the truth it actually reached rather than on these.
 */
const SYNTH_THRUST_N = 58.8761;
const SYNTH_BURN_S = 5.0;

/**
 * The thrust tails off over the last 0.2 s rather than stopping dead.
 *
 * This is not decoration. With an INSTANTANEOUS cutoff the fixture has a step
 * discontinuity in the integrand, and the trapezoid rule crossing it loses
 * 0.116 m/s once and for all — which shows up as a flat +0.18 % on the
 * recovered Cd and makes the round trip look like it is measuring the
 * extractor when it is really measuring an unphysical fixture. Real motors tail
 * off over 0.1-0.4 s (it is why SETTLE_S exists), and with a tail-off the
 * recovery is exact to floating-point noise. Measured both ways before choosing.
 */
const SYNTH_TAIL_OFF_S = 0.2;

/** Full double precision, so a unit round trip is exact rather than nearly. */
const p = (x) => String(x);

function synthFlight({
  cd = 0.45,
  massKg = 0.5,
  diameterM = 0.05,
  rateHz = 500,
  baroRateHz = 50,
  siteElevationM = 0,
  constantDensity = null,
  thrustN = SYNTH_THRUST_N,
  burnS = SYNTH_BURN_S,
  tailOffS = SYNTH_TAIL_OFF_S,
  chuffAt = null,
  chuffS = 0.10,
  padS = 2.0,
  perG = 1,
  channelScale = 1,
  descentS = 2.0,
} = {}) {
  const area = Math.PI * diameterM * diameterM / 4;
  const padTempK = ISA_T0 - LAPSE * siteElevationM;

  /** The same two-branch atmosphere the extractor reconstructs — see atmosphere(). */
  const air = (h) => {
    const tempK = padTempK - LAPSE * h;
    if (constantDensity != null) return { rho: constantDensity, tempK };
    const pPa = ISA_P0 * Math.pow((ISA_T0 - LAPSE * (h + siteElevationM)) / ISA_T0, G0 / (LAPSE * R_AIR));
    return { rho: pPa / (R_AIR * tempK), tempK };
  };

  const thrustAt = (t) => {
    if (t < 0 || t >= burnS) return 0;
    if (chuffAt != null && t >= chuffAt && t < chuffAt + chuffS) return 0;
    if (tailOffS > 0 && t > burnS - tailOffS) return thrustN * (burnS - t) / tailOffS;
    return thrustN;
  };

  /** Specific force along the nose axis, m/s^2 — what an accelerometer reads. */
  const specific = (v, h, t) => (thrustAt(t) - 0.5 * air(h).rho * v * Math.abs(v) * area * cd) / massKg;

  const dt = 1 / rateHz;
  const sub = dt / 10;
  const accel = [['Flight_Time_(s)', 'Accel_X', 'Accel_Y', 'Accel_Z'].join(',')];
  const baro = [['Flight_Time_(s)', 'Baro_Press_(atm)', 'Baro_Altitude_AGL_(feet)'].join(',')];
  const truth = { burnoutT: null, peakV: 0, peakH: 0, apogeeT: null, crossingT: null };

  let v = 0;
  let h = 0;
  let wasPositive = true;
  const padSamples = Math.round(padS * rateHz);
  const emit = (t, aSpec, hh) => {
    // Blue Raven convention: -Z is the nose axis, so the pad reads -1 g.
    const raw = -(aSpec / G0) * perG * channelScale;
    accel.push(`${t.toFixed(6)},0,0,${p(raw)}`);
    if (Math.round(t * rateHz) % Math.round(rateHz / baroRateHz) === 0) {
      const a = air(hh);
      baro.push(`${t.toFixed(6)},${p(a.rho * R_AIR * a.tempK / 101325)},${p(hh / FT)}`);
    }
  };
  for (let i = padSamples; i > 0; i--) emit(-i * dt, G0, 0);

  let t = 0;
  for (let step = 0; ; step++) {
    const aSpec = specific(v, h, t);
    emit(t, aSpec, h);
    if (truth.burnoutT === null && t >= burnS) truth.burnoutT = t;
    if (v > truth.peakV) { truth.peakV = v; truth.peakH = h; }
    // The LAST negative-going crossing before apogee is the real burnout. Taking
    // the first would make a chuff fixture's "true" answer the chuff itself,
    // which is precisely the mistake the detector is being tested against.
    if (truth.apogeeT === null && t > 0.5 && aSpec < 0 && wasPositive) truth.crossingT = t;
    wasPositive = aSpec >= 0;
    if (truth.apogeeT === null && t > burnS && v <= 0) truth.apogeeT = t;
    if (truth.apogeeT !== null && t > truth.apogeeT + descentS) break;
    if (step > 200000) break;
    for (let s = 0; s < 10; s++) {
      const a1 = specific(v, h, t) - G0;
      const vm = v + a1 * sub / 2;
      const hm = h + v * sub / 2;
      const a2 = specific(vm, hm, t + sub / 2) - G0;
      h += (v + a2 * sub / 2) * sub;
      v += a2 * sub;
      t += sub;
    }
    t = (step + 1) * dt; // re-derive so the emitted clock has no accumulated drift
  }
  return { accelCsv: `${accel.join('\n')}\n`, baroCsv: `${baro.join('\n')}\n`, truth, cd, massKg, diameterM };
}

/** The options every synthetic solve shares. */
const synthOpts = (fx, extra = {}) => ({
  accelText: fx.accelCsv,
  massKg: fx.massKg,
  diameterM: fx.diameterM,
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Constants match the engine
// ─────────────────────────────────────────────────────────────────────────────

describe('the copied physical constants still match the engine', () => {
  // Read as TEXT: importing @online-openrocket/engine here would drag the 2.5 MB
  // TeaVM kernel into a CSV tool's test, and no sibling script imports it. The
  // provenance docblocks in cdFromFlight.mjs exist to stop these drifting; this
  // is the check that makes them true rather than aspirational.
  const engineSrc = readFileSync(join(here, '..', '..', 'engine', 'src', 'index.ts'), 'utf8');

  it('G0, the ISA sea-level state and the lapse rate are the engine\'s own', () => {
    expect(engineSrc).toContain('G0 = 9.80665');
    expect(engineSrc).toContain('temperatureK: 288.15');
    expect(engineSrc).toContain('pressurePa: 101325');
    expect(engineSrc).toContain('lapseRateKPerM: -0.0065');
    expect(G0).toBe(9.80665);
    expect(ISA_T0).toBe(288.15);
    expect(ISA_P0).toBe(101325);
    // The engine stores the lapse rate SIGNED; this module stores it positive.
    expect(LAPSE).toBe(0.0065);
  });

  it('R_AIR and the viscosity fit are OpenRocket 24.12\'s, not a rounded copy', () => {
    // AtmosphericConditions.R = 287.053, and the shipped kernel divides by it.
    expect(R_AIR).toBe(287.053);
    expect(GAMMA).toBe(1.4);
    // AtmosphericConditions.getKinematicViscosity(), a linear fit to Sutherland's.
    expect(MU_A).toBe(3.7291e-06);
    expect(MU_B).toBe(4.9944e-08);
    // Sanity: sea-level dynamic viscosity is 1.81e-5 Pa.s.
    expect(MU_A + MU_B * ISA_T0).toBeCloseTo(1.812e-5, 8);
  });

  it('pins the unit conversions, which the synthetic round trip is blind to', () => {
    // FT and IN are the two constants no fixture here can catch. synthFlight
    // writes its altitude column as `hh / FT` feet and the extractor multiplies
    // by FT to get it back, so a transposed 0.3408 would cancel exactly and
    // every synthetic test would still pass; IN never appears in a fixture at
    // all (it is the --diameter-in conversion and the error budget's diameter
    // step). MEASURED cost of getting the feet/metres factor wrong on the real
    // F10 flight — --altitude-unit m on a feet column, the same 3.28x — is mean
    // Cd 0.2258 -> 0.1981, -12 %, silently and at exit code 0.
    expect(FT).toBe(0.3048); // international foot, exact by definition
    expect(IN).toBe(0.0254); // international inch, exact by definition
    expect(ATM_PA).toBe(101325); // standard atmosphere = ISA sea-level pressure
    expect(G0 / FT).toBeCloseTo(32.17405, 5); // ft/s^2 per g, the third accel unit
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2-3. The round trip — the core proof
// ─────────────────────────────────────────────────────────────────────────────

describe('a forward-modelled flight at a known Cd is recovered', () => {
  it('lands within 0.1 % of the true Cd under a full ISA atmosphere', () => {
    const fx = synthFlight();
    // The fixture is what the docblock says it is: 300.0 m/s at 926.8 m AGL.
    expect(fx.truth.peakV).toBeCloseTo(300, 2);
    expect(fx.truth.peakH).toBeGreaterThan(900);
    expect(fx.truth.peakH).toBeLessThan(1000);

    const s = solve(prepare(synthOpts(fx, { baroText: fx.baroCsv })), synthOpts(fx, {
      padTempC: ISA_T0 - 273.15,
    }));
    // Measured: 0.450000 against 0.45, worst per-sample error below 1e-5. The
    // 0.1 % tolerance is four orders looser than the measurement, and it is a
    // real constraint rather than a formality — every one of the sign
    // convention, the unit conversion, the -1 g subtraction, the reference
    // area, the density reconstruction and the coast window has to be right
    // for the answer to land here at all.
    expect(s.band.cd).toBeGreaterThan(0.45 * 0.999);
    expect(s.band.cd).toBeLessThan(0.45 * 1.001);
    // A constant-Cd flight must come out FLAT, not sloped. A bug in the
    // atmosphere or the integration shows up as a tilt long before it shows up
    // in the mean, so this is the sharper half of the test.
    for (const b of s.bins) expect(b.cd).toBeCloseTo(0.45, 3);
  });

  it('lands within 0.1 % at constant density too, isolating the inversion from the atmosphere', () => {
    // Same flight with rho pinned, so the fixture's pressure column is exactly
    // affine in altitude and the extractor's p/(R.T) cannot pick up any
    // curvature error. Recovered: 0.450000.
    const fx = synthFlight({ constantDensity: 1.0 });
    const s = solve(prepare(synthOpts(fx, { baroText: fx.baroCsv })), synthOpts(fx, {
      padTempC: ISA_T0 - 273.15,
    }));
    expect(s.band.cd).toBeGreaterThan(0.45 * 0.999);
    expect(s.band.cd).toBeLessThan(0.45 * 1.001);
  });

  it('reports a Reynolds number only when a reference length is given', () => {
    const fx = synthFlight();
    const withoutL = solve(prepare(synthOpts(fx, { baroText: fx.baroCsv })), synthOpts(fx, {
      padTempC: ISA_T0 - 273.15,
    }));
    expect(withoutL.bins.every((b) => b.reynolds === null)).toBe(true);
    const withL = solve(prepare(synthOpts(fx, { baroText: fx.baroCsv })), synthOpts(fx, {
      padTempC: ISA_T0 - 273.15, lengthM: 0.5,
    }));
    expect(withL.bins.every((b) => b.reynolds > 1e4)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two things the velocity integration has to get right, tested against
// closed forms rather than through the whole pipeline — a round trip on a smooth
// 500 Hz trace is too forgiving to catch either.
// ─────────────────────────────────────────────────────────────────────────────

describe('integrateVelocity', () => {
  const ramp = (rateHz, aOf) => {
    const n = Math.round(12 * rateHz);
    const t = new Float64Array(n);
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = (i - 2 * rateHz) / rateHz; // 2 s of pad, then flight from t = 0
      a[i] = t[i] <= 0 ? 1 : aOf(t[i]);
    }
    return { t, a };
  };

  it('subtracts 1 g: a rocket reading a steady 1 g of specific force is not moving', () => {
    // An accelerometer measures SPECIFIC FORCE. Drop the -1 and this trace —
    // which is what the pad reads, forever — integrates to 9.8 t m/s.
    const { t, a } = ramp(200, () => 1);
    const v = integrateVelocity(t, a);
    expect(Math.max(...Array.from(v).map(Math.abs))).toBeLessThan(1e-9);
  });

  it('is a trapezoid, not a rectangle: a linear ramp comes out exact', () => {
    // a_ax = 1 + c.t  =>  v(t) = c.g0.t^2/2, and the trapezoid rule integrates a
    // linear integrand EXACTLY. `cumsum`, which is what Adamson's Matlab uses,
    // is a rectangle rule; on this ramp its relative error is exactly dt/t —
    // 0.25 % here (50 Hz, 8 s) and 5 % at t = 0.4 s, early in a burn where the
    // velocity is being built. That is the 2-6 % Cd error the module docblock's
    // decimation table measured, and this is the assertion that pins the choice.
    const c = 4;
    const rateHz = 50;
    const { t, a } = ramp(rateHz, (x) => 1 + c * x);
    const v = integrateVelocity(t, a);
    const i = Math.round(2 * rateHz) + Math.round(8 * rateHz); // t = 8 s
    const exact = c * G0 * 8 * 8 / 2;
    expect(v[i]).toBeCloseTo(exact, 6);
    const rectangle = exact - c * G0 * (1 / rateHz) * 8 / 2;
    expect(Math.abs(rectangle / exact - 1)).toBeCloseTo(1 / rateHz / 8, 9);
  });

  it('applies the scale factor to the axial channel before removing gravity', () => {
    // k multiplies the measured specific force, NOT the (a - 1 g) difference:
    // scaling after the subtraction would leave the 1 g uncalibrated, and the
    // whole point of k is that it corrects the sensor, gravity included.
    //   v_k(t) = (k-1).g0.t + k.c.g0.t^2/2
    const c = 4;
    const rateHz = 200;
    const { t, a } = ramp(rateHz, (x) => 1 + c * x);
    const i = Math.round(2 * rateHz) + Math.round(8 * rateHz); // t = 8 s
    const closed = (k) => (k - 1) * G0 * 8 + k * c * G0 * 64 / 2;
    expect(integrateVelocity(t, a)[i]).toBeCloseTo(closed(1), 6);
    expect(integrateVelocity(t, a, { scale: 1.5 })[i]).toBeCloseTo(closed(1.5), 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Unit detection
// ─────────────────────────────────────────────────────────────────────────────

describe('the accelerometer unit is measured off the pad, never assumed', () => {
  const FT_S2_PER_G = G0 / FT;

  it('recovers the same Cd from g, m/s^2 and ft/s^2 channels', () => {
    const run = (perG) => {
      const fx = synthFlight({ perG });
      return solve(prepare(synthOpts(fx, { baroText: fx.baroCsv })), synthOpts(fx, {
        padTempC: ISA_T0 - 273.15,
      }));
    };
    const inG = run(1);
    const inMs2 = run(G0);
    const inFtS2 = run(FT_S2_PER_G);
    expect(inG.accelUnit).toBe('g');
    expect(inMs2.accelUnit).toBe('m/s2');
    expect(inFtS2.accelUnit).toBe('ft/s2');
    expect(inMs2.band.cd).toBeCloseTo(inG.band.cd, 9);
    expect(inFtS2.band.cd).toBeCloseTo(inG.band.cd, 9);
  });

  it('refuses a channel whose pad-static reading is not 1 g in any of the three (R4)', () => {
    const fx = synthFlight({ channelScale: 3 });
    expect(() => prepare(synthOpts(fx))).toThrow(/^R4:/);
  });

  it('takes the sign convention from the pad too, so a +Z-forward board also works', () => {
    // synthFlight writes -Z forward (the Blue Raven convention). Flipping every
    // sample must change nothing: the pad still reads 1 g of specific force, and
    // the sign of the pad mean is what makes the nose axis positive.
    const fx = synthFlight();
    const flipped = fx.accelCsv.split('\n').map((line, i) => {
      if (i === 0 || line === '') return line;
      const c = line.split(',');
      c[3] = String(-Number(c[3]));
      return c.join(',');
    }).join('\n');
    const a = solve(prepare(synthOpts(fx, { baroText: fx.baroCsv })), synthOpts(fx, { padTempC: 15 }));
    const b = solve(prepare({ ...synthOpts(fx), accelText: flipped, baroText: fx.baroCsv }),
      synthOpts(fx, { padTempC: 15 }));
    expect(b.band.cd).toBeCloseTo(a.band.cd, 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Burnout detection
// ─────────────────────────────────────────────────────────────────────────────

describe('burnout is found from the accelerometer alone', () => {
  it('lands within one smoothing window of the true crossing, through a tail-off', () => {
    const fx = synthFlight({ burnS: 8, tailOffS: 0.4 });
    const pr = prepare(synthOpts(fx));
    const t = detectBurnout(pr.t, pr.aAxG, { rate: pr.rateHz });
    // Trailing mean, so it errs LATE — the safe direction. Never early.
    expect(t).toBeGreaterThanOrEqual(fx.truth.crossingT);
    expect(t - fx.truth.crossingT).toBeLessThanOrEqual(SMOOTH_S + 1 / pr.rateHz);
  });

  it('is not fooled by a mid-burn chuff — this is what the hold window buys', () => {
    const fx = synthFlight({ burnS: 8, tailOffS: 0.4, chuffAt: 3.0, chuffS: 0.10 });
    const pr = prepare(synthOpts(fx));
    const t = detectBurnout(pr.t, pr.aAxG, { rate: pr.rateHz });
    // The chuff really does drive the axial channel negative at t = 3...
    let dipped = false;
    for (let i = 0; i < pr.t.length; i++) {
      if (pr.t[i] > 3.0 && pr.t[i] < 3.1 && pr.aAxG[i] < 0) dipped = true;
    }
    expect(dipped).toBe(true);
    // ...and the detector still returns the real burnout, not the chuff.
    expect(t).toBeGreaterThan(7.5);
    expect(t - fx.truth.crossingT).toBeLessThanOrEqual(SMOOTH_S + 1 / pr.rateHz);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Refusals. Each one was reachable from a file sitting in `docs/User files/`
//    when this was written — these are the four things a tester drops on it
//    first, not hypotheticals.
// ─────────────────────────────────────────────────────────────────────────────

describe('it refuses, loudly, rather than producing a confident wrong number', () => {
  // Headers only. A header line is a column list, not third-party flight data,
  // so quoting these is not the thing `open-items.md` §3 *The Adamson F10 fixture* says is still owed.
  const GPS_HEADER = 'UTCTIME,UNIXTIME,ALT,LAT,LON,#SATS,FIX,HORZV,VERTV,HEAD,FLAGS,>40,>32,>24,RSSI,BATT';
  const MMR_HEADER = 'time_s,altitude_ft,velocity_ft/s,acceleration_G,mass_g,thrust_N,drag_N,mach,'
    + 'stability_cal,cpLocation_mm,cgLocation_mm,aoa_deg';
  const RASAERO_HEADER = 'Time (sec),Stage,Stage Time (sec),Mach Number,Angle of Attack (deg),CD,CL,'
    + 'Thrust (lb),Weight (lb),Drag (lb),Lift (lb),CG (in),CP (in),Stability Margin (cal),'
    + 'Accel (ft/sec^2),Accel-V (ft/sec^2),Accel-H (ft/sec^2),Velocity (ft/sec),Vel-V (ft/sec),'
    + 'Vel-H (ft/sec),Pitch Attitude (deg),Flight Path Angle (deg),Altitude (ft),Distance (ft)';

  it('R1 — a Featherweight GPS track has no accelerometer in it', () => {
    expect(() => prepare({ accelText: `${GPS_HEADER}\n`, massKg: 1, diameterM: 0.05 }))
      .toThrow(/^R1:.*Featherweight GPS track/);
  });

  it('R2 — an MMRocket Sim export\'s acceleration_G is not specific force', () => {
    // |net acceleration| WITH gravity and with the sign stripped: the opposite
    // convention to an accelerometer, verified against that file's own
    // thrust/drag/mass columns. Feeding it in would produce nonsense silently.
    expect(() => prepare({ accelText: `${MMR_HEADER}\n`, massKg: 1, diameterM: 0.05 }))
      .toThrow(/^R2:.*MMRocket Sim flight export/);
  });

  it('R3 — a RASAero II export\'s CD column is an input, not an observation', () => {
    expect(() => prepare({ accelText: `${RASAERO_HEADER}\n`, massKg: 1, diameterM: 0.05 }))
      .toThrow(/^R3:.*RASAero II simulation export/);
  });

  it('R5 — no baro column and no site elevation means no density source', () => {
    const fx = synthFlight();
    expect(() => analyse(synthOpts(fx))).toThrow(/^R5:.*site-elevation-m/);
  });

  // Not "9 % high by 10 Hz" — the only end-to-end measurement anyone has made
  // here is the decimation of the real 500 Hz F10 trace in the module docblock,
  // and it runs the other way: 0.2248 at 100 Hz and 0.2218 at 50 Hz, both LOW.
  // Below 50 Hz the file's own pad segment falls under MIN_PAD_SAMPLES, so the
  // trend past there is unmeasured and MIN_RATE_HZ refuses rather than guesses.
  it('R6 — a 5 Hz log is refused: below the 10 Hz floor nothing has been measured', () => {
    const fx = synthFlight({ rateHz: 5, baroRateHz: 5 });
    expect(() => prepare(synthOpts(fx))).toThrow(/^R6:.*below the 10 Hz floor/);
  });

  it('R7 — a coast-only trace has no initial condition for the velocity', () => {
    const fx = synthFlight();
    const lines = fx.accelCsv.split('\n');
    const coastOnly = [lines[0], ...lines.slice(1).filter((l) => l !== '' && Number(l.split(',')[0]) > 6)];
    expect(() => prepare({ ...synthOpts(fx), accelText: `${coastOnly.join('\n')}\n` }))
      .toThrow(/^R7:.*initial condition/);
  });

  it('R8 — a burnout forced early counts thrust as drag, and that is caught', () => {
    const fx = synthFlight();
    const pr = prepare(synthOpts(fx, { baroText: fx.baroCsv }));
    expect(() => solve(pr, synthOpts(fx, {
      padTempC: ISA_T0 - 273.15, burnoutS: fx.truth.burnoutT - 1.0, settleS: 0,
    }))).toThrow(/^R8:.*thrust is being counted as drag/);
  });

  it('R9 — there is no default mass or diameter, ever', () => {
    const fx = synthFlight();
    const pr = prepare(synthOpts(fx, { baroText: fx.baroCsv }));
    expect(() => solve(pr, { diameterM: 0.05, padTempC: 15 })).toThrow(/^R9:.*BURNOUT mass/);
    expect(() => solve(pr, { massKg: 0.5, padTempC: 15 })).toThrow(/^R9:.*diameter/);
    expect(() => solve(pr, { massKg: Number('kg'), diameterM: 0.05, padTempC: 15 })).toThrow(/^R9:/);
  });

  it('R4 — an altitude column with no unit in its name is refused, not guessed', () => {
    const fx = synthFlight();
    const baro = fx.baroCsv.replace('Baro_Altitude_AGL_(feet)', 'Baro_Altitude_AGL');
    expect(() => prepare({ ...synthOpts(fx), baroText: baro })).toThrow(/^R4:.*altitude-unit/);
  });

  it('R4 — a pressure column with no unit in its name is refused too', () => {
    const fx = synthFlight();
    const baro = fx.baroCsv.replace('Baro_Press_(atm)', 'Baro_Press');
    expect(() => prepare({ ...synthOpts(fx), baroText: baro })).toThrow(/^R4:.*no unit in its name/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The sea-level trap
// ─────────────────────────────────────────────────────────────────────────────

describe('the ISA fallback never defaults to sea level', () => {
  // MEASURED on the real F10 flight: ISA at the true 8,800 ft site gives mean Cd
  // 0.2260 against the measured-baro 0.2258 — 0.09 %, which makes the fallback
  // genuinely usable. ISA from sea level gives 0.1696, which is -24.9 %. A
  // silent sea-level default would be the single worst bug this tool could ship.
  const SITE_M = 2682; // 8,800 ft, Adrian's field

  it('recovers the true Cd from the right elevation and is 20 %+ out from zero', () => {
    const fx = synthFlight({ siteElevationM: SITE_M });
    const pr = prepare(synthOpts(fx));
    const right = solve(pr, synthOpts(fx, { siteElevationM: SITE_M }));
    const wrong = solve(pr, synthOpts(fx, { siteElevationM: 0 }));
    expect(right.band.cd).toBeCloseTo(0.45, 2);
    expect(Math.abs(wrong.band.cd / right.band.cd - 1)).toBeGreaterThan(0.20);
    // And it is wrong in the direction the F10 measurement showed: a sea-level
    // atmosphere is denser than the real one, so the recovered Cd reads LOW.
    expect(wrong.band.cd).toBeLessThan(right.band.cd);
  });

  it('a zero elevation is only ever reachable because the caller passed it', () => {
    const fx = synthFlight({ siteElevationM: SITE_M });
    const pr = prepare(synthOpts(fx));
    expect(() => solve(pr, synthOpts(fx))).toThrow(/^R5:/);
    expect(() => atmosphere({ altitudeM: 1000 })).toThrow(/^R5:/);
    expect(atmosphere({ altitudeM: 0, siteElevationM: 0 }).densityKgM3).toBeCloseTo(1.225, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. parseCsv / columnIndex
// ─────────────────────────────────────────────────────────────────────────────

describe('the CSV reader', () => {
  // The Blue Raven low-rate header repeats `Reserved`, `LT_AGL1`, `GT_BURN` and
  // `Armed` four times each and carries `Apo_FER_H  ex` with a double space.
  it('returns the FIRST index for a duplicated column name', () => {
    const { header } = parseCsv('a,Reserved,b,Reserved,c,Reserved\n1,2,3,4,5,6\n');
    expect(columnIndex(header, 'Reserved')).toBe(1);
    expect(columnIndex(header, 'c')).toBe(4);
    expect(columnIndex(header, 'nope')).toBe(-1);
  });

  it('matches an embedded double space exactly rather than normalising it away', () => {
    const { header } = parseCsv('a,Apo_FER_H  ex,b\n1,2,3\n');
    expect(columnIndex(header, 'Apo_FER_H  ex')).toBe(1);
    expect(columnIndex(header, 'Apo_FER_H ex')).toBe(-1);
  });

  it('throws naming the line number on a ragged row, and never pads it', () => {
    expect(() => parseCsv('a,b,c\n1,2,3\n4,5\n6,7,8\n')).toThrow(/line 3 has 2 fields/);
  });

  it('drops blank lines and a UTF-8 BOM', () => {
    const { header, rows } = parseCsv('﻿a,b\n1,2\n\n3,4\n');
    expect(header).toEqual(['a', 'b']);
    expect(rows).toEqual([['1', '2'], ['3', '4']]);
  });

  it('identifies the pad-static unit and refuses a trace with too few pad samples', () => {
    expect(detectAccelUnit(new Array(100).fill(-0.9932)).unit).toBe('g');
    expect(detectAccelUnit(new Array(100).fill(-0.9932)).sign).toBe(-1);
    expect(detectAccelUnit(new Array(100).fill(9.7)).unit).toBe('m/s2');
    expect(detectAccelUnit(new Array(100).fill(32.0)).unit).toBe('ft/s2');
    expect(() => detectAccelUnit([1, 1, 1])).toThrow(/^R7:/);
  });

  it('bins by Mach and drops empty bins', () => {
    const series = [
      { machNumber: 0.30, cd: 0.2, reynolds: 1e6, t: 1 },
      { machNumber: 0.34, cd: 0.3, reynolds: 2e6, t: 2 },
      { machNumber: 0.55, cd: 0.4, reynolds: 3e6, t: 3 },
    ];
    const bins = binByMach(series, [0.25, 0.35, 0.45, 0.55, 0.65]);
    expect(bins.map((b) => b.lo)).toEqual([0.25, 0.55]);
    expect(bins[0].cd).toBeCloseTo(0.25, 12);
    expect(bins[0].n).toBe(2);
    expect(bins[0].reynolds).toBeCloseTo(1.5e6, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. CLI import safety
// ─────────────────────────────────────────────────────────────────────────────

describe('importing this module', () => {
  // `scripts/bbcode-from-blurb.test.mjs:206-210` is the precedent: that script's
  // CLI body ran at module top level, so importing its helpers called
  // process.exit(1) before a test could run, and its two rules had no test at
  // all. This file exists only because the entry-point guard is there.
  it('does not run the CLI', () => {
    expect(typeof analyse).toBe('function');
    expect(typeof main).toBe('function');
    expect(typeof formatReport).toBe('function');
  });

  it('main() returns an exit code instead of exiting, and prints usage with no args', () => {
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      expect(main(['node', 'cdFromFlight.mjs'])).toBe(1);
    } finally {
      console.log = realLog;
    }
    expect(lines.join('\n')).toContain('BURNOUT mass');
  });

  it('refuses a bare numeric flag rather than reading it as 1', () => {
    // `--mass-kg` with no value parses as boolean true, and Number(true) is 1.
    // Before this refusal, `--mass-kg --diameter-in 1.17` on the real F10 file
    // printed "burnout mass 1.0000 kg", a headline Cd of 1.84, and exited 0 —
    // a confident wrong number from the one input the R9 messages say has no
    // default. Nothing is read from disk here: numFlag throws first.
    const errs = [];
    const realErr = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    try {
      expect(main(['node', 'cdFromFlight.mjs', 'nonexistent.csv', '--mass-kg', '--diameter-in', '1.17']))
        .toBe(1);
    } finally {
      console.error = realErr;
    }
    expect(errs.join('\n')).toMatch(/R9: --mass-kg was given with no value/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REAL FLIGHT DATA — skipped on CI (see the file docblock)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local-only inputs (docs/ is gitignored — CLAUDE.md, "Two machines"). Found by
 * walking up for `version.json`, the same shape as
 * `src/services/lemivSweep.test.ts:37-63`; from this file's own directory rather
 * than the working directory, because a script test has no happy-dom `/@fs/`
 * problem to work around and the file's location is the more stable anchor.
 */
function repoRoot() {
  let dir = here;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'version.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return here;
}
const local = (rel) => join(repoRoot(), 'docs', 'User files', 'TRF RASAero Files', rel);

/** Adrian Adamson's F10 flight, 15 October 2023 — the G-record attempt. */
const F10_HIGH = local('high_rate_10-16-2023_08_13_F_Record.csv');
const F10_LOW = local('low_rate_10-16-2023_08_13_F_Record.csv');
/** His G12 flight, 21 April 2024 — "Half Fast", the chute-stuck one. */
const G12_HIGH = local('high_rate_04-21-2024_16_53_29.csv');
const G12_LOW = local('low_rate_04-21-2024_16_53_28.csv');

/**
 * As-flown inputs. Mass is the weak one and it is the whole ask still open with
 * Adrian (`docs/open-items.md` §3 — *The Adamson F10 fixture*): 124.5 g is launch mass minus a
 * thrustcurve.org propellant figure, not a scale reading, and +-5 g is +-4 % on
 * Cd — the largest single term in the error budget.
 */
const F10 = {
  massKg: 0.1245, // TRF #130
  diameterM: 1.17 * 0.0254, // build thread and `G record 2023.CDX1`; NOT the snippet's 1.16
  lengthM: 13.45 * 0.0254,
  padTempC: 4.4444, // 40 F free-air, the figure the prior extraction used
  accelScale: 1.012, // Adrian's own GPS-fitted k (TRF #130)
};
const G12 = {
  massKg: 0.1429, // post-flight, TRF #167
  diameterM: 1.17 * 0.0254,
  lengthM: 13.45 * 0.0254,
  // No field temperature was recorded for this launch, so the pad temperature is
  // ISA at the field elevation the file's own baro reports on the pad (5,064 ft
  // ASL). The board's own Temperature_(F) reads 63.7 F and is NOT usable — it is
  // self-heated inside a sealed bay, and using it moves mean Cd by +4.4 %.
  siteElevationM: 1543.5,
  accelScale: 'pad',
};

const HAVE_F10 = existsSync(F10_HIGH) && existsSync(F10_LOW);
const HAVE_G12 = existsSync(G12_HIGH) && existsSync(G12_LOW);

// Parsed at most once each, and only inside a test body — `describe.skipIf`
// still evaluates the describe callback, so nothing heavy may live in it.
let _f10 = null;
let _g12 = null;
const f10 = () => (_f10 ??= prepare({ accelPath: F10_HIGH, baroPath: F10_LOW }));
const g12 = () => (_g12 ??= prepare({ accelPath: G12_HIGH, baroPath: G12_LOW }));

describe.skipIf(!HAVE_F10)('Adamson F10, 2023 — measured, local-only', () => {
  it('reproduces the published subsonic Cd', () => {
    const s = solve(f10(), F10);
    // Adrian's own published figure is "approximately 0.225" (Chuck Rogers, TRF
    // #126) and the prior independent extraction in
    // `docs/research/trf-flight-data-2026-08-25.md:47` is 0.226 over n = 3,798.
    expect(s.band.cd).toBeCloseTo(0.226, 3);
    expect(s.band.n).toBe(3796);
  });

  it('reproduces the band table, including the Reynolds trend', () => {
    const s = solve(f10(), F10);
    const at = (lo) => s.bins.find((b) => b.lo === lo);
    expect(at(0.65).cd).toBeCloseTo(0.209, 3);
    expect(at(0.55).cd).toBeCloseTo(0.214, 3);
    expect(at(0.45).cd).toBeCloseTo(0.217, 3);
    expect(at(0.35).cd).toBeCloseTo(0.227, 3);
    expect(at(0.25).cd).toBeCloseTo(0.241, 3);
    expect(at(0.15).cd).toBeCloseTo(0.270, 3);
    expect([at(0.65).n, at(0.55).n, at(0.45).n, at(0.35).n, at(0.25).n, at(0.15).n])
      .toEqual([495, 608, 758, 935, 1140, 1352]);
    expect(at(0.65).reynolds).toBeCloseTo(3.563e6, -4);
    expect(at(0.55).reynolds).toBeCloseTo(3.001e6, -4);
    expect(at(0.45).reynolds).toBeCloseTo(2.451e6, -4);
    expect(at(0.35).reynolds).toBeCloseTo(1.917e6, -4);
    expect(at(0.25).reynolds).toBeCloseTo(1.406e6, -4);
    expect(at(0.15).reynolds).toBeCloseTo(9.188e5, -4);
    // Cd rises monotonically as Mach falls — the Reynolds trend, and the thing
    // that makes this a curve rather than a single number.
    const subsonic = [at(0.65), at(0.55), at(0.45), at(0.35), at(0.25), at(0.15)];
    for (let i = 1; i < subsonic.length; i++) {
      expect(subsonic[i].cd).toBeGreaterThan(subsonic[i - 1].cd);
    }
  });

  it('detects burnout and apogee against the altimeter\'s own flags', () => {
    const s = solve(f10(), F10);
    // From the accelerometer alone, with no help from the low-rate flags.
    expect(s.detectedBurnout).toBeCloseTo(8.176, 3);
    expect(s.burnoutFlag).toBeCloseTo(8.24, 2);
    expect(Math.abs(s.detectedBurnout - s.burnoutFlag)).toBeLessThan(0.10);
    expect(s.liftoffFlag).toBeCloseTo(0.0, 6);
    expect(s.apogeeFlag).toBeCloseTo(24.90, 2);
    expect(s.apogeeS).toBeCloseTo(25.020, 3);
    expect(s.apogeeSource).toContain('barometric');
    // The settling guard costs the top of the curve, and the report says so.
    expect(s.peakMach).toBeCloseTo(0.752, 3);
    expect(s.peakMachUnguarded).toBeCloseTo(0.790, 3);
  });

  it('reads the board\'s own peak velocity out of the low-rate file for comparison', () => {
    const { header, rows } = parseCsv(readFileSync(F10_LOW, 'utf8'));
    const iT = columnIndex(header, 'Flight_Time_(s)');
    const iV = columnIndex(header, 'Velocity_Up');
    let best = -Infinity;
    let bestT = NaN;
    for (const r of rows) {
      const v = Number(r[iV]);
      if (v > best) { best = v; bestT = Number(r[iT]); }
    }
    expect(best).toBeCloseTo(841, 0);
    expect(bestT).toBeCloseTo(8.08, 2);
  });

  it('has the pad-static signature both Blue Ravens share', () => {
    const pr = f10();
    // Mean |-Accel_Z| over the pre-liftoff samples.
    expect(Math.abs(pr.unit.padMean)).toBeCloseTo(0.993, 3);
    expect(pr.unit.padSd).toBeLessThan(0.01);
    expect(pr.unit.unit).toBe('g');
    expect(pr.unit.n).toBeGreaterThan(900);
    expect(pr.rateHz).toBeCloseTo(500, 6);
  });

  it('pins the accel-scale lever, so nobody re-tunes it quietly', () => {
    // k multiplies the drag once and the integrated velocity roughly twice, so
    // it is a ~3 % lever end to end, not the 1.2 % the register calls it.
    const none = solve(f10(), { ...F10, accelScale: 'none' });
    const pad = solve(f10(), { ...F10, accelScale: 'pad' });
    const adrian = solve(f10(), F10);
    expect(none.band.cd).toBeCloseTo(0.2329, 4);
    expect(pad.band.cd).toBeCloseTo(0.2289, 4);
    expect(adrian.band.cd).toBeCloseTo(0.2258, 4);
    expect(pad.scale).toBeCloseTo(1.00680, 5);
    expect(none.band.cd / adrian.band.cd - 1).toBeCloseTo(0.0314, 3);
  });

  it('agrees between the measured barometer and ISA at the true site elevation', () => {
    // Both over the flag-derived window, so only the density source differs.
    const win = { burnoutS: 8.24, settleS: 0, apogeeS: 24.90 };
    const measured = solve(f10(), { ...F10, ...win });
    const isaAtSite = solve(prepare({ accelPath: F10_HIGH }), { ...F10, ...win, siteElevationM: 2682.24 });
    expect(measured.band.cd).toBeCloseTo(0.2258, 4);
    expect(isaAtSite.band.cd).toBeCloseTo(0.2260, 4);
    expect(Math.abs(isaAtSite.band.cd / measured.band.cd - 1)).toBeLessThan(0.005);
    // And ISA from sea level, the refused case, to show what R5 is protecting.
    const isaAtSeaLevel = solve(prepare({ accelPath: F10_HIGH }), { ...F10, ...win, siteElevationM: 0 });
    expect(isaAtSeaLevel.band.cd).toBeCloseTo(0.1696, 4);
    expect(isaAtSeaLevel.band.cd / measured.band.cd - 1).toBeCloseTo(-0.249, 2);
  });

  /**
   * WHY THE PAD TEMPERATURE IS NOT MIXED INTO THE ISA FALLBACK — the measurement
   * that makes the answer worse.
   *
   * ISA's pressure at height comes from integrating ISA's own temperature
   * profile. Substituting a measured pad temperature and keeping that pressure
   * describes no atmosphere: the F10's real column was ~7 K warmer than standard
   * at its site, which would have raised the pressure aloft too, and this path
   * has no measurement of that. The numbers below are why the code refuses the
   * tempting version — and the report now says the value was carried but not
   * applied, instead of printing "given, 4.4 C" as though it had been.
   */
  it('does NOT mix the measured pad temperature into the standard atmosphere', () => {
    const win = { burnoutS: 8.24, settleS: 0, apogeeS: 24.90 };
    const measured = solve(f10(), { ...F10, ...win });
    const isa = solve(prepare({ accelPath: F10_HIGH }), { ...F10, ...win, siteElevationM: 2682.24 });

    // F10 carries padTempC 4.4444, and the ISA answer is the SELF-CONSISTENT
    // one — 0.2260, not the 0.2314 that mixing in the measurement produces.
    expect(F10.padTempC).toBeCloseTo(4.4444, 4);
    expect(isa.band.cd).toBeCloseTo(0.2260, 4);
    expect(Math.abs(isa.band.cd - measured.band.cd)).toBeLessThan(0.0005);

    // The mixed form, computed here so the 2.5 % is a measurement and not a
    // claim: same pressure column, pad temperature lapsed in place of ISA's.
    const mixed = atmosphere({ altitudeM: 1000, padTempK: F10.padTempC + 273.15, siteElevationM: 2682.24 });
    const pure = atmosphere({ altitudeM: 1000, siteElevationM: 2682.24 });
    expect(mixed.pressurePa).toBeCloseTo(pure.pressurePa, 6);   // pressure identical...
    expect(mixed.temperatureK).toBeCloseTo(pure.temperatureK, 6); // ...and so is T: NOT mixed in
    expect(mixed.densityKgM3).toBeCloseTo(pure.densityKgM3, 9);

    // ...and the report says so rather than claiming the measurement was used.
    expect(isa.tempNote).toMatch(/NOT used/);
    expect(measured.tempNote).not.toMatch(/NOT used/);
  });

  /**
   * R10 — the altitude unit is the one input a user overrides by hand, and
   * before 2026-09-07 nothing checked it. `--altitude-unit m` on a feet column
   * gave mean Cd 0.1981 against 0.2258, a 12 % error at exit code 0.
   */
  it('R10 — refuses when the barometer and the accelerometer disagree about height', () => {
    const win = { burnoutS: 8.24, settleS: 0, apogeeS: 24.90 };
    // A feet column declared to be metres: the peaks come out a factor of 3.4
    // apart, which two independent measurements never are.
    expect(() => solve(
      prepare({ accelPath: F10_HIGH, baroPath: F10_LOW, altitudeUnit: 'm' }),
      { ...F10, ...win },
    )).toThrow(/^R10:.*altitude UNIT/s);
    // And the correct unit does not trip it — the guard is wide on purpose.
    expect(() => solve(f10(), { ...F10, ...win })).not.toThrow();
  });
});

describe.skipIf(!HAVE_G12)('Adamson G12, 2024 — measured, local-only', () => {
  it('extracts the second flight, and it is NOT transonic', () => {
    const s = solve(g12(), G12);
    expect(s.detectedBurnout).toBeCloseTo(12.162, 3);
    expect(s.burnoutFlag).toBeCloseTo(12.14, 2);
    expect(s.apogeeS).toBeCloseTo(31.040, 3);
    expect(s.band.cd).toBeCloseTo(0.2298, 4);
    expect(s.band.n).toBe(4107);
    // `docs/open-items.md` §3 — *The Adamson F10 fixture* calls this pair "the transonic flight". It
    // is not: M 0.912 usable, 0.951 before the settling guard. Neither Adamson
    // flight on disk reaches transonic, so this closes the SUBSONIC harness cell
    // only — the transonic hole `validation/README.md` records is still open.
    expect(s.peakMach).toBeCloseTo(0.912, 3);
    expect(s.peakMach).toBeLessThan(1.0);
    expect(s.peakMachUnguarded).toBeLessThan(1.0);
  });

  it('reproduces its band table', () => {
    const s = solve(g12(), G12);
    const at = (lo) => s.bins.find((b) => b.lo === lo);
    expect(at(0.85).cd).toBeCloseTo(0.205, 3);
    expect(at(0.75).cd).toBeCloseTo(0.204, 3);
    expect(at(0.65).cd).toBeCloseTo(0.208, 3);
    expect(at(0.55).cd).toBeCloseTo(0.213, 3);
    expect(at(0.45).cd).toBeCloseTo(0.221, 3);
    expect(at(0.35).cd).toBeCloseTo(0.232, 3);
    expect(at(0.25).cd).toBeCloseTo(0.251, 3);
    expect(at(0.15).cd).toBeCloseTo(0.285, 3);
  });

  it('has the same pad-static signature as the 2023 board', () => {
    const pr = g12();
    expect(Math.abs(pr.unit.padMean)).toBeCloseTo(0.993, 3);
    expect(pr.unit.padSd).toBeLessThan(0.01);
    expect(pr.unit.unit).toBe('g');
  });
});

/**
 * The three wrong-kind-of-file refusals, proven on the artefacts themselves
 * rather than only on pasted header strings. All three sat in `docs/User files/`
 * when this was written, and all three are what a tester reaches for first.
 */
const GPS_TRACK = local('2023-10-15-(Grecord)-15-13-13.csv');
const RASAERO_EXPORT = local('Flight Test.CSV');
const MMR_EXPORT = join(repoRoot(), 'docs', 'User files', 'testa-flight-data.csv');
const HAVE_WRONG_KINDS = existsSync(GPS_TRACK) && existsSync(RASAERO_EXPORT) && existsSync(MMR_EXPORT);

describe.skipIf(!HAVE_WRONG_KINDS)(
  'the refusals, proven on the real artefacts and not only on pasted headers', () => {
    it('R1 on the Featherweight GPS track that shipped alongside the F10 flight', () => {
      expect(() => prepare({ accelPath: GPS_TRACK })).toThrow(/^R1:.*Featherweight GPS track/);
    });

    it('R3 on the RASAero II export in the same folder', () => {
      expect(() => prepare({ accelPath: RASAERO_EXPORT })).toThrow(/^R3:.*RASAero II simulation export/);
    });

    it('R2 on this app\'s own flight CSV export', () => {
      // Verified against that file's own thrust/drag/mass columns at seven rows:
      // its acceleration_G is |net acceleration| with gravity IN and the sign
      // stripped — the opposite convention to an accelerometer.
      expect(() => prepare({ accelPath: MMR_EXPORT })).toThrow(/^R2:.*MMRocket Sim flight export/);
    });
  },
);
