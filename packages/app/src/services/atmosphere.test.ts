import { describe, expect, it } from 'vitest';
import {
  isaPressurePa,
  isaTemperatureK,
  ISA_TOP_M,
  padPressureIssue,
  PAD_PRESSURE_SEA_LEVEL_MARGIN,
  PAD_PRESSURE_SITE_M,
} from './atmosphere.js';

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
