import { G0, ISA_SEA_LEVEL } from '@online-openrocket/engine';

/**
 * THE PAD'S OWN AIR — one definition, shared by the Launch panel's caution and
 * the RASAero import note, so the two can never disagree about what counts as
 * a wrong pad pressure.
 *
 * Why this module exists (2026-09-08). The kernel takes the launch-site
 * temperature and pressure as a PAIR: `OrkEngine.simulateJson` (ll. 919-926)
 * builds `ExtendedISAModel(launchAltitude, T, p)` as soon as EITHER field is
 * given, and fills the missing one with the STANDARD SEA-LEVEL value — applied
 * at the site altitude, not reduced to it. So a typed temperature with a blank
 * pressure puts 101,325 Pa at the pad however high the site: measured, a
 * 1,190 m pad reads 87,854 Pa with both fields blank and 101,356 Pa with only a
 * temperature typed, and a 2,682 m pad reads 73,018 Pa against 101,354 Pa. The
 * air then comes out ~15 % too dense and the motor loses the pressure-thrust
 * credit thin air owes it (v0.119's term), which on the MESOS file was worth
 * 29.7 % of apogee.
 *
 * That matters most on imported RASAero files, because RASAero writes a
 * temperature into every file and a pressure into fewer than half: of the 60
 * tester .CDX1 files measured for the user guide, all 60 state a temperature
 * and 25 state a pressure, and 24 of the 33 flown from 1,000 ft or higher
 * state none.
 *
 * `siteAirDensity` in recoverySizing.ts mirrors the same kernel branch and now
 * takes its barometric formula from here rather than keeping a second copy.
 */

/** Specific gas constant for dry air (J/kg/K) — the kernel's `AtmosphericConditions.R`. */
const R_AIR = 287.053;

/** ISA tropospheric lapse rate as a positive number (K/m). */
const LAPSE = -ISA_SEA_LEVEL.lapseRateKPerM;

/**
 * Standard (ISA) station pressure at a site altitude, in pascals — what a
 * barometer standing at that altitude reads on a standard day.
 *
 * `p = p0 · (T/T0)^(g / (L·R))`, the barometric formula rearranged from
 * `ExtendedISAModel.calculatePressure` (24.12, ll. 191-200), whose
 * `1 + (alt2−alt1)·tempRate/temp1` collapses to `T0/T` inside a lapse layer.
 * Evaluated analytically; the kernel interpolates the same profile on a 500 m
 * grid, which differs by at most 0.06 % over the site-altitude field's
 * 0-10,000 m range. Only the troposphere is modelled, which covers that whole
 * range.
 */
export function isaPressurePa(altitudeM: number): number {
  const h = Number.isFinite(altitudeM) ? Math.max(0, altitudeM) : 0;
  const tempK = ISA_SEA_LEVEL.temperatureK - LAPSE * h;
  return ISA_SEA_LEVEL.pressurePa * Math.pow(tempK / ISA_SEA_LEVEL.temperatureK, G0 / (LAPSE * R_AIR));
}

/**
 * The site altitude above which a wrong pad pressure is worth saying out loud.
 *
 * 600 m is the owner's call (2026-09-08). It is where the standard station
 * pressure has fallen to 94,322 Pa — 6.9 % below sea level, so ~7 % on air
 * density — which is the point at which "the app is flying sea-level air at
 * your pad" stops being a rounding error. Below it the note would fire on the
 * majority of files for a difference nobody could read in a result.
 */
export const PAD_PRESSURE_SITE_M = 600;

/**
 * How far above the site's OWN standard pressure a stated reading may sit
 * before it is an altimeter setting rather than a barometer reading.
 *
 * 5 %. Station pressure moves with the weather, so the test has to clear real
 * weather by a margin: at the 600 m threshold, ISA is 943.2 mbar and +5 % is
 * 990.4 mbar, which is a sea-level-equivalent of about 1,064 mbar — higher
 * than anything ever recorded outside a Siberian winter (the world record is
 * 1,084.8 mbar, Agata 1968). Nothing a real barometer reads at a real launch
 * site reaches it, so a reading that does was reduced to sea level before it
 * was typed. One-sided on purpose: a LOW reading is what a genuine high site
 * or a deep low actually looks like.
 */
export const PAD_PRESSURE_SEA_LEVEL_MARGIN = 0.05;

/**
 * What is wrong with this site's pad pressure, if anything.
 *
 * - `'blank'` — a temperature is given and the pressure is not, at a site high
 *   enough to matter: the kernel will fly 101,325 Pa at that pad. This is the
 *   one every RASAero import lands in, because RASAero always writes a
 *   temperature.
 * - `'sea-level'` — a pressure IS given, but it is more than
 *   `PAD_PRESSURE_SEA_LEVEL_MARGIN` above what that altitude can read: the
 *   same mistake made by hand, an altimeter setting typed into a station-
 *   pressure field.
 * - `null` — nothing to say: a low site, both fields blank (the kernel then
 *   computes the pad's pressure from the site altitude, which is right), or a
 *   plausible station pressure.
 */
export type PadPressureIssue = 'blank' | 'sea-level';

/**
 * Structural, not `Partial<LaunchConditions>`: LaunchPanel imports this module
 * for its live caution, and taking the type from there would close a cycle
 * between them for no gain. Every caller's shape satisfies this one.
 */
export interface PadConditions {
  launchAltitudeM?: number | null;
  temperatureC?: number | null;
  pressureHPa?: number | null;
}

export function padPressureIssue(launch: PadConditions): PadPressureIssue | null {
  const h = launch.launchAltitudeM;
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= PAD_PRESSURE_SITE_M) return null;
  const p = launch.pressureHPa;
  if (p == null || !Number.isFinite(p)) {
    // Both blank is the CORRECT input — the kernel computes the pad's pressure
    // from the site altitude. Only a typed temperature turns the blank into
    // sea-level air.
    const t = launch.temperatureC;
    return t != null && Number.isFinite(t) ? 'blank' : null;
  }
  return p * 100 > isaPressurePa(h) * (1 + PAD_PRESSURE_SEA_LEVEL_MARGIN) ? 'sea-level' : null;
}
