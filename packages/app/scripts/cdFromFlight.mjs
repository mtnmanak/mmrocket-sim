#!/usr/bin/env node
/**
 * Cd from flight data — recover a drag coefficient vs Mach curve from a rocket
 * accelerometer log.
 *
 * WHERE THE METHOD COMES FROM. Adrian Adamson published the recipe on TRF
 * ("Taking a shot at the G record", post 2504860); Ken (@Buckeye) sent the
 * snippet on via Eric, and it is pasted verbatim in
 * `docs/testing/issues-2026-09-03b.md:48-58`. It is reasoned through in
 * `docs/testing/response-2026-09-03b.md:216-252`. His Matlab, unchanged:
 *
 *     top.axial_Gs       = -top.raw_Gs(:,3)*1.012;
 *     top.axial_velocity = cumsum(-1+top.axial_Gs)*32.17*.002;
 *     dragforce          = -.1245 * top.axial_Gs*9.81;
 *     density            = interp1(wyo_atm(:,2),wyo_atm(:,4),accel_alt);
 *     vms                = top.axial_velocity*.3048;
 *     area               = pi*(1.16/2)^2 * .00064516;
 *     Cd                 = 2 * dragforce./density./vms.^2/area;
 *
 * Restated in SI, which is what this module implements:
 *
 *     a_ax = -Accel_Z . k          [g]    specific force along the nose axis
 *     v(t) = integral (a_ax - 1).g0 dt    [m/s] from liftoff, trapezoid
 *     D    = -m . a_ax . g0        [N]    positive in coast, where a_ax < 0
 *     Cd   = 2.D / (rho . v^2 . A)
 *     A    = pi.d^2/4 ,  M = v/sqrt(gamma.R.T) ,  Re = rho.v.L/mu(T)
 *
 * FOUR THINGS MAKE IT WORK, and each is a way to be wrong:
 *   1. Subtract 1 g before integrating. An accelerometer measures SPECIFIC
 *      FORCE, not acceleration — on the pad it reads +1 g while standing still.
 *   2. A per-flight scale factor k. It absorbs mounting angle and sensor bias.
 *      See --accel-scale: it is a 3 % lever on the answer, not a rounding knob.
 *   3. The MEASURED atmosphere where one exists. ISA from the wrong elevation is
 *      a 25 % error (see R5 and the sea-level trap in the test file).
 *   4. Cd is computed ONLY during coast, where drag is the only axial force.
 *      Which is why --mass-kg is BURNOUT mass, never liftoff mass.
 *
 * THREE DELIBERATE DEVIATIONS FROM THE SNIPPET, each measured, none silent:
 *
 *   - TRAPEZOID, not `cumsum` (which is a rectangle rule). On a linearly
 *     changing axial acceleration the trapezoid is EXACT and the rectangle
 *     rule's relative velocity error is exactly dt/t — 0.25 % at 50 Hz and
 *     t = 8 s, and 5 % at t = 0.4 s, early in a burn where the velocity is
 *     being built. Cd goes as 1/v^2, so that lands on the answer twice over.
 *     Pinned analytically in cdFromFlight.test.mjs ("is a trapezoid, not a
 *     rectangle"), because a round trip on a smooth 500 Hz trace is far too
 *     forgiving to catch the difference.
 *     What sample rate costs END TO END, measured by decimating this file's own
 *     500 Hz trace and re-running the whole extraction (mean Cd, M 0.25-0.72):
 *       500 Hz 0.2258 · 100 Hz 0.2248 (-0.4 %) · 50 Hz 0.2218 (-1.8 %)
 *     Below 50 Hz this file's 2 s pad segment falls under MIN_PAD_SAMPLES, so
 *     the trend is not measured further here. Real altimeters log at 20-100 Hz,
 *     which is why MIN_RATE_HZ refuses and WARN_RATE_HZ stamps the report.
 *   - g0 = 9.80665 throughout, not the snippet's mixed 32.17 ft/s^2 (= 9.80546)
 *     and 9.81 m/s^2. Worth 0.01 % and 0.03 %; one constant per quantity.
 *   - Diameter is an ARGUMENT and is never hard-coded. Adrian's snippet says
 *     1.16 in and he later corrected it to 1.17 (the figure in the build thread
 *     and in `G record 2023.CDX1`); that alone is 1.7 % on Cd.
 *
 * WHAT IT REFUSES, AND WHY IT REFUSES LOUDLY. Every refusal below (R1-R10) was
 * reachable from files already sitting in `docs/User files/` when this was
 * written — two Featherweight GPS tracks, a RASAero II simulation export and an
 * MMRocket Sim CSV export are all things a tester will drop on this first, and
 * all four would otherwise produce a confident wrong number. There is no
 * guessing anywhere in this file: an unknown unit throws, a missing density
 * source throws, a too-slow log throws.
 *
 * Usage:
 *   node packages/app/scripts/cdFromFlight.mjs <accel.csv> --mass-kg N --diameter-in N \
 *        [--baro <low_rate.csv>] [--length-m N] [--site-elevation-m N] [--pad-temp-c N] \
 *        [--accel-scale pad|none|<num>] [--burnout-s N] [--apogee-s N] [--settle-s N] \
 *        [--altitude-unit ft|m] [--mach-band lo,hi] [--csv <out>] [--json]
 *
 * The CLI lives in main() behind an entry-point guard so every function here can
 * be imported and unit-tested; importing this module must never run the CLI or
 * call process.exit. (`scripts/bbcode-from-blurb.mjs` learned that the hard way —
 * its top-level CLI body used to exit(1) on import, which is why its rules had no
 * test at all. Same guard, same reason.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Constants. Every one carries its provenance: this repo has been bitten
// repeatedly by numbers nobody could trace.
//
// These are COPIED from the engine rather than imported. No sibling script in
// this directory imports @online-openrocket/engine, and doing so would drag the
// 2.5 MB TeaVM kernel into a CSV tool. The copy is pinned against the engine
// source by cdFromFlight.test.mjs test 1, which reads index.ts as text.
// ─────────────────────────────────────────────────────────────────────────────

/** Standard gravitational acceleration, m/s^2 — `packages/engine/src/index.ts` `G0`. */
export const G0 = 9.80665;

/** ISA sea-level temperature, K — `ISA_SEA_LEVEL.temperatureK` (+15 C). */
export const ISA_T0 = 288.15;

/** ISA sea-level pressure, Pa — `ISA_SEA_LEVEL.pressurePa`. */
export const ISA_P0 = 101325;

/**
 * ISA troposphere lapse rate as a POSITIVE K/m. The engine stores it SIGNED
 * (`ISA_SEA_LEVEL.lapseRateKPerM = -0.0065`); this file, like
 * `packages/app/src/services/recoverySizing.ts:56`, keeps it positive and says
 * so, because `T0 - LAPSE*h` reads correctly and `T0 + LAPSE*h` does not.
 */
export const LAPSE = 0.0065;

/**
 * Specific gas constant of dry air, J/(kg.K) — `AtmosphericConditions.R` in
 * OpenRocket 24.12 (`core/.../models/atmosphere/AtmosphericConditions.java:16`),
 * and the divisor in the shipped kernel
 * (`packages/engine/vendor/orkengine.mjs:39534`:
 * `$this.$getPressure() / (287.053 * $this.$getTemperature())`).
 * Not 287.05 — the difference is 0.001 %, but two constants for one physical
 * quantity is how a number starts disagreeing with itself across screens.
 * Same reasoning as `recoverySizing.ts:47-53`.
 */
export const R_AIR = 287.053;

/** Ratio of specific heats for diatomic air, for a = sqrt(gamma.R.T). */
export const GAMMA = 1.4;

/**
 * Dynamic viscosity of air as mu(T) = MU_A + MU_B.T  [Pa.s].
 * OpenRocket 24.12 `AtmosphericConditions.getKinematicViscosity()` (ll. 119-121),
 * a linear fit to Sutherland's formula which that source states is "highly
 * linear" over -40...+40 C. COPY THAT CAVEAT: above ~313 K it drifts. It only
 * ever feeds the REPORTED Reynolds number here, never Cd, so a drift in it
 * cannot move the answer.
 */
export const MU_A = 3.7291e-06;
export const MU_B = 4.9944e-08;

/** Unit conversions. One definition each; no 32.17 anywhere. */
export const FT = 0.3048;
export const IN = 0.0254;
export const ATM_PA = 101325;

/** Feet per second squared in one g — derived, so it cannot drift from G0. */
export const FT_S2_PER_G = G0 / FT; // 32.17405...

/**
 * Below M 0.15 the axial accel is under 0.1 g and the extraction is noise —
 * `docs/research/trf-flight-data-2026-08-25.md:49-51`, which also rules "do not
 * gate there". Samples below it are DROPPED, not reported.
 */
export const MACH_FLOOR = 0.15;

