import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { G0 } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS, kernelSimOptions } from '../components/LaunchPanel.js';
import {
  densityAltitudeM,
  isaAltitudeForDensity,
  isaPressurePa,
  isaTemperatureK,
  ISA_TOP_M,
  padAir,
  padPressureIssue,
  PAD_PRESSURE_HPA_RANGE,
  PAD_PRESSURE_SEA_LEVEL_MARGIN,
  PAD_PRESSURE_SITE_M,
  PAD_TEMP_C_RANGE,
  R_AIR,
  SITE_ALTITUDE_M_RANGE,
} from './atmosphere.js';
import { siteAirDensity } from './recoverySizing.js';

const FT = 3.28084;
const INHG = 33.8639; // mbar per in-Hg — RASAero's launch-site pressure unit
const ft = (feet: number) => feet / FT;
const inHg = (v: number) => v * INHG; // -> mbar, the LaunchConditions unit

describe('ISA station pressure', () => {
  it('is sea level at sea level', () => {
    expect(isaPressurePa(0)).toBeCloseTo(101325, 6);
  });

  /**
   * Anchors against the analytic ISA, and against the two figures the pad-
   * pressure finding is stated in: a 3,900 ft pad reads about 878 mbar and an
   * 8,800 ft pad about 730, where the kernel — with a temperature typed and
   * this field blank — puts 1013 at both.
   */
  it('matches the standard atmosphere at the sites the finding quotes', () => {
    expect(isaPressurePa(ft(3900))).toBeCloseTo(87836, 0);
    expect(isaPressurePa(ft(8800))).toBeCloseTo(72988, 0);
    expect(isaPressurePa(PAD_PRESSURE_SITE_M)).toBeCloseTo(94322, 0);
  });

  it('falls monotonically and treats a bad altitude as sea level', () => {
    let last = Infinity;
    for (let h = 0; h <= 10000; h += 250) {
      const p = isaPressurePa(h);
      expect(p).toBeLessThan(last);
      last = p;
    }
    expect(isaPressurePa(-100)).toBeCloseTo(101325, 6); // clamped, not extrapolated
    expect(isaPressurePa(NaN)).toBeCloseTo(101325, 6);
  });
});

/**
 * A BLANK field is correct input and says nothing — at any altitude, with or
 * without a temperature typed beside it.
 *
 * This block asserted the opposite through v0.120, and the behaviour it pinned
 * is the one Eric objected to (2026-09-08b): the app used sea level for a field
 * the user had left for it to work out, then warned them about it.
 * `kernelSimOptions` now fills each field independently from the site altitude,
 * so there is nothing left to report here. The assertion that the FILL actually
 * happens lives in LaunchPanel.test.tsx, against kernelSimOptions itself —
 * which is the function that would have to break for this to matter again.
 */
describe('padPressureIssue — a blank field is not a fault', () => {
  it('says nothing when the pressure is blank, whatever the temperature', () => {
    // Both of these were 'blank' before. The pad now flies its own standing
    // pressure in each case.
    expect(padPressureIssue({ launchAltitudeM: ft(3900), temperatureC: 32.2, pressureHPa: null }))
      .toBeNull();
    expect(padPressureIssue({ launchAltitudeM: ft(8800), temperatureC: 12.8, pressureHPa: null }))
      .toBeNull();
    expect(padPressureIssue({ launchAltitudeM: ft(8800), temperatureC: null, pressureHPa: null }))
      .toBeNull();
    expect(padPressureIssue({ launchAltitudeM: 9000, pressureHPa: null })).toBeNull();
  });

  it('says nothing when the temperature is blank and the pressure is plausible', () => {
    // The former 'blank-temperature' branch: 878 mbar at 1,190 m and 730 at
    // 2,682 m are those sites' own standard pressures.
    expect(padPressureIssue({ launchAltitudeM: 1190, temperatureC: null, pressureHPa: 878 }))
      .toBeNull();
    expect(padPressureIssue({ launchAltitudeM: 2682, pressureHPa: 730 })).toBeNull();
  });

  it('still says nothing at a low site', () => {
    expect(padPressureIssue({ launchAltitudeM: ft(700), temperatureC: 15, pressureHPa: null }))
      .toBeNull();
    expect(padPressureIssue({ launchAltitudeM: 0, temperatureC: 23.3, pressureHPa: null })).toBeNull();
  });

  it('takes 600 m as the boundary, exclusive — for the branch that survives', () => {
    // A sea-level altimeter setting, which is the only thing still reported.
    const at = (h: number) => padPressureIssue({ launchAltitudeM: h, temperatureC: 20, pressureHPa: 1013 });
    expect(at(PAD_PRESSURE_SITE_M)).toBeNull();
    expect(at(PAD_PRESSURE_SITE_M + 1)).toBe('sea-level');
  });
});

