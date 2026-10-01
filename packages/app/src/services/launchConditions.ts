import { DEFAULT_TIME_STEP_S, KERNEL_WIND_FROM_RAD, type SimulationOptions } from '@online-openrocket/engine';
import { padAir } from './atmosphere.js';
import { kernelWindProfile, type WindProfileConditions } from './windProfile.js';

/**
 * THE LAUNCH CONDITIONS AS DATA: the stored shape, the one conversion to the
 * kernel's options, the panel's bounds, the rod-aim and longitude rules, the
 * time-step floor and its cost, and the clamp a file's value is imported
 * through.
 *
 * React-free on purpose (audit 2026-09-30, Step 8 item 22). All of this lived
 * in components/LaunchPanel.tsx, so every service that read one value of it —
 * the .ork and .CDX1 readers, the flight report, the batch runner, the import
 * planner — loaded React, PrefsContext, NumField and the weather components at
 * runtime too, and the node corpus sweep (scripts/matcher-sweep.worker.mjs)
 * transpiled TSX with a React JSX emit just to open a file. LaunchPanel
 * re-exports every binding here for the components and tests that name the
 * panel; a service imports from this module. launchConditions.test.ts loads it,
 * and the services that use it, with every React entry point recorded.
 */

export interface LaunchConditions extends WindProfileConditions {
  launchRodLengthM: number;
  /** Absent = on; preserve absent keys when restoring older sessions. */
  launchGuideAllowance?: boolean;
  launchRodAngleDeg: number;
  /**
   * Which way a tilted rod leans RELATIVE TO THE WIND, in degrees (weather
   * build, step 2): 0 = straight into the wind — how every flight flew before
   * the field existed — 180 = downwind, +90 = to your right as you face into
   * the wind. Stored as typed, inside `ROD_AIM_DEG_RANGE`; `flownRodAimDeg`
   * normalises it. It acts only while Rod angle is not 0.
   *
   * Built by turning the ROD, never the wind (`kernelSimOptions`): the
   * kernel's surface wind always blows from the east, so the landing bearing's
   * "downwind" (simReport's WIND_BLOWS_TOWARD_DEG) stays true whatever the aim.
   *
   * OPTIONAL, and absent means 0: a session or share link from before the
   * field restores without it and flies exactly as before. Never default-filled
   * on restore — `stableJson` would read the new key as an edit and mark every
   * restored design dirty. Out of `REQUIRED_CONDITION_KEYS` (simReport.ts), and
   * folded out of `conditionsKeyOf` whenever it does not move the flight
   * (`flownRodAimDeg`). The .ork reader ALWAYS writes it (0 for a file with no
   * manual rod direction), and so does the .CDX1 reader, so an opened file never
   * inherits the previous design's aim.
   */
  launchRodAimDeg?: number;
  windAverage: number;
  /** Gusts: standard deviation (m/s). */
  windStdDev: number;
  launchAltitudeM: number;
  /**
   * °C at the launch site. Blank, NaN or outside `PAD_TEMP_C_RANGE` = the ISA
   * standard for the SITE altitude (`padAir`), never for sea level.
   */
  temperatureC: number | null;
  /**
   * hPa at the launch site (station pressure). Blank, NaN or outside
   * `PAD_PRESSURE_HPA_RANGE` = the ISA standard for the SITE altitude.
   */
  pressureHPa: number | null;
  latitudeDeg: number;
  /**
   * Launch-site longitude (°, east positive; weather build, step 3). Absent
   * and null both mean blank, which flies `KERNEL_DEFAULT_LONGITUDE_DEG` —
   * the kernel's own default and desktop OpenRocket's. It moves no flight
   * number: it places the flight in the flight-data file's Longitude column
   * (λ) and travels with the .ork. The weather lookup offers it, beside
   * latitude, from the place it fetched for.
   *
   * OPTIONAL, never default-filled: a session or share link from before the
   * field restores without it and flies exactly as before, and `stableJson`
   * would read a filled-in key as an edit. Never `undefined` in state either —
   * null is the blank the panel writes. Out of `REQUIRED_CONDITION_KEYS`
   * (simReport.ts), and never hashed by `conditionsKeyOf` at all: it moves no
   * flight number, and every run flown from a desktop .ork before the field
   * was keyed without the file's longitude. A .CDX1 has no site coordinates,
   * so a RASAero import keeps both latitude and longitude from the design
   * before it.
   */
  longitudeDeg?: number | null;
  /**
   * Integration time step (s), seeded from the .ork's own `<simulation>` and
   * clamped there to MIN_IMPORTED_TIME_STEP_S. Absent = the engine's default
   * (0.05 s, the same as desktop OpenRocket).
   *
   * This IS exposed in the panel now. It used to be deliberately hidden as "a
   * fidelity setting the file carries, not a field anyone sets at the field" —
   * but a beta tester spent 40 seconds per flight on a file carrying 0.01 with
   * no way to see it, change it, or know it was there. A setting that costs
   * several times the run time cannot be invisible.
   */
  timeStepS?: number | null;
}