/**
 * The Mach band the headline mean is quoted over. It is the band the prior
 * independent extraction used (`trf-flight-data-2026-08-25.md:46`, mean 0.226),
 * so the summary line is directly comparable to that and to Adrian's own
 * published 0.225 (Chuck Rogers, TRF #126).
 */
export const REPORT_BAND = [0.25, 0.72];

/**
 * SETTLING GUARD, seconds after burnout. MEASURED on both flights, and the
 * least obvious number in this file.
 *
 * The altimeter's own burnout flag AND the axial zero-crossing both fire while
 * the motor is still tailing off, so Cd climbs into its plateau afterwards.
 * Measured per-sample with --settle-s 0, Cd against t:
 *   F10 2023 (detector 8.176, flag 8.24):
 *     0.053 @8.20 · 0.105 @8.24 · 0.180 @8.34 · 0.195 @8.44 · 0.199 @8.54 ·
 *     0.201 @8.64 · 0.208 @8.74 · 0.209 @9.00 — a 0.21 plateau
 *   G12 2024 (detector 12.162, flag 12.14):
 *     0.034 @12.20 · 0.056 @12.24 · 0.132 @12.34 · 0.179 @12.44 · 0.200 @12.54 ·
 *     0.206 @12.64 · 0.207 @13.00
 * Both settle in about 0.4 s. Without this guard the FASTEST, most interesting
 * samples are the most wrong: the 2024 file's M 0.85-0.95 bin reads 0.176 and
 * its M 0.95-1.05 bin reads 0.020, against that 0.205 plateau. The cost is
 * stated in the report — the F10's usable peak drops from M 0.790 to M 0.752.
 */
export const SETTLE_S = 0.40;

/** Burnout detector: smoothing window and the negative-hold it must survive. */
export const SMOOTH_S = 0.05;
export const HOLD_S = 0.25;

/** Burnout is never looked for before this — no motor burns out in 0.5 s here. */
export const BURNOUT_MIN_T = 0.5;

/**
 * Sample-rate limits. Measured end to end on the F10 file (module docblock):
 * 100 Hz costs 0.4 % on mean Cd and 50 Hz costs 1.8 %, so below 50 Hz the number
 * is worth reporting only with a stamp on it. By 10 Hz a single sample spans
 * about 25 m of a coast whose density is changing under it, and the answer is
 * not worth reporting at all.
 */
export const MIN_RATE_HZ = 10;
export const WARN_RATE_HZ = 50;

/**
 * Accelerometer unit detection. A rocket sitting on the pad reads exactly 1 g
 * of specific force, so the unit is a MEASUREMENT, not a guess. 15 % is wide
 * enough for a mis-calibrated board (both Blue Ravens read 0.9932) and far
 * narrower than the 9.8x and 32x gaps between the three candidates.
 */
export const UNIT_TOL = 0.15;
const ACCEL_UNITS = [
  { unit: 'g', perG: 1 },
  { unit: 'm/s2', perG: G0 },
  { unit: 'ft/s2', perG: FT_S2_PER_G },
];

/** Pad-static window: samples before this time are "on the pad". */
export const PAD_END_S = -0.2;

/** Fewer than this many pad samples and the trace has no initial condition (R7). */
export const MIN_PAD_SAMPLES = 50;

/**
 * How far the barometric and inertial peak altitudes may disagree before R10
 * refuses. Wide on purpose: the two share no input and drift apart honestly
 * (on the Adamson F10 their apogee TIMES differ by 1.2 s). It exists to catch a
 * unit error, which is a factor of 3.28 - not to police agreement.
 */
export const ALT_AGREE_MAX = 1.8;

/** More than this fraction of accepted coast samples with Cd <= 0 means R8. */
export const NEGATIVE_CD_LIMIT = 0.05;

/**
 * A Mach bin covering less than this much coast is flagged `*` in the report.
 *
 * Stated as TIME, not sample count, so it means the same thing on a 500 Hz board
 * and a 50 Hz one. The F10's top bin is the live example: it holds 8 samples
 * spanning 0.01 s, and printing "M 0.75-0.85  Cd 0.204" beside six bins built
 * from hundreds of samples each would invite somebody to quote it. Flagged
 * rather than dropped — silently discarding the fastest samples is how a curve
 * loses the end everybody actually wants.
 */
const THIN_BIN_S = 0.10;

/** Default Mach bin edges: 0.10 wide from the noise floor up past Mach 1. */
const DEFAULT_BIN_EDGES = (() => {
  const e = [];
  for (let m = MACH_FLOOR; m < 1.351; m += 0.10) e.push(Number(m.toFixed(2)));
  return e;
})();

/**
 * The scale-factor perturbation the report's error budget quotes. 1.012 is
 * Adrian's own GPS-fitted factor (TRF #130) and the value that reproduces his
 * published Cd, so "what if I used his k instead of mine" is the question a
 * reader of this report actually has.
 */
const SCALE_SENSITIVITY_K = 1.012;

/** Mass and diameter perturbations for the error budget, both from the F10 case. */
const MASS_SENSITIVITY_KG = 0.005; // +-5 g: 124.5 g is launch mass minus a catalogue
//                                    propellant figure, not a scale reading.
const DIAM_SENSITIVITY_IN = 0.03; // 1.17 -> 1.20 in, the spread across sources.

// ─────────────────────────────────────────────────────────────────────────────
// Failure. Every refusal carries a code so a caller (and the test file) can tell
// them apart, and a message that says how to fix it rather than what went wrong.
// ─────────────────────────────────────────────────────────────────────────────

/** Throw a coded refusal. `code` is R1..R10; it is also set on the Error. */
function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  throw err;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a CSV into a header and rows. Deliberately not a general CSV parser:
 * these logs have no quoted fields (verified across all four files on disk), and
 * a ragged row means the file is truncated or the wrong file, not that it needs
 * repairing. So a width mismatch THROWS naming the line — it never pads or
 * truncates, because a silently padded row becomes a silently wrong sample.
 */
export function parseCsv(text) {
  // Strip a UTF-8 BOM: a byte-order mark on the first header cell turns
  // `Flight_Time_(s)` into a name that matches nothing, and the failure looks
  // like a missing column rather than an encoding one.
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  let header = null;
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const cells = line.split(',');
    if (header === null) {
      header = cells;
      continue;
    }
    if (cells.length !== header.length) {
      fail('CSV', `line ${i + 1} has ${cells.length} fields but the header has `
        + `${header.length}. This file is truncated or is not the file you meant; `
        + 'nothing here pads a short row.');
    }
    rows.push(cells);
  }
  if (header === null) fail('CSV', 'the file has no non-empty lines.');
  return { header, rows };
}

/**
 * Index of a column by name, FIRST match only, -1 if absent.
 *
 * Never assume a header name is unique and never regex-normalise whitespace out
 * of a name you then match exactly: the Blue Raven low-rate header repeats
 * `Reserved`, `LT_AGL1`, `GT_BURN` and `Armed` four times each, and carries
 * `Apo_FER_H  ex` with an embedded double space. Exact match wins; a
 * trim-only match is the fallback, for files whose header line has stray
 * spaces after the commas.
 */
export function columnIndex(header, name) {
  const exact = header.indexOf(name);
  if (exact >= 0) return exact;
  const want = String(name).trim();
  for (let i = 0; i < header.length; i++) {
    if (String(header[i]).trim() === want) return i;
  }
  return -1;
}

/** First column matching any of `names` (exact), else the first matching `re`. */
function findColumn(header, names, re = null) {
  for (const n of names) {
    const i = columnIndex(header, n);
    if (i >= 0) return { index: i, name: header[i] };
  }
  if (re) {
    for (let i = 0; i < header.length; i++) {
      if (re.test(String(header[i]).trim())) return { index: i, name: header[i] };
    }
  }
  return null;
}

/** A numeric cell, or NaN. Blank and `FALSE` both become NaN rather than 0. */
function num(cell) {
  const s = String(cell).trim();
  if (s === '') return NaN;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

/** Pull one column out as a Float64Array. */
function column(rows, index) {
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) out[i] = num(rows[i][index]);
  return out;
}

/**
 * Median sample interval. Median, not mean: a dropout in the middle of a log
 * moves a mean and cannot move a median, and it is the typical rate that governs
 * the integration error.
 */