describe('padPressureIssue — the altimeter-setting branch', () => {
  /**
   * Wildman2Stage states <Pressure>30</Pressure> at a 3,900 ft site, where a
   * barometer reads about 25.94 in-Hg. 50k states 30.1 at 3,907 ft, and
   * Comp_Rocket 29.91 at 4,595 ft. All three are sea-level settings.
   */
  it('fires on a sea-level pressure at a high site', () => {
    expect(padPressureIssue({ launchAltitudeM: ft(3900), temperatureC: 32.2, pressureHPa: inHg(30) }))
      .toBe('sea-level');
    expect(padPressureIssue({ launchAltitudeM: ft(3907), temperatureC: 26.7, pressureHPa: inHg(30.1) }))
      .toBe('sea-level');
    expect(padPressureIssue({ launchAltitudeM: ft(4595), temperatureC: 23.3, pressureHPa: inHg(29.91) }))
      .toBe('sea-level');
    // 29.53 in-Hg at 3,848 ft (OR vs RAS Test 1) is 13.6 % over that site's
    // own standard — still an altimeter setting, just a low-pressure day's.
    expect(padPressureIssue({ launchAltitudeM: ft(3848), temperatureC: 35, pressureHPa: inHg(29.53) }))
      .toBe('sea-level');
  });

  /**
   * Two testers typed the real thing, and the note must leave them alone:
   * SS Wild Bash 25.94 in-Hg at 3,904 ft, StratoSpear 24.5333 at 5,400 ft —
   * both within 0.1 % of that site's standard pressure.
   */
  it('says nothing about a plausible station pressure at a high site', () => {
    expect(padPressureIssue({ launchAltitudeM: ft(3904), temperatureC: 7.3, pressureHPa: inHg(25.94) }))
      .toBeNull();
    expect(padPressureIssue({ launchAltitudeM: ft(5400), temperatureC: 4.3, pressureHPa: inHg(24.5333) }))
      .toBeNull();
  });

  it('says nothing about a LOW reading — that is what weather and height look like', () => {
    // 10 % BELOW the site's standard: a deep low, or simply a colder column.
    const h = ft(5000);
    expect(padPressureIssue({ launchAltitudeM: h, temperatureC: 5, pressureHPa: isaPressurePa(h) * 0.9 / 100 }))
      .toBeNull();
  });

  it('says nothing about a sea-level pressure at a LOW site', () => {
    // 29.92 in-Hg at 700 ft is a perfectly ordinary reading — and below the
    // 600 m gate it would not be worth a line even if it were not.
    expect(padPressureIssue({ launchAltitudeM: ft(700), temperatureC: 15, pressureHPa: inHg(29.92) }))
      .toBeNull();
  });

  it('clears real weather by the stated margin', () => {
    const h = 1200;
    const std = isaPressurePa(h) / 100;
    const at = (mbar: number) => padPressureIssue({ launchAltitudeM: h, temperatureC: 20, pressureHPa: mbar });
    expect(at(std * (1 + PAD_PRESSURE_SEA_LEVEL_MARGIN))).toBeNull(); // on the line: allowed
    expect(at(std * (1 + PAD_PRESSURE_SEA_LEVEL_MARGIN) + 1)).toBe('sea-level');
    // A strong high over a 1,200 m site — +3 % — is weather, not a mistake.
    expect(at(std * 1.03)).toBeNull();
  });
});