/**
 * Kernel SimulationOptions from the launch conditions — the ONE construction,
 * shared by Launch, the full-series CSV re-run and the batch runner so all three
 * fly identical conditions (the physics is deterministic: same options, same
 * flight). It lives beside LaunchConditions because that is what it converts.
 *
 * There used to be a second copy in BatchSimulate that silently omitted
 * `timeStep`, so a design carrying its own step from its .ork gave different
 * numbers in the batch table than the same design gave on the Launch button.
 */
export function kernelSimOptions(l: LaunchConditions): SimulationOptions {
  // A BLANK field means "the standard value for THIS SITE" — never "sea level".
  //
  // The kernel takes the site-altitude atmosphere only when BOTH fields are
  // absent. With one of them typed it stops doing that for the other, so a
  // blank pressure beside a typed temperature silently flew 101,325 Pa at a pad
  // however high it sat: worth 29.7 % of apogee on MESOS, and 24 of the 33
  // corpus sites above 1,000 ft state a temperature and no pressure.
  //
  // v0.120 answered that with help text and a caution telling people to type
  // both. That was the wrong half of the problem (Eric, 2026-09-08): this is a
  // SIMULATION of a flight that has not happened, so nobody knows what the
  // barometer will read on the day — the pad's standard pressure is something
  // the app can compute and the user cannot look up. Asking for it "AT THE PAD"
  // read like a request for flight data after the fact.
  //
  // So each field now falls back INDEPENDENTLY to the ISA value at the site
  // altitude, and the panel shows that value in the box as a placeholder so it
  // is visible rather than merely documented. Both blank still passes undefined
  // and lets the kernel do it, so those designs stay bit-identical.
  //
  // THE RULE LIVES IN `padAir` NOW (audit 2026-09-22), not here, because the
  // Recovery sizing panel needs the same two numbers and kept its own copy of
  // the kernel's old sea-level fill from v0.122 to v0.137 — sizing canopies in
  // air the flight never flew. One reading of the pad, used by both, is what
  // stops that recurring.
  //
  // It is also the CHOKEPOINT for a stored atmosphere nothing checked: a
  // temperature or pressure outside the panel's own envelope flies as blank
  // (the site's standard day) and the altitude is clamped to the Site altitude
  // field's range. The .ork importer always refused such values; the .CDX1
  // reader did not, and a pressure typed in hPa into RASAero's in-Hg field
  // flew 34x sea-level density with no note. Such a value is not a launch
  // site, so the site's standard day is the lesser wrong even for a session
  // that stored one before the importers checked.
  //
  // The other launch fields are bounded where they ENTER — the panel refuses
  // an out-of-range value and both importers clamp one with a note — and are
  // passed here as stored. Outside its bounds a rod angle or a wind is still a
  // setting the kernel can fly, so clamping it at flight time would only make
  // the flight disagree, silently, with the number in the box.
  const air = padAir(l);
  const longitude = flownLongitudeDeg(l);
  const aim = flownRodAimDeg(l);
  return {
    launchRodLength: l.launchRodLengthM,
    ...(l.launchGuideAllowance === false ? { guideAllowance: false } : {}),
    launchRodAngle: (l.launchRodAngleDeg * Math.PI) / 180,
    windAverage: l.windAverage,
    windStdDeviation: l.windStdDev,
    ...kernelWindProfile(l),
    launchAltitude: air.altitudeM,
    temperature: air.standard ? undefined : air.temperatureK,
    pressure: air.standard ? undefined : air.pressurePa,
    launchLatitude: l.latitudeDeg,
    // Rod aim turns the ROD about the kernel's fixed wind (from π/2, the
    // east): into the wind is a rod direction equal to the wind's, and the aim
    // is added to that. Only when it moves the flight — a tilted rod aimed off
    // the wind. At aim 0, or with a vertical rod, the key is absent and every
    // design hands the kernel the bytes it always did (LaunchPanel.test's
    // golden). That guard is load-bearing, not tidiness: a vertical rod aimed
    // 37° is NOT the same flight bit for bit — the launch quaternion's product
    // rounds — and on the reference C6 at 4 m/s, σ 1, apogee moves 3 µm
    // (327.76024201749783 m against 327.7602449449038 m, re-measured).
    ...(aim !== null ? { launchRodDirection: KERNEL_WIND_FROM_RAD + (aim * Math.PI) / 180 } : {}),
    // Only when it would move something: a blank (or the default itself) is
    // left to the kernel's own −80.6, so every design saved before the field
    // hands the kernel byte-identical options.
    ...(longitude !== null ? { launchLongitude: longitude } : {}),
    // `!= null` covers BOTH absent and cleared: the panel's nullable fields
    // commit null when emptied, and null means the same thing absent does —
    // fly the engine's default.
    ...(l.timeStepS != null ? { timeStep: l.timeStepS } : {}),
  };
}