export function medianDt(t) {
  const d = [];
  for (let i = 1; i < t.length; i++) {
    const dt = t[i] - t[i - 1];
    if (dt > 0) d.push(dt);
  }
  if (d.length === 0) fail('R6', 'the time column never increases — is it really a time column?');
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Units — measured, never guessed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which unit the axial accelerometer channel is in, decided by PHYSICS: a rocket
 * sitting on the pad reads exactly 1 g of specific force, so |mean| over the pad
 * samples identifies the unit outright.
 *
 * This is a real-world confusion, not a hypothetical —
 * `docs/research/trf-flight-data-2026-08-25.md:66-67` records Adrian correcting
 * a forum poster who read this very column as m/s^2.
 *
 * Returns the SIGN too, because the sign convention is also physics: whichever
 * way the board is mounted, the pad reading points along +up, so the sign of the
 * pad mean is the sign that makes the nose axis positive. On both Blue Ravens
 * `Accel_Z` reads -0.99 on the pad, which is why Adrian's snippet writes
 * `-raw_Gs(:,3)`; this derives that instead of assuming it.
 *
 * Measured signature on both Blue Raven files: 0.9932 g, sd 0.0050 (2023) and
 * 0.0065 (2024), over ~916 pad samples.
 */
export function detectAccelUnit(padSamples) {
  const vals = [];
  for (const v of padSamples) if (Number.isFinite(v)) vals.push(v);
  if (vals.length < MIN_PAD_SAMPLES) {
    fail('R7', `only ${vals.length} usable pre-liftoff samples (need ${MIN_PAD_SAMPLES}). `
      + 'The trace must start before liftoff: the accelerometer unit is identified from the '
      + 'pad-static reading, and the velocity integration has no initial condition without it.');
  }
  let sum = 0;
  for (const v of vals) sum += v;
  const mean = sum / vals.length;
  let ss = 0;
  for (const v of vals) ss += (v - mean) * (v - mean);
  const sd = Math.sqrt(ss / vals.length);
  const mag = Math.abs(mean);
  for (const c of ACCEL_UNITS) {
    if (Math.abs(mag / c.perG - 1) <= UNIT_TOL) {
      return { unit: c.unit, perG: c.perG, padMean: mean, padSd: sd, sign: mean < 0 ? -1 : 1, n: vals.length };
    }
  }
  fail('R4', `the pad-static axial reading is ${mag.toPrecision(6)} per sample, which is not `
    + `within ${(UNIT_TOL * 100).toFixed(0)} % of 1 (g), ${G0} (m/s^2) or `
    + `${FT_S2_PER_G.toFixed(3)} (ft/s^2). A rocket on the pad reads exactly 1 g of specific `
    + 'force, so either this is not the axial channel, or the board is badly out of '
    + 'calibration, or the trace does not start on the pad. Check --accel-column.');
}

/**
 * Altitude unit, from the column NAME only, and it THROWS rather than guess.
 *
 * There is no physical signature that separates 3,000 ft from 3,000 m, and a
 * wrong guess is a 24 % density error. Fail loudly; the caller passes
 * --altitude-unit.
 */
export function detectAltitudeUnit(header, name) {
  const i = columnIndex(header, name);
  const label = String(i >= 0 ? header[i] : name);
  if (/\((?:feet|foot|ft)\)|_ft\b|\bft\b/i.test(label)) return 'ft';
  if (/\((?:m|meters|metres|meter|metre)\)|_m\b|\bmeters?\b/i.test(label)) return 'm';
  fail('R4', `the altitude column "${label}" carries no unit in its name, and feet and metres `
    + 'cannot be told apart from the numbers (a wrong guess is a 24 % density error). '
    + 'Pass --altitude-unit ft or --altitude-unit m.');
  return 'm'; // unreachable; keeps the return type honest for callers
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusals on whole file kinds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refuse the file kinds that are NOT accelerometer traces but look like flight
 * data. All three were sitting in `docs/User files/` when this was written, and
 * all three are what a tester reaches for first. Each refusal says what the file
 * actually IS, because "no acceleration column" would send someone hunting for a
 * bug in this script.
 */
export function refuseNonAccelFile(header, label = 'this file') {
  const has = (n) => columnIndex(header, n) >= 0;

  // R1 — Featherweight GPS tracker export.
  if (has('UTCTIME') && has('VERTV')) {
    fail('R1', `${label} is a Featherweight GPS track (columns UTCTIME/ALT/VERTV). This method `
      + 'needs an accelerometer trace; the matching Blue Raven high-rate CSV is the input. '
      + '(The GPS file is still useful as an independent check on peak velocity.)');
  }

  // R2 — this app's own flight-data CSV export.
  if (has('time_s') && has('acceleration_G') && has('mass_g') && has('thrust_N')) {
    fail('R2', `${label} is an MMRocket Sim flight export, not an accelerometer log — its `
      + 'acceleration_G column is |net acceleration| WITH gravity and with the sign stripped, '
      + 'so it cannot be used as specific force. (Its drag_N column already holds the answer.)');
  }

  // R3 — RASAero II simulation export. Its CD column is an INPUT to that sim.
  if (has('Mach Number') && has('CD') && has('Stability Margin (cal)')) {
    fail('R3', `${label} is a RASAero II simulation export, not measured flight data; its CD `
      + 'column is an input to the sim, not an observation, and its Accel column is total '
      + 'acceleration rather than specific force.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration and event detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Velocity by trapezoid integration of (a_ax.k - 1).g0, seeded v = 0 at the last
 * sample with t <= 0 (liftoff). Returns m/s.
 *
 * Trapezoid rather than the snippet's `cumsum`, which is a rectangle rule. On a
 * linear acceleration ramp the trapezoid is EXACT and the rectangle rule's
 * relative velocity error is exactly dt/t, which Cd doubles through 1/v^2 —
 * 0.5 % on Cd at 50 Hz and t = 8 s, 10 % at t = 0.4 s. Pinned analytically in
 * cdFromFlight.test.mjs ("is a trapezoid, not a rectangle").
 * What is left after choosing the trapezoid is the SAMPLE RATE, and it costs Cd
 * in the LOW direction, not the high one — measured end to end by decimating
 * this file's own 500 Hz trace (module docblock): 0.2258 at 500 Hz, 0.2248 at
 * 100 Hz (-0.4 %), 0.2218 at 50 Hz (-1.8 %).
 *
 * The -1 is the whole trick: an accelerometer reads specific force, so a rocket
 * standing still reads +1 g. Integrating the raw channel gives an airframe that
 * accelerates upward on the pad.
 */
export function integrateVelocity(t, aAxG, { scale = 1, tBurnout = null } = {}) {
  const n = t.length;
  let i0 = -1;
  for (let i = 0; i < n; i++) {
    if (t[i] <= 0) i0 = i;
    else break;
  }
  if (i0 < 0) {
    const after = tBurnout != null && t[0] >= tBurnout
      ? ` — and after burnout (${tBurnout.toFixed(3)} s), so this is a coast-only trace`
      : '';
    fail('R7', `the trace starts at t = ${t[0]} s, after liftoff (t = 0)${after}. Integrated `
      + 'velocity has no initial condition without the pad segment; re-export the log from '
      + 'before liftoff.');
  }
  const v = new Float64Array(n);
  // Everything at or before liftoff is at rest. Integrating backwards over the
  // pad would only accumulate sensor bias into a velocity we know is zero.
  for (let i = i0 + 1; i < n; i++) {
    const dt = t[i] - t[i - 1];
    const a1 = (aAxG[i - 1] * scale - 1) * G0;
    const a2 = (aAxG[i] * scale - 1) * G0;
    v[i] = v[i - 1] + 0.5 * (a1 + a2) * dt;
  }
  return v;
}

/** Altitude AGL by trapezoid integration of the velocity, from liftoff. Metres. */
export function integrateAltitude(t, v) {
  const n = t.length;
  let i0 = -1;
  for (let i = 0; i < n; i++) {
    if (t[i] <= 0) i0 = i;
    else break;
  }
  if (i0 < 0) i0 = 0;
  const h = new Float64Array(n);
  for (let i = i0 + 1; i < n; i++) {
    h[i] = h[i - 1] + 0.5 * (v[i - 1] + v[i]) * (t[i] - t[i - 1]);
  }
  return h;
}

/**
 * TRAILING mean of `y` over the last `windowS` seconds — the window is
 * (t[i]-windowS, t[i]].
 *
 * Trailing rather than centred on purpose. A trailing mean lags the true
 * crossing by about half a window, so the detector errs LATE, and late is the
 * safe direction: a burnout guessed early counts thrust as drag and produces
 * negative Cd (that is R8's entire failure mode), while one guessed late only
 * costs a few samples the settling guard would have discarded anyway. Measured
 * on the F10 file: raw crossing 8.154 s, trailing detector 8.176 s, centred
 * detector 8.150 s, altimeter's own flag 8.24 s. On the G12: raw 12.144,
 * trailing 12.162, flag 12.14.
 */
function trailingMean(t, y, windowS) {
  const n = t.length;
  const out = new Float64Array(n);
  let lo = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(y[i])) { sum += y[i]; count++; }
    while (lo < i && t[lo] <= t[i] - windowS) {
      if (Number.isFinite(y[lo])) { sum -= y[lo]; count--; }
      lo++;
    }
    out[i] = count > 0 ? sum / count : NaN;
  }
  return out;
}

/**
 * Burnout: the first time after BURNOUT_MIN_T at which the SMOOTH_S-mean of the
 * axial specific force goes negative AND STAYS negative for HOLD_S.
 *
 * The hold window is what makes it survive a mid-burn chuff or a thrust dip — a
 * momentary negative excursion is not burnout, and without the hold a chuffing
 * motor ends the burn at the chuff and every later Cd is computed against a
 * still-thrusting rocket.
 *
 * Measured against the altimeters' own flags, from the accelerometer alone:
 * 8.176 s vs flag 8.24 (F10 2023), 12.162 s vs flag 12.14 (G12 2024) — inside
 * 70 ms both times.
 */
export function detectBurnout(t, aAxG, { rate = null, smoothS = SMOOTH_S, holdS = HOLD_S, tMin = BURNOUT_MIN_T } = {}) {
  // Both windows are widened, never narrowed, so they always hold at least three
  // samples. At 500 Hz this changes nothing; at the 50 Hz an altimeter's own
  // low-rate log runs at, a fixed 0.05 s window would hold 2.5 samples and the
  // detector would be reading single-sample noise. Widening keeps a slow log
  // usable — which is the whole point of MIN_RATE_HZ being 10 and not 50 —
  // at the cost of a slightly later crossing, which is the safe direction.
  const minWindow = rate != null && Number.isFinite(rate) && rate > 0 ? 3 / rate : 0;
  const win = Math.max(smoothS, minWindow);
  const hold = Math.max(holdS, minWindow);
  const s = trailingMean(t, aAxG, win);
  const n = t.length;
  for (let i = 0; i < n; i++) {
    if (!(t[i] >= tMin) || !(s[i] < 0)) continue;
    let held = true;
    let j = i + 1;
    for (; j < n && t[j] <= t[i] + hold; j++) {
      if (!(s[j] < 0)) { held = false; break; }
    }
    // A candidate whose hold window runs off the end of the trace is not a
    // crossing we can trust — treat the end of file as failure, not success.
    if (held && j < n) return t[i];
  }
  fail('R7', 'no burnout was found: the smoothed axial specific force never goes negative and '
    + `stays negative for ${hold} s after t = ${tMin} s. Either the trace ends during the burn, `
    + 'or the axial channel is the wrong column. Pass --burnout-s to override.');
  return NaN; // unreachable
}

/**
 * Apogee. Prefers a barometric altitude column's maximum, which is the physical
 * apogee; falls back to the first post-burnout sample with integrated v <= 0.
 *
 * The inertial crossing runs EARLY — 23.774 s against the 24.90 s baro flag on
 * the F10 — because integration drift accumulates over a 16 s coast. That is
 * conservative: it only discards near-zero-velocity samples MACH_FLOOR would
 * drop anyway. But the report must PRINT which one it used, because "apogee"
 * meaning two different things 1.1 s apart is exactly the kind of quiet
 * disagreement this tool exists to avoid.
 */
export function detectApogee(t, v, { tBurnout = 0, altitude = null } = {}) {
  if (altitude) {
    // Never Math.max(...arr) on these traces — 192,000 arguments overflows the
    // call stack (hit while prototyping this).
    let best = -Infinity;
    let bestT = t[t.length - 1];
    for (let i = 0; i < t.length; i++) {
      if (t[i] < tBurnout) continue;
      if (Number.isFinite(altitude[i]) && altitude[i] > best) { best = altitude[i]; bestT = t[i]; }
    }
    return { t: bestT, source: 'barometric altitude maximum' };
  }
  for (let i = 0; i < t.length; i++) {
    if (t[i] > tBurnout && v[i] <= 0) return { t: t[i], source: 'integrated velocity zero-crossing' };
  }
  return { t: t[t.length - 1], source: 'end of trace (velocity never crossed zero)' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Atmosphere
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local air state. TWO PATHS, and the choice is the single biggest lever here.
 *
 *  (a) MEASURED — `pressurePa` from the file's own baro column, with
 *      T = padTempK - LAPSE.hAGL and rho = p/(R.T).
 *  (b) ISA FALLBACK — no baro column: T = T0 - LAPSE.(hAGL + siteElevationM),
 *      p = P0.(T/T0)^(g0/(LAPSE.R)). The same barometric form
 *      `recoverySizing.ts:168-173` uses, rearranged from
 *      ExtendedISAModel.calculatePressure (24.12).
 *
 * siteElevationM is MANDATORY on path (b) and there is NO sea-level default.
 * MEASURED on the F10 flight, over the same flag-derived window so only the
 * density source differs: ISA at the true 8,800 ft site gives mean Cd 0.2260
 * against the measured-baro 0.2258 — 0.09 %, which makes the fallback genuinely
 * usable. ISA from SEA LEVEL gives 0.1696, which is -24.9 %. A silent sea-level
 * default would be the single worst bug this tool could ship, so it throws (R5).
 */
export function atmosphere({ altitudeM, pressurePa = null, padTempK = null, siteElevationM = null }) {
  let tempK;
  let pPa;
  if (pressurePa != null && Number.isFinite(pressurePa)) {
    if (padTempK == null || !Number.isFinite(padTempK)) {
      fail('R5', 'a measured pressure needs a temperature to become a density. Pass '
        + '--pad-temp-c (free-air temperature at the pad, NOT the board temperature) or '
        + '--site-elevation-m so an ISA pad temperature can be used.');
    }
    tempK = padTempK - LAPSE * altitudeM;
    pPa = pressurePa;
  } else {
    if (siteElevationM == null || !Number.isFinite(siteElevationM)) {
      fail('R5', 'there is no barometric pressure column and no --site-elevation-m, so there is '
        + 'no density source. This never defaults to sea level: on the Adamson F10 flight, ISA '
        + 'from sea level instead of the true 8,800 ft site moves mean Cd by -24.9 %. Pass '
        + '--site-elevation-m (field elevation MSL) or --baro <low_rate.csv>.');
    }
    // THE STANDARD ATMOSPHERE IS USED WHOLE, AND `padTempK` IS DELIBERATELY
    // NOT MIXED IN. It is tempting: the user supplied a real pad temperature,
    // so why compute density at a standard one? Because ISA's PRESSURE at
    // height was derived by integrating ISA's own temperature profile. Swap the
    // temperature and keep the pressure and the pair no longer describes any
    // atmosphere — the column is 7 K warmer at the F10's site, which would also
    // have raised the pressure aloft, and this branch has no measurement of
    // that.
    //
    // MEASURED, which is why it is written this way round. On the Adamson F10,
    // against the measured-barometer answer of 0.2258:
    //     ISA whole, at the true 8,800 ft site ......... 0.2260  (+0.09 %)
    //     ISA pressure + the measured 40 F pad temp .... 0.2314  (+2.5 %)
    // The self-consistent standard atmosphere is the more accurate fallback, by
    // a factor of 27. Mixing the measurement in makes the answer worse.
    //
    // Until 2026-09-07 this was right and the REPORT was wrong: it printed "pad
    // temperature given, 4.4 C" on this path, claiming a measurement it had not
    // used. `solve()` now says plainly that the value is carried but not applied
    // here, and what to pass instead (--baro, which is path (a)).
    tempK = ISA_T0 - LAPSE * (altitudeM + siteElevationM);
    pPa = ISA_P0 * Math.pow(tempK / ISA_T0, G0 / (LAPSE * R_AIR));
  }
  return {
    pressurePa: pPa,
    temperatureK: tempK,
    densityKgM3: pPa / (R_AIR * tempK),
    machSpeed: Math.sqrt(GAMMA * R_AIR * tempK),
    muPaS: MU_A + MU_B * tempK,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The inversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cd per sample. `samples` are coast samples already carrying their local air
 * state: { t, aAxG, velocityMs, atm }. This is deliberately the pure inversion
 * and nothing else, so the atmosphere model and the sample selection can be
 * tested separately from the algebra.
 *
 *   D  = -m . a_ax . g0        (positive in coast, where a_ax < 0)
 *   Cd = 2.D / (rho . v^2 . A)
 *
 * `massKg` is BURNOUT mass. Drag is the only axial force in coast, so the mass
 * that belongs here is the mass that is coasting.
 */
export function cdSeries(samples, { massKg, diameterM, lengthM = null, machFloor = MACH_FLOOR }) {
  if (!(massKg > 0)) fail('R9', 'massKg must be a positive number of kilograms (BURNOUT mass).');
  if (!(diameterM > 0)) fail('R9', 'diameterM must be a positive number of metres.');
  const area = Math.PI * diameterM * diameterM / 4;
  const out = [];
  for (const s of samples) {
    const v = s.velocityMs;
    const a = s.atm;
    if (!Number.isFinite(v) || v <= 0) continue;
    const mach = v / a.machSpeed;
    if (!(mach >= machFloor)) continue;
    const drag = -massKg * s.aAxG * G0;
    const cd = 2 * drag / (a.densityKgM3 * v * v * area);
    if (!Number.isFinite(cd)) continue;
    out.push({
      t: s.t,
      machNumber: mach,
      cd,
      reynolds: lengthM ? a.densityKgM3 * v * lengthM / a.muPaS : null,
      velocityMs: v,
      densityKgM3: a.densityKgM3,
      temperatureK: a.temperatureK,
      pressurePa: a.pressurePa,
      aAxG: s.aAxG,
      altitudeM: s.altitudeM,
    });
  }
  return out;
}

/** Group a Cd series into Mach bins [edges[i], edges[i+1]). Empty bins are dropped. */
export function binByMach(series, edges = DEFAULT_BIN_EDGES) {
  const bins = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    let n = 0;
    let sumCd = 0;
    let sumRe = 0;
    let nRe = 0;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const s of series) {
      if (!(s.machNumber >= lo && s.machNumber < hi)) continue;
      n++;
      sumCd += s.cd;
      if (s.reynolds != null) { sumRe += s.reynolds; nRe++; }
      if (s.t < t0) t0 = s.t;
      if (s.t > t1) t1 = s.t;
    }
    if (n === 0) continue;
    bins.push({ lo, hi, cd: sumCd / n, n, reynolds: nRe ? sumRe / nRe : null, t0, t1 });
  }
  return bins;
}

/** Mean Cd and sample count over a Mach band. */
function bandMean(series, [lo, hi]) {
  let n = 0;
  let sum = 0;
  for (const s of series) {
    if (s.machNumber >= lo && s.machNumber <= hi) { n++; sum += s.cd; }
  }
  return { lo, hi, cd: n ? sum / n : NaN, n };
}

/** Largest value of `pick` over `series`, with the sample it came from. */
function peakBy(series, pick) {
  let best = null;
  for (const s of series) {
    if (best === null || pick(s) > pick(best)) best = s;
  }
  return best;
}

/**
 * Everything the report prints, as data. Kept separate from formatReport so
 * --json and the human table cannot disagree about a number.
 */
export function summarise(series, bins, meta) {
  const band = bandMean(series, meta.machBand ?? REPORT_BAND);
  const peak = peakBy(series, (s) => s.machNumber);
  return {
    ...meta,
    bins,
    band,
    samples: series.length,
    peakMach: peak ? peak.machNumber : NaN,
    peakVelocityMs: peak ? peak.velocityMs : NaN,
    peakT: peak ? peak.t : NaN,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the files
// ─────────────────────────────────────────────────────────────────────────────

const TIME_COLUMNS = ['Flight_Time_(s)', 'Flight_Time_(sec)', 'Time_(s)', 'time_s', 'Time (sec)', 'Time', 'time'];
const ACCEL_COLUMNS = ['Accel_Z', 'AccelZ', 'Axial_Accel', 'Accel_Axial', 'accel_axial', 'axial_g'];
const PRESSURE_COLUMNS = ['Baro_Press_(atm)', 'Baro_Press_(hPa)', 'Baro_Press_(mbar)', 'Baro_Press_(Pa)',
  'Pressure_(Pa)', 'Pressure_(hPa)', 'Pressure_(atm)'];
const ALTITUDE_COLUMNS = ['Baro_Altitude_AGL_(feet)', 'Baro_Altitude_AGL_(m)', 'Altitude_AGL_(feet)',
  'Altitude_AGL_(m)', 'Altitude_(feet)', 'Altitude_(m)', 'altitude_ft', 'altitude_m'];

/** Pressure unit multipliers to Pa, keyed off the unit written in the column name. */
const PRESSURE_UNITS = [
  { re: /\(atm\)/i, toPa: ATM_PA, label: 'atm' },
  { re: /\((?:hpa|mbar|mb|millibar)\)/i, toPa: 100, label: 'hPa' },
  { re: /\(kpa\)/i, toPa: 1000, label: 'kPa' },
  { re: /\(pa\)/i, toPa: 1, label: 'Pa' },
  { re: /\(psi\)/i, toPa: 6894.757, label: 'psi' },
  { re: /\(inhg\)/i, toPa: 3386.389, label: 'inHg' },
];

/**
 * Read the optional low-rate companion: pressure, barometric altitude and the
 * altimeter's own event flags. The flags are REPORTED, never used to drive the
 * answer, so a board that flags burnout during tail-off cannot move Cd.
 */
function readBaro(text, { label, altitudeUnitOverride = null }) {
  const { header, rows } = parseCsv(text);
  refuseNonAccelFile(header, label); // a GPS track handed to --baro is the same mistake
  if (rows.length === 0) {
    // Otherwise every interpolation silently returns undefined and the density
    // path falls through to ISA without saying it did.
    fail('R6', `${label} has a header but no data rows.`);
  }

  const tc = findColumn(header, TIME_COLUMNS, /^flight_time/i);
  if (!tc) fail('R6', `${label} has no recognisable time column (looked for ${TIME_COLUMNS.join(', ')}).`);
  const t = column(rows, tc.index);

  const pc = findColumn(header, PRESSURE_COLUMNS, /^baro_press|^pressure/i);
  let pressurePa = null;
  let pressureLabel = null;
  if (pc) {
    const unit = PRESSURE_UNITS.find((u) => u.re.test(pc.name));
    if (!unit) {
      fail('R4', `the pressure column "${pc.name}" carries no unit in its name. Pressure in atm, `
        + 'hPa and Pa differ by five orders of magnitude and cannot be told apart from the '
        + 'numbers; rename the column to carry its unit, e.g. Baro_Press_(atm).');
    }
    const raw = column(rows, pc.index);
    pressurePa = new Float64Array(raw.length);
    for (let i = 0; i < raw.length; i++) pressurePa[i] = raw[i] * unit.toPa;
    pressureLabel = `${pc.name} (${unit.label})`;
  }

  const ac = findColumn(header, ALTITUDE_COLUMNS, /^baro_altitude.*agl|^altitude.*agl/i);
  let altitudeM = null;
  let altitudeLabel = null;
  if (ac) {
    const unit = altitudeUnitOverride ?? detectAltitudeUnit(header, ac.name);
    const raw = column(rows, ac.index);
    const k = unit === 'ft' ? FT : 1;
    altitudeM = new Float64Array(raw.length);
    for (let i = 0; i < raw.length; i++) altitudeM[i] = raw[i] * k;
    altitudeLabel = `${ac.name} (${unit})`;
  }

  /** An event flag's first `1`, or null. Reported for comparison only. */
  const flagTime = (name) => {
    const i = columnIndex(header, name);
    if (i < 0) return null;
    for (let r = 0; r < rows.length; r++) {
      if (num(rows[r][i]) === 1) return t[r];
    }
    return null;
  };

  return {
    label,
    rows: rows.length,
    t,
    pressurePa,
    pressureLabel,
    altitudeM,
    altitudeLabel,
    flags: {
      liftoff: flagTime('Liftoff'),
      burnout: flagTime('Burnout_Coast'),
      apogee: flagTime('Apogee'),
    },
  };
}

/**
 * Linear interpolation of `y` sampled at `xs` onto a single `x`, clamped at both
 * ends. Clamped rather than extrapolated: outside the companion file's own time
 * range there is no measurement, and extrapolating a pressure is inventing one.
 */
function interpAt(xs, ys, x, cursor) {
  const n = xs.length;
  let i = cursor.i;
  if (i >= n - 1) i = n - 2;
  if (i < 0) i = 0;
  while (i < n - 2 && xs[i + 1] < x) i++;
  while (i > 0 && xs[i] > x) i--;
  cursor.i = i;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  const x0 = xs[i];
  const x1 = xs[i + 1];
  if (!(x1 > x0)) return ys[i];
  const f = (x - x0) / (x1 - x0);
  return ys[i] + f * (ys[i + 1] - ys[i]);
}

// ─────────────────────────────────────────────────────────────────────────────
// The pipeline: prepare (I/O + refusals) then solve (physics), so the physics
// can be re-run cheaply for the error budget without re-parsing 22 MB of CSV.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the inputs, refuse the file kinds that cannot work, identify the axial
 * channel and its unit, and check the sample rate. Everything here is
 * independent of the scale factor, mass and diameter, which is why the
 * sensitivity re-runs can reuse it.
 */
export function prepare(options) {
  const {
    accelPath = null, accelText = null, baroPath = null, baroText = null,
    timeColumn = null, accelColumn = null, altitudeUnit = null,
  } = options;

  const label = accelPath ? basename(accelPath) : 'the accelerometer file';
  const text = accelText != null ? accelText : readFileSync(accelPath, 'utf8');
  const { header, rows } = parseCsv(text);
  refuseNonAccelFile(header, label);

  const tc = timeColumn
    ? { index: columnIndex(header, timeColumn), name: timeColumn }
    : findColumn(header, TIME_COLUMNS, /^flight_time/i);
  if (!tc || tc.index < 0) {
    fail('R6', `${label} has no recognisable time column (looked for ${TIME_COLUMNS.join(', ')}). `
      + 'Pass --time-column with the exact header text.');
  }
  const ac = accelColumn
    ? { index: columnIndex(header, accelColumn), name: accelColumn }
    : findColumn(header, ACCEL_COLUMNS, null);
  if (!ac || ac.index < 0) {
    fail('R1', `${label} has no acceleration column (looked for ${ACCEL_COLUMNS.join(', ')}). This `
      + 'method needs a logged accelerometer trace — a barometric altitude log or a GPS track '
      + 'cannot be used. Pass --accel-column with the exact header text if the axial channel is '
      + 'named something else.');
  }

  const t = column(rows, tc.index);
  const rawAxial = column(rows, ac.index);

  const dt = medianDt(t);
  const rateHz = 1 / dt;
  if (rateHz < MIN_RATE_HZ) {
    fail('R6', `the median sample interval is ${dt.toFixed(4)} s (${rateHz.toFixed(1)} Hz), below `
      + `the ${MIN_RATE_HZ} Hz floor. Measured by decimating a real 500 Hz flight, the whole `
      + 'extraction already moves 1.8 % at 50 Hz, and by 10 Hz a single sample spans 25 m of a '
      + 'coast whose density is changing under it. Use the high-rate log.');
  }

  // Pad-static window. This both identifies the unit and fixes the sign
  // convention — see detectAccelUnit.
  const pad = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] < PAD_END_S) pad.push(rawAxial[i]);
  }
  const unit = detectAccelUnit(pad);

  // Axial specific force in g, sign-corrected so the nose axis is positive.
  const aAxG = new Float64Array(rawAxial.length);
  for (let i = 0; i < rawAxial.length; i++) aAxG[i] = rawAxial[i] * unit.sign / unit.perG;

  let baro = null;
  if (baroPath || baroText != null) {
    baro = readBaro(
      baroText != null ? baroText : readFileSync(baroPath, 'utf8'),
      { label: baroPath ? basename(baroPath) : 'the baro file', altitudeUnitOverride: altitudeUnit },
    );
  }

  return {
    label, header, rows: rows.length, t, aAxG, rawAxial, unit, dt, rateHz, baro,
    timeColumnName: header[tc.index], accelColumnName: header[ac.index],
  };
}

/**
 * The physics, given a prepared trace. Split out from prepare() so the error
 * budget can re-run it under a different scale factor for a fraction of a
 * second, instead of quoting a sensitivity measured on somebody else's flight.
 */
export function solve(prepared, options) {
  const {
    massKg, diameterM, lengthM = null, siteElevationM = null, padTempC = null,
    accelScale = 'pad', burnoutS = null, apogeeS = null, settleS = SETTLE_S,
    machBand = REPORT_BAND, binEdges = DEFAULT_BIN_EDGES,
  } = options;

  if (!(Number.isFinite(massKg) && massKg > 0)) {
    fail('R9', '--mass-kg is required and must be a positive number. It is the BURNOUT mass '
      + '(liftoff mass minus propellant), because Cd is extracted during coast where the '
      + 'coasting mass is what drag acts on. There is no default.');
  }
  if (!(Number.isFinite(diameterM) && diameterM > 0)) {
    fail('R9', '--diameter-m (or --diameter-in) is required and must be a positive number. '
      + 'Cd scales as 1/d^2, so a 2.5 % diameter error is a 5 % Cd error. There is no default.');
  }

  const { t, aAxG, unit, rateHz, baro } = prepared;

  // ── the scale factor k ──────────────────────────────────────────────────
  // A 3 % lever, so the branch taken is part of the report, never a silent
  // default. `pad` is the default because it is derivable from the file itself.
  let k;
  let scaleNote;
  if (accelScale === 'pad' || accelScale == null) {
    const padG = Math.abs(unit.padMean) / unit.perG;
    if (!(padG > 0)) fail('R4', 'the pad-static mean is zero, so it cannot calibrate the scale.');
    k = 1 / padG;
    scaleNote = `pad-static calibration, k = 1/${padG.toFixed(5)} = ${k.toFixed(5)}`;
  } else if (accelScale === 'none' || accelScale === '1') {
    k = 1;
    scaleNote = 'none, k = 1 (raw channel, sensor bias left in)';
  } else {
    k = Number(accelScale);
    if (!(Number.isFinite(k) && k > 0)) {
      fail('R9', `--accel-scale "${accelScale}" is not "pad", "none", or a positive number.`);
    }
    scaleNote = `given, k = ${k}`;
  }

  // ── burnout ─────────────────────────────────────────────────────────────
  const detectedBurnout = detectBurnout(t, aAxG, { rate: rateHz });
  const tBurnout = burnoutS != null ? burnoutS : detectedBurnout;

  // ── velocity, and the altitude the atmosphere is evaluated at ───────────
  const v = integrateVelocity(t, aAxG, { scale: k, tBurnout });
  const inertialAltitude = integrateAltitude(t, v);

  // ── pad temperature ─────────────────────────────────────────────────────
  // The Blue Raven's own Temperature_(F) is the BOARD temperature and reads
  // 63 F on a 40 F day (it is self-heated inside a sealed bay), so it is never
  // used here — using it would be a ~4 % density error dressed up as a
  // measurement. Free-air pad temperature comes from the operator, or from ISA
  // at the field elevation.
  let padTempK;
  let tempNote;
  if (padTempC != null && Number.isFinite(padTempC)) {
    padTempK = padTempC + 273.15;
    // SAY WHETHER IT WAS ACTUALLY USED. It reaches the density only on the
    // measured-pressure path; the ISA fallback uses the standard atmosphere
    // whole and deliberately does not mix it in (see atmosphere()). Printing
    // "given, 4.4 C" on the fallback path claimed a measurement the arithmetic
    // had ignored, which is the kind of sentence this project exists to catch.
    tempNote = `given, ${padTempC.toFixed(1)} C (${(padTempC * 9 / 5 + 32).toFixed(1)} F)`;
  } else if (siteElevationM != null && Number.isFinite(siteElevationM)) {
    padTempK = ISA_T0 - LAPSE * siteElevationM;
    tempNote = `ISA at ${siteElevationM.toFixed(0)} m site elevation, `
      + `${(padTempK - 273.15).toFixed(1)} C — pass --pad-temp-c for the real one`;
  } else {
    padTempK = null;
    tempNote = 'none';
  }

  // ── per-sample atmosphere ───────────────────────────────────────────────
  const useMeasured = !!(baro && baro.pressurePa);
  // The pad temperature only reaches the density when there is a measured
  // pressure to pair it with. On the ISA fallback it is carried and reported
  // but NOT applied, and the report has to say so rather than imply the
  // measurement was used.
  if (padTempC != null && Number.isFinite(padTempC) && !useMeasured) {
    tempNote += ' — NOT used: with no measured pressure the standard atmosphere is '
      + 'used whole (mixing the two is 2.5 % worse on the F10 flight; see atmosphere()). '
      + 'Pass --baro <low_rate.csv> to put this measurement to work.';
  }
  const hasBaroAlt = !!(baro && baro.altitudeM);
  const pCursor = { i: 0 };
  const hCursor = { i: 0 };
  const altAt = (i) => (hasBaroAlt ? interpAt(baro.t, baro.altitudeM, t[i], hCursor) : inertialAltitude[i]);

  // ── apogee ──────────────────────────────────────────────────────────────
  let apogee;
  if (apogeeS != null) {
    apogee = { t: apogeeS, source: 'given (--apogee-s)' };
  } else if (hasBaroAlt) {
    // Resample the companion's altitude onto the accel time base so apogee is
    // found on the same clock every other number here is on.
    const alt = new Float64Array(t.length);
    const c = { i: 0 };
    for (let i = 0; i < t.length; i++) alt[i] = interpAt(baro.t, baro.altitudeM, t[i], c);
    apogee = detectApogee(t, v, { tBurnout, altitude: alt });
  } else {
    apogee = detectApogee(t, v, { tBurnout });
  }

  // ── R10: the altitude sanity check ──────────────────────────────────────
  // The barometric altitude column is the ONE input a user can override by
  // hand (--altitude-unit), and until 2026-09-07 nothing checked the override.
  // Passing `--altitude-unit m` against a column that is really feet gives mean
  // Cd 0.1981 instead of 0.2258 on the Adamson F10 — -12 %, at exit code 0.
  // A silent unit error is this project's most-repeated defect class, so it is
  // worth a refusal.
  //
  // The check costs nothing because the second opinion already exists:
  // `inertialAltitude` is integrated from the accelerometer and shares no input
  // with the baro column. They are not expected to agree closely — they differ
  // by their own drift, and this file's own apogee times differ by 1.2 s — so
  // the band is deliberately wide. A foot/metre swap is a factor of 3.28, which
  // is nowhere near it; nothing short of that trips it.
  if (hasBaroAlt) {
    let peakBaro = -Infinity;
    let peakInertial = -Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < tBurnout || t[i] > apogee.t) continue;
      if (altAt(i) > peakBaro) peakBaro = altAt(i);
      if (inertialAltitude[i] > peakInertial) peakInertial = inertialAltitude[i];
    }
    const ratio = peakBaro / peakInertial;
    if (Number.isFinite(ratio) && peakInertial > 1 && (ratio > ALT_AGREE_MAX || ratio < 1 / ALT_AGREE_MAX)) {
      fail('R10', `the barometric altitude and the accelerometer disagree about how high this `
        + `rocket went: ${peakBaro.toFixed(0)} m from "${baro.altitudeLabel}" against `
        + `${peakInertial.toFixed(0)} m integrated from the axial channel, a factor of `
        + `${(ratio > 1 ? ratio : 1 / ratio).toFixed(2)}. Two independent measurements do not `
        + `differ by that much. The usual cause is the altitude UNIT: a feet column read as `
        + `metres (or the reverse) is a factor of 3.28, and it moves Cd by about 12 % with no `
        + `other symptom. Check --altitude-unit against the column's own header.`);
    }
  }

  // ── the coast window ────────────────────────────────────────────────────
  const coastStart = tBurnout + settleS;
  const samples = [];
  const preSettle = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] < tBurnout || t[i] > apogee.t) continue;
    const altitudeM = altAt(i);
    const atm = atmosphere({
      altitudeM,
      pressurePa: useMeasured ? interpAt(baro.t, baro.pressurePa, t[i], pCursor) : null,
      padTempK,
      siteElevationM,
    });
    const row = { t: t[i], aAxG: aAxG[i] * k, velocityMs: v[i], atm, altitudeM };
    if (t[i] >= coastStart) samples.push(row);
    else preSettle.push(row);
  }

  const series = cdSeries(samples, { massKg, diameterM, lengthM });

  // ── R8: the negative-Cd screen ──────────────────────────────────────────
  // A wrong burnout time counts thrust as drag. Measured on the F10: forcing
  // burnout early drives Cd at M > 0.75 to 0.093 (t=8.0), -0.021 (t=7.5) and
  // -0.062 (t=7.0). More than 5 % of coast samples below zero is not noise.
  let negatives = 0;
  for (const s of series) if (s.cd <= 0) negatives++;
  if (series.length > 0 && negatives / series.length > NEGATIVE_CD_LIMIT) {
    fail('R8', `${negatives} of ${series.length} accepted coast samples `
      + `(${(100 * negatives / series.length).toFixed(1)} %) give Cd <= 0, which means thrust is `
      + `being counted as drag: the coast window starts at ${coastStart.toFixed(3)} s and the `
      + 'motor is still burning. Check --burnout-s (detected: '
      + `${detectedBurnout.toFixed(3)} s) and --settle-s.`);
  }
  if (series.length === 0) {
    fail('R8', `no usable coast samples between ${coastStart.toFixed(3)} s and `
      + `${apogee.t.toFixed(3)} s above M ${MACH_FLOOR}. Check --burnout-s and --apogee-s.`);
  }

  // What the settling guard cost, so nobody has to wonder.
  const preSeries = cdSeries(preSettle, { massKg, diameterM, lengthM });
  const peakAll = peakBy(preSeries.concat(series), (s) => s.machNumber);

  const bins = binByMach(series, binEdges).sort((a, b) => b.lo - a.lo);
  return summarise(series, bins, {
    machBand,
    massKg,
    diameterM,
    lengthM,
    areaM2: Math.PI * diameterM * diameterM / 4,
    scale: k,
    scaleNote,
    accelUnit: unit.unit,
    padMeanG: Math.abs(unit.padMean) / unit.perG,
    padSd: unit.padSd / unit.perG,
    padSamples: unit.n,
    rateHz,
    dt: prepared.dt,
    rows: prepared.rows,
    label: prepared.label,
    accelColumnName: prepared.accelColumnName,
    timeColumnName: prepared.timeColumnName,
    baroLabel: baro ? baro.label : null,
    densitySource: useMeasured
      ? `measured barometric pressure (${baro.pressureLabel})`
      : `ISA from ${siteElevationM != null ? `${siteElevationM.toFixed(0)} m` : 'UNKNOWN'} site elevation`,
    altitudeSource: hasBaroAlt ? `barometric (${baro.altitudeLabel})` : 'inertial (integrated velocity)',
    padTempK,
    tempNote,
    detectedBurnout,
    burnoutS: tBurnout,
    burnoutOverridden: burnoutS != null,
    burnoutFlag: baro ? baro.flags.burnout : null,
    liftoffFlag: baro ? baro.flags.liftoff : null,
    apogeeFlag: baro ? baro.flags.apogee : null,
    apogeeS: apogee.t,
    apogeeSource: apogee.source,
    settleS,
    coastStart,
    peakMachUnguarded: peakAll ? peakAll.machNumber : NaN,
    siteElevationM,
    series,
  });
}