/**
 * THE STRATOSPHERE (2026-09-08, from review).
 *
 * `isaPressurePa` used to be one tropospheric power law with only a LOWER
 * clamp, so it was wrong the moment the profile stopped lapsing and NaN once
 * the extrapolated temperature went negative (T = 288.15 - 0.0065 h reaches
 * 0 K at 44,331 m, and Math.pow of a negative base to a fractional exponent is
 * NaN). That was reachable from a file, not just from a typo: rasaeroFile.ts
 * feeds <Altitude> through unclamped and the Site altitude field's 10,000 m
 * `max` only rejects TYPED text.
 *
 * Anchors are the published ISA layer values, which the layered model has to
 * reproduce exactly — they are what "on a standard day" means in the copy this
 * module feeds.
 */
describe('ISA station pressure above the troposphere', () => {
  it('matches the published ISA at every layer boundary', () => {
    expect(isaPressurePa(0)).toBeCloseTo(101325, 3);
    expect(isaPressurePa(5000)).toBeCloseTo(54019.9, 0);   // mid-troposphere
    expect(isaPressurePa(11000)).toBeCloseTo(22632.06, 1); // tropopause
    expect(isaPressurePa(20000)).toBeCloseTo(5474.885, 2); // top of the isothermal layer
    expect(isaPressurePa(32000)).toBeCloseTo(868.02, 2);   // top of the +1 K/km layer
    expect(isaPressurePa(47000)).toBeCloseTo(110.91, 2);
  });

  it('matches the published ISA temperature at the same boundaries', () => {
    expect(isaTemperatureK(0)).toBeCloseTo(288.15, 6);
    expect(isaTemperatureK(5000)).toBeCloseTo(255.65, 6);
    expect(isaTemperatureK(11000)).toBeCloseTo(216.65, 6);
    expect(isaTemperatureK(20000)).toBeCloseTo(216.65, 6); // isothermal, not still falling
    expect(isaTemperatureK(32000)).toBeCloseTo(228.65, 6); // rising again
  });

  /**
   * What the single power law actually quoted, measured: 61.87 mbar at
   * 60,000 ft where the truth is 71.72 (-13.7 %), and 2.24 mbar at 100,000 ft
   * where the truth is 10.90 (-79 %).
   */
  it('no longer under-reads the pressure the old power law quoted', () => {
    const old = (h: number) => 101325 * Math.pow((288.15 - 0.0065 * h) / 288.15, 9.80665 / (0.0065 * 287.053));
    expect(isaPressurePa(18288) / 100).toBeCloseTo(71.72, 1); // 60,000 ft
    expect(old(18288) / 100).toBeCloseTo(61.87, 1);
    expect(isaPressurePa(30480) / 100).toBeCloseTo(10.90, 1); // 100,000 ft
    expect(old(30480) / 100).toBeCloseTo(2.24, 1);
  });

  /**
   * The reproduction from the review: a .CDX1 stating <Altitude>150000</Altitude>
   * (45,720 m) made the import note read "about NaN mbar (NaN in-Hg) there on a
   * standard day". `toFixed` on a NaN is the string "NaN", so nothing downstream
   * caught it.
   */
  it('is finite at the altitude that used to produce NaN', () => {
    const h = 150000 / 3.28084; // 45,720 m — past the 44,331 m zero-kelvin point
    expect(Number.isFinite(isaPressurePa(h))).toBe(true);
    expect(isaPressurePa(h)).toBeCloseTo(130.5, 0);
    expect((isaPressurePa(h) / 100).toFixed(0)).not.toBe('NaN');
    expect(Number.isFinite(isaTemperatureK(h))).toBe(true);
  });

  it('is total: finite for every input, clamped at both ends', () => {
    for (const h of [NaN, Infinity, -Infinity, -1e9, 1e9, 84852, 100000]) {
      expect(Number.isFinite(isaPressurePa(h)), `pressure at ${h}`).toBe(true);
      expect(isaPressurePa(h), `pressure at ${h}`).toBeGreaterThan(0);
      expect(Number.isFinite(isaTemperatureK(h)), `temperature at ${h}`).toBe(true);
      expect(isaTemperatureK(h), `temperature at ${h}`).toBeGreaterThan(0);
    }
    // Clamped, not extrapolated: below sea level reads sea level, above the top
    // of the modelled profile reads the top.
    expect(isaPressurePa(-100)).toBeCloseTo(101325, 6);
    expect(isaPressurePa(NaN)).toBeCloseTo(101325, 6);
    expect(isaPressurePa(1e9)).toBeCloseTo(isaPressurePa(ISA_TOP_M), 12);
    expect(isaTemperatureK(1e9)).toBeCloseTo(186.95, 6);
  });

  it('falls monotonically all the way up, layer joins included', () => {
    let last = Infinity;
    for (let h = 0; h <= ISA_TOP_M; h += 100) {
      const p = isaPressurePa(h);
      expect(p, `pressure at ${h} m`).toBeLessThan(last);
      last = p;
    }
  });

  /** The layers join without a step — each boundary is one pressure, not two. */
  it('is continuous across every layer boundary', () => {
    for (const h of [11000, 20000, 32000, 47000, 51000, 71000, 84852]) {
      // A hair BELOW the boundary is evaluated by the layer beneath it and a
      // hair above by the layer on top, so this is the join itself. The offset
      // has to be small against the real gradient: dp/p is -1.58e-4 per metre
      // at 11 km, which is why a 1 mm offset already shows 1.6e-7 of honest
      // barometry and would drown a step.
      expect(isaPressurePa(h - 1e-7) / isaPressurePa(h), `p at ${h} m`).toBeCloseTo(1, 9);
      expect(isaTemperatureK(h - 1e-7) - isaTemperatureK(h), `T at ${h} m`).toBeCloseTo(0, 6);
    }
  });
});