/**
 * The engine's — and desktop OpenRocket's — default integration time step, and
 * the floor an imported design file is clamped to. Finer is slower and NOT more
 * accurate; see `timeStepCostFactor` for the measurement. Re-exported from the
 * engine package, which owns the actual `?? DEFAULT_TIME_STEP_S` fallback a
 * simulation flies — the panel copy quoting one number while the engine flew
 * another is exactly the drift a single definition rules out.
 */
export { DEFAULT_TIME_STEP_S };

/**
 * Where the Time step field bottoms out — its NumField `min` in LaunchPanel, matching
 * desktop OpenRocket's own spinner minimum. This is the app's HARD floor, on
 * every path: the field refuses a smaller value and displays it as "0", so
 * .ork import (even of our own files — see importOrk's clamp) never lets one
 * through to the engine either.
 */
export const PANEL_TIME_STEP_FLOOR_S = 0.01;

/**
 * Roughly how much longer a flight takes at `dt` than at the 0.05 s default.
 *
 * Fitted to measured whole-flight timings on four designs with real published
 * thrust curves (Mach2.trf.ork, test01.ork, 38-54 2-stage.ork, LEM-IV.ork):
 *
 *   dt 0.01 -> 3.7-6.0x    dt 0.02 -> 2.0-2.8x
 *   dt 0.03 -> 1.5-1.7x    dt 0.04 -> 1.1-1.3x
 *
 * (0.05/dt)^0.9 reproduces the midpoints to within a few percent. It is an
 * estimate, and the UI says so — the true factor depends on how often the
 * adaptive limiters bind, which is design-specific.
 */
export function timeStepCostFactor(dt: number): number {
  return Math.pow(DEFAULT_TIME_STEP_S / dt, 0.9);
}

export const DEFAULT_CONDITIONS: LaunchConditions = {
  launchRodLengthM: 1,
  launchRodAngleDeg: 0,
  windAverage: 0,
  windStdDev: 0,
  launchAltitudeM: 0,
  temperatureC: null,
  pressureHPa: null,
  latitudeDeg: 28.61,
};

/**
 * THE PANEL'S OWN BOUNDS for the launch fields that are not the pad's air
 * (those are atmosphere.ts's `PAD_*` / `SITE_ALTITUDE_M_RANGE`), in stored
 * units, `Infinity` for an open end. LaunchPanel's `numField` calls and
 * the phone Fly screen's four fields read them (the Fly screen repeated the
 * literals until the weather build's step 2 gave it Rod aim), and the
 * importers clamp a file's value into them with a note — the same rule
 * the .ork reader has applied to `<atmosphere>` since v0.105: a value the panel
 * refuses could not be seen, checked or re-entered.
 *
 * Before the audit of 2026-09-22 the importers took these raw, so a file could
 * fly an 80° rail or a negative rod length. The rod angle's ±30° is the
 * panel's, deliberately tighter than desktop OpenRocket's ±60°
 * (`SimulationOptions.MAX_LAUNCH_ROD_ANGLE`): a desktop file flying a 45° rail
 * imports at 30° and says so, rather than carrying a number nobody could type
 * back into the panel.
 */
export const ROD_LENGTH_M_RANGE: readonly [number, number] = [0, Infinity];
export const ROD_ANGLE_DEG_RANGE: readonly [number, number] = [-30, 30];
export const WIND_MS_RANGE: readonly [number, number] = [0, Infinity];
export const LATITUDE_DEG_RANGE: readonly [number, number] = [-90, 90];
/** The Longitude field's bounds (°, east positive). The .ork reader clamps into it; the RASAero format has no longitude. */
export const LONGITUDE_DEG_RANGE: readonly [number, number] = [-180, 180];

/**
 * The Rod aim field's bounds (°; decision D1: signed, −180…180). The .ork
 * reader normalises a file's aim into it; the RASAero format has no rod
 * direction.
 */
