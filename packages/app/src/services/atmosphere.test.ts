import { describe, expect, it } from 'vitest';
import {
  isaPressurePa,
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

describe('padPressureIssue — the blank-pressure branch', () => {
  it('fires when a temperature is typed and the pressure is blank at altitude', () => {
    expect(padPressureIssue({ launchAltitudeM: ft(3900), temperatureC: 32.2, pressureHPa: null }))
      .toBe('blank');
    expect(padPressureIssue({ launchAltitudeM: ft(8800), temperatureC: 12.8, pressureHPa: null }))
      .toBe('blank');
  });

  /**
   * The whole point of the finding: BOTH blank is the correct input — the
   * kernel then computes the pad's pressure from the site altitude. Only a
   * typed temperature turns the blank into sea-level air.
   */
  it('says nothing when the temperature is blank too, however high the site', () => {
    expect(padPressureIssue({ launchAltitudeM: ft(8800), temperatureC: null, pressureHPa: null }))
      .toBeNull();
    expect(padPressureIssue({ launchAltitudeM: 9000, pressureHPa: null })).toBeNull();
  });

  it('says nothing at a low site', () => {
    // 700 ft with a temperature and no pressure — the vb38 fixture's shape.
    expect(padPressureIssue({ launchAltitudeM: ft(700), temperatureC: 15, pressureHPa: null }))
      .toBeNull();
    expect(padPressureIssue({ launchAltitudeM: 0, temperatureC: 23.3, pressureHPa: null })).toBeNull();
  });

  it('takes 600 m as the boundary, exclusive', () => {
    const at = (h: number) => padPressureIssue({ launchAltitudeM: h, temperatureC: 20, pressureHPa: null });
    expect(at(PAD_PRESSURE_SITE_M)).toBeNull();
    expect(at(PAD_PRESSURE_SITE_M + 1)).toBe('blank');
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