/**
 * THE MIRROR OF THE BLANK-PRESSURE TRAP (2026-09-08, from review).
 *
 * `ExtendedISAModel(alt, T, p)` writes the value it was given straight into
 * baseTemperature[1] at layer[1] = alt, so the field left blank — filled with
 * the sea-level standard — is what the PAD reads. With the temperature blank
 * that is 288.15 K at the pad however high the site, and the v0.120 help
 * promised the opposite while telling the reader to type a station pressure.
 */
/**
 * The altimeter-setting branch is now the ONLY thing padPressureIssue reports,
 * and it is reported regardless of what the temperature field holds — there is
 * no longer a second issue for it to outrank.
 */
describe('padPressureIssue — the altimeter setting is reported on its own terms', () => {
  it('fires whether or not a temperature sits beside it', () => {
    expect(padPressureIssue({ launchAltitudeM: 1190, temperatureC: null, pressureHPa: 1015.9 }))
      .toBe('sea-level');
    expect(padPressureIssue({ launchAltitudeM: 1190, temperatureC: 20, pressureHPa: 1015.9 }))
      .toBe('sea-level');
  });

  it('says nothing when both fields are given and both are plausible', () => {
    expect(padPressureIssue({ launchAltitudeM: 2682, temperatureC: -2.4, pressureHPa: 730 }))
      .toBeNull();
  });
});

/**
 * The measurement the copy quotes. With a station pressure typed and the
 * temperature blank the pad flies 288.15 K instead of the lapsed value, so the
 * air is thin by exactly T_isa/288.15 - 1 and the speed of sound high by the
 * square root of the same ratio.
 */