export const ROD_AIM_DEG_RANGE: readonly [number, number] = [-180, 180];

/** Any angle (°) as its equivalent in (−180, 180] — so −180 reads as 180, and 540 as 180. */
export function normalizeRodAimDeg(x: number): number {
  const a = ((x % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}

/**
 * A Rod aim as the flight, the conditions key and the .ork all use it:
 * normalised into (−180, 180] and rounded to a billionth of a degree. NaN for
 * a non-finite one.
 *
 * The rounding is what makes an aim one number however it got here.
 * Normalising alone is lossy — `(x % 360 + 360) % 360` passes through 360.1,
 * so 0.1° comes out 0.10000000000002274 and 33.3° as 33.30000000000001
 * (measured) — and the .ork stores the rod's COMPASS direction, 90° + aim,
 * whose arithmetic loses the same low bits. Unrounded, a saved 0.1° reopened
 * as 0.10000000000002274: a number the user never typed, which the panel,
 * the next save and every share link would then carry. Rounded, it reopens as
 * saved (orkFile.test pins both the value and the flight). A billionth of a
 * degree is far below anything a rod can be set to, and far above that
 * arithmetic's error.
 */
export function canonicalRodAimDeg(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const r = Math.round(normalizeRodAimDeg(x) * 1e9) / 1e9;
  // The rounding can land on −180 (from −179.9999999999…), which is 180; and
  // −0 is 0.
  return r === -180 ? 180 : r === 0 ? 0 : r;
}

/**
 * The aim the kernel is handed (°, `canonicalRodAimDeg`), or null when the
 * flight is identical to aim 0: absent, not a finite number, a whole turn, or
 * a rod that is not tilted (a vertical rod has no direction). ONE predicate
 * for `kernelSimOptions` (which omits `launchRodDirection` on null) and
 * `conditionsKeyOf` (which folds the key on null and hashes this value
 * otherwise), so "does not move the flight" and "does not change the
 * conditions" cannot disagree (decision D9).
 */
export function flownRodAimDeg(l: Pick<LaunchConditions, 'launchRodAimDeg' | 'launchRodAngleDeg'>): number | null {
  const a = l.launchRodAimDeg;
  if (typeof a !== 'number' || !Number.isFinite(a)) return null;
  if (!(Number.isFinite(l.launchRodAngleDeg) && l.launchRodAngleDeg !== 0)) return null;
  const n = canonicalRodAimDeg(a);
  return n === 0 ? null : n;
}

/**
 * The longitude a blank Longitude field flies (°): the kernel's own default
 * (`OrkEngine.simulateJson`, `JsonLite.dbl(o, "launchLongitude", -80.60)`,
 * l. 918), which is desktop OpenRocket's preference default too — Cape
 * Canaveral. Mirrored here rather than exported from the engine package so
 * the one place the app decides "this flies the default" can name it.
 */
export const KERNEL_DEFAULT_LONGITUDE_DEG = -80.6;

/**
 * The longitude the kernel is handed, or null when the flight is identical to
 * leaving it blank — absent, cleared, not a finite number, or the default
 * itself. `kernelSimOptions` omits the key on null, so every design saved
 * before the field hands the kernel byte-identical options; the review
 * dialog reads it to tell a design with a site of its own. (`conditionsKeyOf`
 * does not use it: no longitude moves a flight number, so none is hashed.)
 */
export function flownLongitudeDeg(l: Pick<LaunchConditions, 'longitudeDeg'>): number | null {
  const x = l.longitudeDeg;
  return typeof x === 'number' && Number.isFinite(x) && x !== KERNEL_DEFAULT_LONGITUDE_DEG ? x : null;
}

/**
 * An imported launch value clamped into the panel's `range`, with one import
 * note when that moved it. `what` names the setting in prose and `field` is
 * the panel's own label, so the note names the box the user will look in;
 * `show` formats a value in the FILE's units, so the note quotes the number
 * its author typed.
 */
export function importLaunchValue(
  v: number,
  range: readonly [number, number],
  say: { what: string; field: string; show: (x: number) => string },
  notes: string[],
): number {
  const [lo, hi] = range;
  const b = Math.min(hi, Math.max(lo, v));
  if (b !== v) {
    const { what, field, show } = say;
    const accepts = hi === Infinity ? `nothing below ${show(lo)}` : `${show(lo)} to ${show(hi)}`;
    notes.push(`The file's ${what} is ${show(v)}, and the ${field} field under Launch conditions `
      + `accepts ${accepts} — imported as ${show(b)}. Change it there if you meant something else.`);
  }
  return b;
}