/**
 * The whole extraction, plus the top three terms of the error budget measured on
 * THIS flight rather than quoted from another one. Mass and diameter are exact
 * algebra (Cd is linear in m and goes as 1/d^2); the scale factor is not — k
 * multiplies the drag once and the integrated velocity roughly twice, and the
 * -1 g term breaks the proportionality — so it is re-solved numerically.
 */
export function analyse(options) {
  const prepared = prepare(options);
  const summary = solve(prepared, options);

  const massPct = 100 * MASS_SENSITIVITY_KG / summary.massKg;
  const dLarger = summary.diameterM + DIAM_SENSITIVITY_IN * IN;
  const diamPct = 100 * ((summary.diameterM / dLarger) ** 2 - 1);

  let scalePct = null;
  try {
    const alt = solve(prepared, { ...options, accelScale: summary.scale * SCALE_SENSITIVITY_K });
    if (Number.isFinite(alt.band.cd) && Number.isFinite(summary.band.cd) && summary.band.cd !== 0) {
      scalePct = 100 * (alt.band.cd / summary.band.cd - 1);
    }
  } catch {
    // A perturbed scale can legitimately trip R8 on a marginal trace. The error
    // budget is a footnote; it must never take down the extraction itself.
    scalePct = null;
  }

  summary.sensitivity = {
    massPct,
    diamPct,
    scalePct,
    scaleK: SCALE_SENSITIVITY_K,
    massDeltaKg: MASS_SENSITIVITY_KG,
    diamDeltaIn: DIAM_SENSITIVITY_IN,
  };
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const sci = (x, d = 3) => (Number.isFinite(x) ? x.toExponential(d) : '');

/** The human-readable report. --json emits `summary` itself, from the same fields. */
export function formatReport(s) {
  const L = [];
  L.push('Cd from flight data');
  L.push('='.repeat(72));
  L.push(`accelerometer   ${s.label}  (${s.rows} rows, ${f(s.rateHz, 1)} Hz, dt ${f(s.dt, 4)} s)`);
  L.push(`                axial channel "${s.accelColumnName}", clock "${s.timeColumnName}"`);
  if (s.baroLabel) L.push(`baro companion  ${s.baroLabel}`);
  L.push(`accel unit      ${s.accelUnit}, from a pad-static mean of ${f(s.padMeanG, 4)} `
    + `(sd ${f(s.padSd, 4)}, n ${s.padSamples})`);
  L.push(`accel scale     ${s.scaleNote}`);
  L.push(`burnout mass    ${f(s.massKg, 4)} kg`);
  L.push(`diameter        ${f(s.diameterM, 4)} m (${f(s.diameterM / IN, 3)} in), `
    + `reference area ${sci(s.areaM2, 4)} m^2`);
  if (s.lengthM) L.push(`length          ${f(s.lengthM, 4)} m (${f(s.lengthM / IN, 2)} in) — Reynolds reference`);
  L.push(`density source  ${s.densitySource}`);
  L.push(`altitude        ${s.altitudeSource}`);
  L.push(`pad temperature ${s.tempNote}`);
  L.push('');
  const flag = (x) => (x == null ? 'no flag column' : `flag ${f(x, 2)} s`);
  L.push(`burnout         ${f(s.burnoutS, 3)} s `
    + `${s.burnoutOverridden ? '(given via --burnout-s' : '(detected from the axial channel'}`
    + `; detector says ${f(s.detectedBurnout, 3)} s, altimeter ${flag(s.burnoutFlag)})`);
  L.push(`apogee          ${f(s.apogeeS, 3)} s (${s.apogeeSource}; altimeter ${flag(s.apogeeFlag)})`);
  L.push(`settling guard  ${f(s.settleS, 2)} s — discards ${f(s.burnoutS, 3)}-${f(s.coastStart, 3)} s, `
    + `where Cd is still climbing out of motor tail-off`);
  L.push(`coast window    ${f(s.coastStart, 3)} - ${f(s.apogeeS, 3)} s, ${s.samples} samples above `
    + `M ${MACH_FLOOR}`);
  L.push(`peak            M ${f(s.peakMach, 3)} (${f(s.peakVelocityMs, 1)} m/s, `
    + `${f(s.peakVelocityMs / FT, 0)} ft/s) at t = ${f(s.peakT, 2)} s`);
  if (Number.isFinite(s.peakMachUnguarded) && s.peakMachUnguarded > s.peakMach) {
    L.push(`                the settling guard costs the top of the curve: usable peak `
      + `M ${f(s.peakMach, 3)}, not M ${f(s.peakMachUnguarded, 3)}`);
  }
  L.push('');
  const hasRe = s.bins.some((b) => b.reynolds != null);
  let thin = false;
  L.push(`  Mach band        Cd        n    ${hasRe ? 'mean Re     ' : ''}coast t (s)`);
  L.push(`  ${'-'.repeat(hasRe ? 60 : 48)}`);
  for (const b of s.bins) {
    const isThin = b.t1 - b.t0 < THIN_BIN_S;
    if (isThin) thin = true;
    L.push(`  ${f(b.lo, 2)} - ${f(b.hi, 2)}    ${f(b.cd, 3).padStart(6)}${isThin ? '*' : ' '} `
      + `${String(b.n).padStart(6)}   `
      + `${hasRe ? `${(b.reynolds != null ? sci(b.reynolds, 3) : '').padEnd(12)}` : ''}`
      + `${f(b.t0, 2)} - ${f(b.t1, 2)}`);
  }
  L.push(`  ${'-'.repeat(hasRe ? 60 : 48)}`);
  L.push(`  M ${f(s.band.lo, 2)} - ${f(s.band.hi, 2)}    ${f(s.band.cd, 4).padStart(6)}  `
    + `${String(s.band.n).padStart(6)}   headline mean`);
  if (thin) {
    L.push(`  * under ${f(THIN_BIN_S, 2)} s of coast in the bin — an indication, not a measurement.`);
  }
  L.push('');
  const sn = s.sensitivity;
  if (sn) {
    const row = (label, value) => L.push(`  ${label.padEnd(34, '.')} ${value}`);
    L.push('Error budget — one-at-a-time, on THIS flight. Do not quote a bare Cd.');
    row(`burnout mass +-${(sn.massDeltaKg * 1000).toFixed(0)} g `, `+-${f(Math.abs(sn.massPct), 2)} %`);
    row(`diameter +${sn.diamDeltaIn.toFixed(2)} in `, `${f(sn.diamPct, 2)} %`);
    row(`accel scale x${sn.scaleK} `, sn.scalePct == null ? 'n/a' : `${f(sn.scalePct, 2)} %`);
    // No docs/ path in the PRINTED report: docs/ is gitignored, local to Eric's
    // two machines, and absent from the public repo — and this report is the
    // artefact most likely to be pasted somewhere else. The citation stays in
    // the module docblock, where the provenance rule wants it.
    L.push('  Combined realistic budget +-8-10 % — derivation in the module docblock.');
    L.push('  Bring flight-derived Cd into the harness informational, not gating.');
  }
  return L.join('\n');
}

/** The per-sample series, for --csv. Same numbers as the table, one row each. */
export function seriesToCsv(series) {
  const head = 't_s,mach,cd,reynolds,velocity_ms,density_kg_m3,temperature_k,pressure_pa,'
    + 'altitude_m,axial_g';
  const lines = [head];
  for (const s of series) {
    lines.push([
      s.t.toFixed(4), s.machNumber.toFixed(5), s.cd.toFixed(6),
      s.reynolds == null ? '' : s.reynolds.toFixed(0),
      s.velocityMs.toFixed(4), s.densityKgM3.toFixed(6), s.temperatureK.toFixed(3),
      s.pressurePa.toFixed(1), s.altitudeM.toFixed(2), s.aAxG.toFixed(5),
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = `
Cd from flight data — recover Cd vs Mach from a rocket accelerometer log.

  node packages/app/scripts/cdFromFlight.mjs <accel.csv> --mass-kg N --diameter-in N [options]

Required
  --mass-kg N          BURNOUT mass in kg (liftoff mass minus propellant). Cd is
                       extracted during coast, so this is the mass that is coasting.
                       There is no default, ever.
  --diameter-m N       Reference diameter in metres, or
  --diameter-in N      ...in inches. Cd goes as 1/d^2.

Density (one of these, or it refuses — it never assumes sea level)
  --baro <file.csv>    Low-rate companion log with a barometric pressure column.
  --site-elevation-m N Field elevation MSL, for the ISA fallback.
  --pad-temp-c N       Free-air pad temperature (NOT the board temperature).

Optional
  --length-m N         Reference length, enables the Reynolds column.
  --accel-scale X      pad (default) | none | a number. The per-flight scale k.
  --burnout-s N        Override the detected burnout time.
  --apogee-s N         Override the detected apogee time.
  --settle-s N         Post-burnout guard, default ${SETTLE_S} s.
  --altitude-unit ft|m For an altitude column whose name carries no unit.
  --mach-band lo,hi    Headline band, default ${REPORT_BAND[0]},${REPORT_BAND[1]}.
  --accel-column NAME  Exact header text of the axial channel.
  --time-column NAME   Exact header text of the flight clock.
  --csv <out.csv>      Write the per-sample series.
  --json               Emit the summary as JSON instead of the table.
`.trimStart();

/** Minimal flag parser: `--name value` and bare `--flag`. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/** Read a numeric flag, or null. Throws R9 rather than silently reading NaN. */
function numFlag(args, name) {
  if (args[name] === undefined) return null;
  // A bare `--mass-kg` (or `--mass-kg --diameter-in 1.17`, which is the same
  // thing to parseArgs) comes back as boolean `true`, and Number(true) is 1. On
  // the real F10 flight that silently became a 1 kg rocket, printed
  // "burnout mass 1.0000 kg" as if it had been given, reported a headline Cd of
  // 1.84 and exited 0 — which defeats the "there is no default, ever" the R9
  // messages promise. Every flag numFlag reads takes a value.
  if (typeof args[name] !== 'string') {
    fail('R9', `--${name} was given with no value. It takes a number; a bare flag would be read `
      + 'as 1 (of whatever unit this is) and reported as though you had passed it.');
  }
  const v = Number(args[name]);
  if (!Number.isFinite(v)) fail('R9', `--${name} "${args[name]}" is not a number.`);
  return v;
}

export function main(argv) {
  const args = parseArgs(argv.slice(2));
  if (args._.length === 0 || args.help) {
    console.log(USAGE);
    return args.help ? 0 : 1;
  }
  try {
    const diameterIn = numFlag(args, 'diameter-in');
    const machBandRaw = typeof args['mach-band'] === 'string' ? args['mach-band'].split(',').map(Number) : null;
    if (machBandRaw && (machBandRaw.length !== 2 || !machBandRaw.every(Number.isFinite))) {
      fail('R9', '--mach-band takes two numbers, e.g. --mach-band 0.25,0.72');
    }
    const options = {
      accelPath: args._[0],
      baroPath: typeof args.baro === 'string' ? args.baro : null,
      massKg: numFlag(args, 'mass-kg'),
      diameterM: numFlag(args, 'diameter-m') ?? (diameterIn != null ? diameterIn * IN : null),
      lengthM: numFlag(args, 'length-m'),
      siteElevationM: numFlag(args, 'site-elevation-m'),
      padTempC: numFlag(args, 'pad-temp-c'),
      accelScale: typeof args['accel-scale'] === 'string' ? args['accel-scale'] : 'pad',
      burnoutS: numFlag(args, 'burnout-s'),
      apogeeS: numFlag(args, 'apogee-s'),
      settleS: numFlag(args, 'settle-s') ?? SETTLE_S,
      altitudeUnit: typeof args['altitude-unit'] === 'string' ? args['altitude-unit'] : null,
      machBand: machBandRaw ?? REPORT_BAND,
      accelColumn: typeof args['accel-column'] === 'string' ? args['accel-column'] : null,
      timeColumn: typeof args['time-column'] === 'string' ? args['time-column'] : null,
    };
    const summary = analyse(options);

    if (summary.rateHz < WARN_RATE_HZ) {
      console.error(`warning: ${summary.rateHz.toFixed(1)} Hz log. Measured by decimating a real `
        + '500 Hz flight, the whole extraction reads about 2 % LOW on Cd by 50 Hz (0.2258 at '
        + '500 Hz, 0.2248 at 100 Hz, 0.2218 at 50 Hz); the number below is stamped LOW RATE for '
        + 'that reason.');
    }
    if (typeof args.csv === 'string') {
      writeFileSync(args.csv, seriesToCsv(summary.series));
      console.error(`wrote ${args.csv} (${summary.series.length} samples)`);
    }
    if (args.json) {
      const { series, ...rest } = summary;
      console.log(JSON.stringify({ ...rest, sampleCount: series.length }, null, 2));
    } else {
      console.log(formatReport(summary));
      if (summary.rateHz < WARN_RATE_HZ) console.log(`\n[LOW RATE: ${summary.rateHz.toFixed(1)} Hz]`);
    }
    return 0;
  } catch (err) {
    console.error(`\n${err.message}\n`);
    return 1;
  }
}

// Run the CLI only when invoked directly. Importing this module for its helpers
// must never execute any of the above or call process.exit — see the docblock.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