describe('what the blank temperature costs', () => {
  const R = 287.053;
  it('is 6.05 % on density and 3.17 % on the speed of sound at 2,682 m', () => {
    const h = 2682;
    const p = isaPressurePa(h);
    const rhoRight = p / (R * isaTemperatureK(h));
    const rhoWrong = p / (R * 288.15);
    expect(isaTemperatureK(h)).toBeCloseTo(270.72, 2);
    expect(rhoRight).toBeCloseTo(0.9393, 4);
    expect(rhoWrong).toBeCloseTo(0.8824, 4);
    expect((rhoWrong / rhoRight - 1) * 100).toBeCloseTo(-6.05, 2);
    const aRatio = Math.sqrt(288.15 / isaTemperatureK(h));
    expect((aRatio - 1) * 100).toBeCloseTo(3.17, 2);
  });

  it('is 2.68 % on density at 1,190 m', () => {
    const h = 1190;
    expect(isaTemperatureK(h)).toBeCloseTo(280.415, 3);
    expect((isaTemperatureK(h) / 288.15 - 1) * 100).toBeCloseTo(-2.68, 2);
  });
});

/**
 * THE PAD'S AIR, ONCE (audit 2026-09-22). `padAir` is what the flight is
 * handed (kernelSimOptions) and what a canopy is sized in (siteAirDensity), so
 * its rules are asserted here once rather than in each caller.
 */
describe('padAir — one reading of the pad for the flight and the sizing', () => {
  it('fills each blank field from the SITE altitude, independently', () => {
    const h = 2682;
    // The two *FromSite flags (weather build, step 3) say which half was the
    // site's fill — the weather review's "(standard for …)" note reads them.
    expect(padAir({ launchAltitudeM: h, temperatureC: 30, pressureHPa: null })).toEqual({
      altitudeM: h, temperatureK: 303.15, pressurePa: isaPressurePa(h), standard: false,
      temperatureFromSite: false, pressureFromSite: true,
    });
    expect(padAir({ launchAltitudeM: h, temperatureC: null, pressureHPa: 730 })).toEqual({
      altitudeM: h, temperatureK: isaTemperatureK(h), pressurePa: 73000, standard: false,
      temperatureFromSite: true, pressureFromSite: false,
    });
    expect(padAir({ launchAltitudeM: h, temperatureC: null, pressureHPa: null })).toEqual({
      altitudeM: h, temperatureK: isaTemperatureK(h), pressurePa: isaPressurePa(h), standard: true,
      temperatureFromSite: true, pressureFromSite: true,
    });
    // An out-of-envelope value is flown as the site's, so it is flagged as such.
    expect(padAir({ launchAltitudeM: h, temperatureC: 99, pressureHPa: 730 })).toMatchObject({
      temperatureFromSite: true, pressureFromSite: false, standard: false,
    });
  });

  it('reads NaN and absent as blank, never as a number', () => {
    const h = 1190;
    const blank = padAir({ launchAltitudeM: h, temperatureC: null, pressureHPa: null });
    expect(padAir({ launchAltitudeM: h, temperatureC: NaN, pressureHPa: NaN })).toEqual(blank);
    expect(padAir({ launchAltitudeM: h })).toEqual(blank);
  });

  /**
   * The .CDX1 unit mistakes the audit measured flying raw: hPa typed into
   * RASAero's in-Hg field (1013.25 in-Hg = 34,313 hPa, 34x sea-level density)
   * and a °F figure no launch site reads (-300 °F = -184.4 °C, 88.7 K).
   */
  it('reads a value outside the panel’s own envelope as blank — the site’s standard day', () => {
    const h = 1500;
    const blank = padAir({ launchAltitudeM: h, temperatureC: null, pressureHPa: null });
    expect(padAir({ launchAltitudeM: h, temperatureC: null, pressureHPa: 1013.25 * 33.8639 })).toEqual(blank);
    expect(padAir({ launchAltitudeM: h, temperatureC: (-300 - 32) * 5 / 9, pressureHPa: null })).toEqual(blank);
    // The bounds themselves are inside: the envelope is closed, as the fields are.
    expect(padAir({ launchAltitudeM: h, temperatureC: PAD_TEMP_C_RANGE[0] }).temperatureK)
      .toBeCloseTo(PAD_TEMP_C_RANGE[0] + 273.15, 9);
    expect(padAir({ launchAltitudeM: h, pressureHPa: PAD_PRESSURE_HPA_RANGE[1] }).pressurePa)
      .toBe(PAD_PRESSURE_HPA_RANGE[1] * 100);
    expect(padAir({ launchAltitudeM: h, pressureHPa: PAD_PRESSURE_HPA_RANGE[1] + 0.01 }).standard).toBe(true);
  });

  it('clamps the altitude into the Site altitude field’s range and evaluates the air there', () => {
    const top = SITE_ALTITUDE_M_RANGE[1];
    const high = padAir({ launchAltitudeM: 150000 / FT, temperatureC: null, pressureHPa: null });
    expect(high.altitudeM).toBe(top);
    expect(high.pressurePa).toBe(isaPressurePa(top));
    expect(padAir({ launchAltitudeM: -50 }).altitudeM).toBe(SITE_ALTITUDE_M_RANGE[0]);
    expect(padAir({ launchAltitudeM: NaN }).altitudeM).toBe(0);
  });

  it('does not caution over a stored pressure it would not fly', () => {
    // padPressureIssue reads the same envelope: 34,313 hPa is flown as blank,
    // so calling it "about sea-level pressure" would describe a flight that is
    // not happening.
    expect(padPressureIssue({ launchAltitudeM: 1500, pressureHPa: 1013.25 * 33.8639 })).toBeNull();
    expect(padPressureIssue({ launchAltitudeM: 1500, pressureHPa: 1013 })).toBe('sea-level');
  });
});

/**
 * DENSITY ALTITUDE (weather build, step 1) — every figure below was worked by
 * hand from the app's own constants (R 287.053, g 9.80665, ISA 288.15 K /
 * 101,325 Pa) and is the number the readout, the launch report and the saved
 * runs show. The inverse is exact, so a standard day must read its own site.
 */
describe('isaAltitudeForDensity — the ISA profile, inverted', () => {
  const rhoAt = (h: number) => isaPressurePa(h) / (R_AIR * isaTemperatureK(h));

  it('reads standard sea-level density as sea level — 1.22499946, not 1.225', () => {
    expect(rhoAt(0)).toBeCloseTo(1.22499946, 8);
    expect(Math.abs(isaAltitudeForDensity(rhoAt(0)))).toBeLessThan(1e-9);
  });

  it('round-trips the profile through every layer to well under a micrometre', () => {
    for (const h of [0, 600, 1219.2, 2682, 5000, 10000, 11000, 15000, 20000, 25000, 40000]) {
      expect(Math.abs(isaAltitudeForDensity(rhoAt(h)) - h), `h ${h} m`).toBeLessThan(1e-6);
    }
  });

  it('answers NaN for air that does not exist, rather than a figure', () => {
    for (const rho of [0, -1, NaN, Infinity]) expect(isaAltitudeForDensity(rho)).toBeNaN();
  });

  // The guide's §Atmosphere prints the troposphere inverse in closed form
  // (spec §1.7). Read off the guide itself, so the printed constants cannot
  // drift from the code: within a centimetre of the layered inverse, and the
  // n and 288.15 K ÷ 0.0065 K/m it says they come from.
  it('is the closed form the guide prints, through the troposphere', () => {
    const guide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'user-guide.md'), 'utf8');
    const form = guide.match(/h = ([\d,.]+) m · \(1 − \(ρ\/ρ₀\)\^([\d.]+)\)/);
    const rho0 = guide.match(/`ρ₀` = ([\d.]+) kg\/m³/);
    const n = guide.match(/`n = g\/\(0\.0065·R\)` = ([\d.]+)/);
    expect(form && rho0 && n, 'the guide states h, ρ₀ and n').toBeTruthy();
    const scale = Number(form![1]!.replace(/,/g, ''));
    const exponent = Number(form![2]);
    expect(scale).toBeCloseTo(288.15 / 0.0065, 2);
    expect(Number(n![1])).toBeCloseTo(G0 / (0.0065 * R_AIR), 6);
    expect(exponent).toBeCloseTo(1 / (G0 / (0.0065 * R_AIR) - 1), 7);
    expect(Number(rho0![1])).toBeCloseTo(rhoAt(0), 8);
    for (const h of [0, 600, 1219.2, 2170.81, 5000, 10000, 11000]) {
      const closed = scale * (1 - Math.pow(rhoAt(h) / Number(rho0![1]), exponent));
      expect(Math.abs(closed - isaAltitudeForDensity(rhoAt(h))), `h ${h} m`).toBeLessThan(0.01);
    }
  });
});

describe('densityAltitudeM — the pad air the flight flies, as an altitude', () => {
  const FEET = 0.3048;
  const da = (launchAltitudeM: number, temperatureC: number | null, pressureHPa: number | null) =>
    densityAltitudeM({ launchAltitudeM, temperatureC, pressureHPa });

  it('reads the worked example: a 4,000 ft field on a 95 °F day is 7,122 ft', () => {
    // p = 101325·(280.2252/288.15)^5.255877 = 87,510.55 Pa (the blank, from
    // the site); ρ = 87,510.55 / (287.053·308.15) = 0.989318; ρ/ρ0 0.807607.
    const h = da(1219.2, 35, null);
    expect(h).toBeCloseTo(2170.81, 2);
    expect(h / FEET).toBeCloseTo(7122.1, 1);
    // The same air typed as a pressure instead of left for the site to fill.
    expect(da(1219.2, 35, 875.105)).toBeCloseTo(2170.82, 1);
  });

  it('matches the hand-worked table, including below sea level and above 11 km', () => {
    const cases: Array<[number, number | null, number | null, number]> = [
      [0, 30, null, 525.46],
      // A cold sea-level day is denser than a standard one: NEGATIVE, not clamped.
      [0, -20, null, -1369.64],
      // An altimeter setting typed as the station pressure at 1,190 m.
      [1190, null, 1013.25, -284.34],
      // The audit's 2,682 m / 30 °C case (ρ 0.83878).
      [2682, 30, null, 3774.75],
      // 300 hPa is above 11 km: layered, where the troposphere alone says 12,142.7.
      [0, 60, 300, 11941.60],
      [0, -60, 1100, -4181.69],
      // 5,000 ft on a 90 °F day.
      [1524, 32.2222, null, 2449.60],
    ];
    for (const [h, t, p, want] of cases) {
      expect(da(h, t, p), `${h} m, ${t} °C, ${p} hPa`).toBeCloseTo(want, 1);
    }
  });

  it('is exactly the site altitude with both fields blank — a standard day reads its own site', () => {
    for (const h of [0, 600, 1219.2, 2682, 5000, 10000]) {
      expect(Math.abs(da(h, null, null) - h), `h ${h} m`).toBeLessThan(1e-6);
    }
    // The altitude is clamped the way the flight clamps it.
    expect(da(20000, null, null)).toBeCloseTo(10000, 6);
  });

  it('reads the fields the way the flight does: an out-of-envelope value is blank', () => {
    // 34,313 hPa (hPa typed into RASAero's in-Hg field) flies as the site's
    // standard day, so that is what the readout must describe.
    expect(da(1500, null, 1013.25 * INHG)).toBeCloseTo(1500, 6);
  });

  it('describes the same air the kernel is handed and the recovery sizing divides', () => {
    // One reading of the pad, three readers: for every blank/typed combination
    // at three sites, padAir's density = siteAirDensity = p/(R·T) of what
    // kernelSimOptions hands the kernel whenever either field is typed.
    for (const h of [0, 1190, 2682]) {
      for (const [t, p] of [[null, null], [25, null], [null, 850], [25, 850]] as const) {
        const l = { ...DEFAULT_CONDITIONS, launchAltitudeM: h, temperatureC: t, pressureHPa: p };
        const air = padAir(l);
        const rho = air.pressurePa / (R_AIR * air.temperatureK);
        expect(siteAirDensity(l)).toBe(rho);
        const o = kernelSimOptions(l);
        if (t !== null || p !== null) expect(o.pressure! / (R_AIR * o.temperature!)).toBe(rho);
        expect(densityAltitudeM(l)).toBe(isaAltitudeForDensity(rho));
      }
    }
  });
});
