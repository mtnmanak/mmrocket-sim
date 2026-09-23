import { DEFAULT_TIME_STEP_S, KERNEL_WIND_FROM_RAD, type SimulationOptions } from '@online-openrocket/engine';
import { useId } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtAltitude, fmtSi, niceStep, siToUi, uiToSi, type Quantity } from '../prefs/units.js';
import {
  densityAltitudeM, isaPressurePa, isaTemperatureK, PAD_PRESSURE_HPA_RANGE, PAD_TEMP_C_RANGE, padAir,
  padPressureIssue, SITE_ALTITUDE_M_RANGE,
} from '../services/atmosphere.js';
import { APPLY_KEYS, type ApplyKey, type WeatherSnapshot } from '../services/weatherSnapshot.js';
import { GustEstimate } from './GustEstimate.js';
import { Icon } from './Icon.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';
import { WeatherButton } from './WeatherButton.js';
import { provenanceText, WeatherStrip } from './WeatherStrip.js';
import { sourceWord } from './weatherText.js';

export interface LaunchConditions {
  launchRodLengthM: number;
  launchRodAngleDeg: number;
  /**
   * Which way a tilted rod leans RELATIVE TO THE WIND, in degrees (weather
   * build, step 2): 0 = straight into the wind — how every flight flew before
   * the field existed — 180 = downwind, +90 = to your right as you face into
   * the wind. Stored as typed, inside `ROD_AIM_DEG_RANGE`; `flownRodAimDeg`
   * normalises it. It acts only while Rod angle is not 0.
   *
   * Built by turning the ROD, never the wind (`kernelSimOptions`): the
   * kernel's wind always blows from the east, so the landing bearing's
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
    launchRodAngle: (l.launchRodAngleDeg * Math.PI) / 180,
    windAverage: l.windAverage,
    windStdDeviation: l.windStdDev,
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
 * Where the Time step field bottoms out — its NumField `min` below, matching
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
 * units, `Infinity` for an open end. The panel's `numField` calls below and
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

/** How each stored field maps to a preference quantity (stored value → SI). */
const FIELD_SPEC: Partial<Record<keyof LaunchConditions, { quantity: Quantity; storedToSI: number; storedOffset?: number }>> = {
  launchRodLengthM: { quantity: 'length', storedToSI: 1 },
  launchRodAngleDeg: { quantity: 'angle', storedToSI: Math.PI / 180 },
  launchRodAimDeg: { quantity: 'angle', storedToSI: Math.PI / 180 },
  windAverage: { quantity: 'windspeed', storedToSI: 1 },
  windStdDev: { quantity: 'windspeed', storedToSI: 1 },
  launchAltitudeM: { quantity: 'distance', storedToSI: 1 },
  temperatureC: { quantity: 'temperature', storedToSI: 1, storedOffset: 273.15 },
  pressureHPa: { quantity: 'pressure', storedToSI: 100 },
};

/**
 * One unit-aware launch-condition field. Extracted from LaunchPanel's local
 * closure so the phone Fly screen (S4) renders the SAME conversion and
 * validation for its four field-side conditions instead of a copy.
 */
export function LaunchField({
  label, field, value, onChange, stepStored, min, max, nullable = false, autoStored, absentStored, help, provenance,
}: {
  label: string;
  field: keyof LaunchConditions;
  value: LaunchConditions;
  onChange: (v: LaunchConditions) => void;
  stepStored: number;
  min?: number;
  max?: number;
  nullable?: boolean;
  /**
   * The value this field flies while it is BLANK, in stored units — shown in
   * the box as a placeholder so the number is visible rather than merely
   * described.
   *
   * The two atmosphere fields pass one, and Longitude passes the kernel's
   * default. It is deliberately a placeholder
   * and not a committed value: blank stays LINKED to Site altitude, so moving
   * the pad from 500 ft to 5,000 ft re-reads both. Writing real numbers into
   * the boxes instead would freeze them at the old site's air the moment the
   * altitude changed — the same stale-number trap in a new place.
   */
  autoStored?: number;
  /**
   * What an ABSENT value of a non-nullable OPTIONAL field means, in stored
   * units — shown in the box as that VALUE, not as a placeholder. Rod aim
   * passes 0: a design saved before the field has no key and flies aim 0, and
   * the box should say "0", as Rod angle's does. A placeholder would not do:
   * `fmtSi`'s default ladder prints 0 as "0.000", and a greyed hint reads as
   * "blank", which a non-nullable field never is. Nothing is written until the
   * user commits a value, so showing it dirties nothing.
   */
  absentStored?: number;
  /**
   * Field help — the sentence a short label cannot hold: "Station pressure"
   * says WHAT the field wants, the help says what leaving it blank actually
   * does.
   *
   * Reachable, not hover-only (2026-09-08, from review). A `title` alone is
   * neither announced by a screen reader nor reachable from the keyboard — so
   * the one sentence explaining the blank-pressure trap was mouse-only. It now
   * ALSO renders in a visually-hidden `<span>` that the input names through
   * `aria-describedby`, which is the association the `.field` idiom otherwise
   * does not make (the same gap `ariaLabel` was added for).
   *
   * The `title` stays on the wrapper `<div className="field">`, NOT on the
   * input (a later review read this comment as claiming the input carried it;
   * it never did, and `NumField` takes no `title` prop). The wrapper is the
   * better hover target anyway — it covers the label and the unit chip as well
   * as the box — and LaunchPanel.test.tsx reads the help off `.field[title]`.
   */
  help?: string;
  /**
   * Where this field's number came from, when applied weather set it
   * (weather build, step 3): "forecast", or "edited — forecast said 22.9 °C"
   * once the user has changed it. A line under the box; absent otherwise.
   */
  provenance?: string;
}) {
  const { prefs } = usePrefs();
  // Unique per instance: LaunchField renders in the Launch panel AND on the
  // phone Fly screen, and two elements sharing an id break the association.
  const helpId = `${useId()}-help`;
  const spec = FIELD_SPEC[field];
  const symbol = spec ? prefs.units[spec.quantity] : null;
  /**
   * A stored field value in SI. ONE definition, because there were two and they
   * disagreed (2026-09-09).
   *
   * `storedOffset` exists for exactly one field — `temperatureC`, stored in
   * degrees Celsius against an SI unit of kelvin — and the placeholder below
   * hand-rolled this conversion and left the offset out. So a blank Temperature
   * field advertised the sea-level standard as MINUS 258.15 C: 15 was handed to
   * a formatter that reads kelvin, and 15 K is -258.15 C. Reported by Eric
   * within hours of v0.122 shipping.
   *
   * Every conversion out of stored units goes through here now. A second copy
   * of an affine conversion is a second chance to drop the constant term.
   */
  const storedToSi = (stored: number) =>
    stored * (spec?.storedToSI ?? 1) + (spec?.storedOffset ?? 0) * (spec?.storedToSI ?? 1);
  const toUi = (stored: number) => spec && symbol
    ? siToUi(spec.quantity, symbol, storedToSi(stored))
    : stored;
  const fromUi = (ui: number) => spec && symbol
    ? (uiToSi(spec.quantity, symbol, ui) - (spec.storedOffset ?? 0) * spec.storedToSI) / spec.storedToSI
    : ui;
  const step = spec && symbol ? niceStep(toUi(stepStored) - toUi(0)) : stepStored;
  // Validation bounds live in stored units — convert to the display unit
  // (toUi is affine and increasing, so the bounds map cleanly).
  const uiMin = min === undefined ? undefined : toUi(min);
  const uiMax = max === undefined ? undefined : toUi(max);
  return (
    <div className="field" title={help}>
      <label>{label}{spec ? <> <UnitChip quantity={spec.quantity} /></> : ''}</label>
      {help ? <span id={helpId} className="sr-only">{help}</span> : null}
      {/* The .field idiom puts the <label> beside the control, not around it, so
          nothing associates them — a screen reader read these eight launch
          inputs as anonymous "edit" boxes. ariaLabel here names every
          LaunchField call site at once, the Fly screen's included. */}
      <NumField
        ariaLabel={symbol ? `${label} (${symbol})` : label}
        describedBy={help ? helpId : undefined}
        // `== null`, not `=== null`: an OPTIONAL field is absent (undefined)
        // from every session saved before it existed, and absent reads as
        // blank — or, for a non-nullable one given `absentStored` (Rod aim),
        // as the value absent means. Longitude has no unit spec, so toUi hands
        // undefined straight back and its box was blank either way; a field
        // WITH a spec would convert undefined to NaN, which the box shows as
        // "—" instead. LaunchPanel.test pins both.
        value={value[field] == null
          ? (!nullable && absentStored !== undefined ? toUi(absentStored) : undefined)
          : toUi(value[field] as number)}
        step={step}
        min={uiMin}
        max={uiMax}
        allowNegative={uiMin === undefined || uiMin < 0}
        nullable={nullable}
        // The auto value as a NUMBER when the field has one, so the box shows
        // what a blank actually flies — "1013 hPa", not the word "standard",
        // which told the reader nothing and was the whole complaint. NumField
        // reads the figure back out of the placeholder for its own
        // arrow-key-from-blank behaviour, so the two agree by construction.
        // A field with no unit quantity (Longitude, in plain degrees) shows its
        // auto value as the number itself; `spec!` here used to throw for one.
        placeholder={autoStored !== undefined
          ? (spec && symbol ? fmtSi(spec.quantity, symbol, storedToSi(autoStored)) : String(autoStored))
          : nullable ? 'standard' : undefined}
        // The auto value passed EXPLICITLY as a number as well, in display
        // units. NumField otherwise digs it back out of the placeholder text
        // with a regex, which made the wrong number above worse than cosmetic:
        // stepping the spinner up from a blank field seeded from -258.15 and
        // committed the field's own -60 C floor, and a typed value IS flown.
        autoValue={autoStored !== undefined ? toUi(autoStored) : undefined}
        onCommit={(ui) => {
          if (ui === null) {
            if (nullable) onChange({ ...value, [field]: null });
            return;
          }
          onChange({ ...value, [field]: fromUi(ui) });
        }}
      />
      {provenance ? <span className="field-provenance" data-provenance={field}>{provenance}</span> : null}
    </div>
  );
}

/**
 * Live caution when the time step is finer than the default.
 *
 * The user is allowed to go below 0.05 — a rocketeer reproducing an exact
 * desktop number has a real reason to — but not silently. A beta tester lost
 * forty seconds a flight to a 0.01 s step he could not see, so the cost is
 * stated in seconds wherever we know the last flight's actual duration, and as
 * a multiplier when we do not.
 *
 * Exported for the batch dialog, which honours the same step and pays the same
 * cost per flight — times its whole candidate list.
 */
export function TimeStepCaution({ dt, lastRun, flights = 1 }: {
  dt?: number | null;
  lastRun?: { ms: number; timeStepS?: number } | null;
  /**
   * How many flights the run this caution guards will fly: 1 (the default)
   * for the Launch button, the candidate count for the batch dialog. The
   * batch multiplies the cost by this, and a per-flight figure there would
   * hide a minutes-long freeze behind a seconds-long one.
   */
  flights?: number;
}) {
  if (dt == null || dt >= DEFAULT_TIME_STEP_S) return null;
  const factor = timeStepCostFactor(dt);
  // The last flight was measured at ITS OWN step, which is usually not the one
  // being typed now — scale between the two rather than assuming the default.
  const ref = lastRun && lastRun.ms > 0
    ? { s: lastRun.ms / 1000, f: timeStepCostFactor(lastRun.timeStepS ?? DEFAULT_TIME_STEP_S) }
    : null;
  const perFlight = ref ? ref.s * (factor / ref.f) : null;
  const atDefault = ref ? ref.s / ref.f : null;
  return (
    <p className="field-caution" role="status">
      <Icon name="zap" size={13} />{' '}
      <strong>{dt} s is finer than the {DEFAULT_TIME_STEP_S} s default.</strong>{' '}
      {flights > 1
        ? <>The whole batch — <strong>{flights}</strong> flights — takes
            about <strong>{factor.toFixed(1)}×</strong> longer, and each flight locks
            the page while it runs; Stop takes effect between them.</>
        : <>Flights take about <strong>{factor.toFixed(1)}×</strong> longer
            {perFlight !== null && atDefault !== null
              ? <> — roughly <strong>{perFlight < 10 ? perFlight.toFixed(1) : perFlight.toFixed(0)} s</strong>{' '}
                  per flight instead of {atDefault < 10 ? atDefault.toFixed(1) : atDefault.toFixed(0)} s</>
              : null}
            , and the page cannot respond while one runs.</>}
      {' '}In our testing it buys no
      accuracy you can read: against a converged reference, {DEFAULT_TIME_STEP_S} s
      lands apogee within 0.06 m on a 6.4 km flight and raises exactly the same
      warnings. See <em>Launch Conditions → Time step</em> in the Guide.
    </p>
  );
}

/**
 * Field help for the two atmosphere fields — the sentence the labels cannot
 * hold. Exported so the tests assert on the SAME strings the panel renders.
 *
 * REWRITTEN 2026-09-08b, on Eric's objection, which is worth keeping because it
 * is the reason the copy was wrong rather than merely long:
 *
 *   "since this is a simulation, how would the user even know what the actual
 *   precise pressure or temperature at the pad will be on the day they fly the
 *   rocket? [...] asking them for the pressure AT THE PAD is weird - are we
 *   trying to gather historical data from them?"
 *
 * v0.120's help was accurate about the mechanism and wrong about the user. It
 * asked for a barometer reading taken standing at the pad — a measurement of a
 * flight that has not happened — and made the app's correctness depend on the
 * user supplying it. The pad's standard pressure is the one quantity here the
 * app can compute and the user cannot look up.
 *
 * So the BEHAVIOUR moved to meet the copy instead of the copy explaining the
 * behaviour: a blank field now flies the ISA value at the SITE ALTITUDE
 * (kernelSimOptions), and the box shows that number as its placeholder. The
 * help no longer has a trap to describe — it says what the field is for, and
 * that typing one is how you try a different day.
 */
const STATION_PRESSURE_HELP =
  'Filled in from your Site altitude — the greyed number is what a blank field flies, and it '
  + 'follows the altitude when you change it. Type a value only to try a specific day’s air, and '
  + 'then it must be STATION pressure: the raw barometer reading at the pad, not the sea-level '
  + 'altimeter setting a weather app or an airport gives you. At a 3,900 ft pad those are about '
  + '878 and 1,013 hPa, and typing the sea-level one makes the app fly air about 15 % too dense.';

const SITE_TEMPERATURE_HELP =
  'Filled in from your Site altitude — the greyed number is what a blank field flies (the ISA '
  + 'standard, 15 °C at sea level falling 6.5 °C per km), and it follows the altitude when '
  + 'you change it. Type a value only to try a specific day’s air: a hot pad thins it and '
  + 'raises the speed of sound, which moves both apogee and the Mach numbers.';

/**
 * Help for the density-altitude readout. Exported for the tests, which assert
 * on the same string the panel renders.
 *
 * Deliberately NOT shaped like the two atmosphere helps above (no "Filled in
 * from your Site altitude" opening, no "falling 6.5", no "STATION pressure"):
 * the tests find those two by exactly those patterns, and this is a readout,
 * not a field that fills itself in. The per-degree figure is re-measured (the
 * slope of `densityAltitudeM` in temperature, pressure blank): at a 4,000 ft
 * field it is 105.5 ft per °C on a 95 °F day and 118.6 on a standard one — the
 * spec's 114 was a mis-measure — so "roughly 110" sits between the two.
 */
export const DENSITY_ALTITUDE_HELP =
  'How thin the pad’s air is, stated as an altitude: the height at which a standard day has air '
  + 'this dense. Worked out from the Temperature and Station pressure the flight uses — typed, or '
  + 'filled in from your Site altitude — so with both boxes blank it equals your site altitude, and a '
  + 'hot afternoon or a low barometer pushes it up (roughly 110 ft, 33 m, for each °C at a 4,000 ft '
  + 'field). A readout, not a setting: the flight already flies this air. It is not the same as '
  + 'launching from that altitude — the speed of sound and the motor’s pressure thrust still follow '
  + 'your real temperature and pressure. Dry air: humid air is slightly thinner, so on a muggy day '
  + 'the true figure is a few hundred feet higher.';

/**
 * Help for the Rod aim field (weather build, step 2). Exported for the tests.
 * The sign convention is measured, not asserted: the wind blows from the east
 * (KERNEL_WIND_FROM_RAD), so facing into it faces east and your right is
 * south — and a +90° aim lands a calm-air flight to the south
 * (simReport.kernel.test.ts). The last sentence is the identity
 * packages/engine/src/rodDirection.test.ts measures: +5° aimed 180° flies as −5°.
 */
export const ROD_AIM_HELP =
  'Which way the rod leans, measured from straight into the wind: 0° (the default) leans it into the '
  + 'wind, 180° downwind, ±90° across it — positive to your right as you face into the wind. It only '
  + 'matters when Rod angle is not 0; a vertical rod has no direction. A negative Rod angle already '
  + 'leans the rod downwind, the same as adding 180° here.';

/**
 * Help for the Longitude field (weather build, step 3). Exported for the
 * tests. The sign is the thing to say first: every US site is WEST, so
 * negative, and a positive number typed from a map that prints "119.06 W"
 * would put the flight in China.
 */
export const LONGITUDE_HELP =
  'East is positive, west negative — every US site is negative. Blank flies −80.6°, the desktop '
  + 'default. Longitude moves no flight number; it places the flight in the flight-data file’s '
  + 'Longitude column and travels with the .ork.';

/**
 * DENSITY ALTITUDE, as a readout in the grid (weather build, step 1).
 *
 * An `<output>`, not a read-only input or a NumField: nothing here is
 * editable, and a box that looks typeable and refuses the keyboard is the
 * worse lie. It moves no flight number — it DESCRIBES the air `padAir` hands
 * the kernel (services/atmosphere.ts `densityAltitudeM`), so it follows a
 * typed field, a blank one filled from the site, and the envelope, exactly as
 * the flight does.
 *
 * Muted when both fields are blank, because it then says nothing the Site
 * altitude box does not: it IS the (clamped) site altitude. The delta is
 * measured from `padAir`'s clamped altitude, never the stored one, which can
 * be NaN or outside the field's range after an import.
 */
function DensityAltitudeReadout({ value }: { value: LaunchConditions }) {
  const { prefs } = usePrefs();
  const id = useId();
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const sym = prefs.units.distance;
  const air = padAir(value);
  const da = densityAltitudeM(value);
  const delta = fmtAltitude(sym, da - air.altitudeM);
  return (
    <div className="field field-readout" title={DENSITY_ALTITUDE_HELP} data-readout="density-altitude">
      <label id={labelId}>Density altitude <UnitChip quantity="distance" /></label>
      <span id={helpId} className="sr-only">{DENSITY_ALTITUDE_HELP}</span>
      <output aria-labelledby={labelId} aria-describedby={helpId} aria-live="off"
        className={air.standard ? 'readout-muted' : undefined}>
        {fmtAltitude(sym, da)}
        {delta !== '0' && delta !== '—'
          ? <span className="readout-delta"> ({da > air.altitudeM ? '+' : ''}{delta} vs site)</span>
          : null}
      </output>
    </div>
  );
}

/**
 * Live caution when a TYPED station pressure is really an altimeter setting.
 *
 * Down from three branches to one (2026-09-08b). The other two fired when a
 * field was left blank, and blank is no longer a mistake — `kernelSimOptions`
 * fills it from the site altitude. A caution that fires on correct input is one
 * users learn to skip past, and those two were doing exactly that: warning
 * about the app's own sea-level fallback in the voice of a user error.
 *
 * What is left is the case no default can rescue, because the user typed a
 * number and the app cannot tell it is the wrong KIND of number except by
 * checking it against the site. It quotes the figure the altitude implies,
 * since "type your station pressure" is not actionable without one, and it
 * offers the blank field as the fix rather than asking for a barometer reading
 * nobody has. Silent below 600 m.
 */
function PadPressureCaution({ value }: { value: LaunchConditions }) {
  const { prefs } = usePrefs();
  const issue = padPressureIssue(value);
  if (!issue) return null;
  const sym = prefs.units.pressure;
  const altSym = prefs.units.distance;
  const site = fmtSi('distance', altSym, value.launchAltitudeM);
  const standing = `${fmtSi('pressure', sym, isaPressurePa(value.launchAltitudeM))} ${sym}`;
  return (
    <p className="field-caution" role="status" data-caution="pad-pressure">
      <Icon name="zap" size={13} />{' '}
      <><strong>{fmtSi('pressure', sym, value.pressureHPa! * 100)} {sym} is about sea-level
        pressure</strong>, and this pad is {site} {altSym} up, where a barometer reads about{' '}
        {standing}. That looks like an altimeter setting rather than what the pad reads. The flight would
        then fly air that is too dense — more drag, and less of the extra thrust a motor
        gains as the air thins — so it under-predicts apogee.{' '}
        Clear the field and the app uses {standing}, the standing pressure for your site
        altitude.</>
      {' '}See <em>Launch Conditions</em> in the Guide.
    </p>
  );
}

export function LaunchPanel({
  value, onChange, onLaunch, simulating, canLaunch, lastRun, weather, onGetWeather, onWeatherFetchAgain, onWeatherUndo,
  onWeatherDismiss, onWeatherSigma,
}: {
  value: LaunchConditions;
  onChange: (v: LaunchConditions) => void;
  onLaunch: () => void;
  simulating: boolean;
  /**
   * False until a motor is assigned. Without it this button was enabled with
   * no motor loaded and the click fell through the early return in onLaunch,
   * so the user got silence — while the vitals strip on the SAME page showed
   * a greyed-out Launch. FlyScreen takes the identical prop from the identical
   * expression; the three Launch buttons agree now.
   */
  canLaunch: boolean;
  /**
   * The last flight's measured duration and the step it flew at, when there has
   * been one. Turns the time-step caution from an abstract multiplier into the
   * number the user cares about: how many seconds they are about to wait.
   */
  lastRun?: { ms: number; timeStepS?: number } | null;
  /**
   * Where applied weather came from (weather build, step 3) — App's session
   * state, never the design's. Drives the strip under the grid and the
   * "forecast" line under each field it set. Null/absent: nothing applied, or
   * dismissed.
   */
  weather?: WeatherSnapshot | null;
  /** Opens App's ☁ Get weather dialog; no button without it. */
  onGetWeather?: () => void;
  /**
   * The stale strip's Fetch again: the same dialog, opened on the applied
   * weather's date and hour rather than today. Falls back to `onGetWeather`.
   */
  onWeatherFetchAgain?: () => void;
  /** The strip's Undo: puts back what the applied fields held (App, functionally). */
  onWeatherUndo?: () => void;
  /** The strip's Dismiss: keeps the values, drops the provenance. */
  onWeatherDismiss?: () => void;
  /**
   * The gust chip's click: App writes σ and records what it replaced on the
   * weather record, so Undo can put it back. Without it the chip writes σ
   * through `onChange` alone.
   */
  onWeatherSigma?: (sigmaMs: number) => void;
}) {
  const { prefs } = usePrefs();
  // The applied forecast hour's mean wind and gust — what the σ chip works
  // from. From the snapshot's FETCHED values, whether or not the wind was
  // applied; the chip itself decides whether Wind avg still matches.
  const fetched = weather?.fetched;
  const forecastWind = weather && typeof fetched?.windSpeedMs === 'number' && typeof fetched.windGustMs === 'number'
    ? { meanMs: fetched.windSpeedMs, gustMs: fetched.windGustMs, source: sourceWord(weather.endpoint) } : null;
  const numField = (label: string, key: keyof LaunchConditions, stepStored: number,
      min?: number, max?: number, nullable = false, help?: string, autoStored?: number, absentStored?: number) => (
    <LaunchField label={label} field={key} value={value} onChange={onChange}
      stepStored={stepStored} min={min} max={max} nullable={nullable}
      autoStored={autoStored} absentStored={absentStored} help={help}
      provenance={weather && (APPLY_KEYS as readonly string[]).includes(key)
        ? provenanceText(value, weather, key as ApplyKey, prefs.units) : undefined} />
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <h2 style={{ flex: 1 }}>Launch conditions</h2>
        {onGetWeather && <WeatherButton onClick={onGetWeather} />}
      </div>
      <div className="field-grid">
        {/* THE ORDER IS THE LAYOUT. `.field-grid` is a fixed two columns, so
            cells pair off in the order written here (weather build, spec §0.4,
            decision D8; LaunchPanel.test pins it):
              Rod angle        | Rod aim
              Wind avg         | Wind gusts σ
              [gust chip, full width — only with an applied forecast]
              Rod length       | Site altitude
              Temperature      | Station pressure
              Density altitude | Time step
              Latitude         | Longitude
            Rod aim sits beside the Rod angle it only matters with. σ must stay
            a RIGHT-hand cell, so the chip's full-width row under it starts
            clean. Step 1 had put Density altitude beside Site altitude; this
            order moves it under the Temperature and Station pressure it is
            worked out from, and its "(+952 vs site)" still names what it is
            measured against.
            Open-ended bounds pass no max: the field has none to enforce. */}
        {numField('Rod angle', 'launchRodAngleDeg', 1, ...ROD_ANGLE_DEG_RANGE)}
        {/* Non-nullable, and absent (every design saved before the field)
            shows the 0 it flies — as a value, never fmtSi's "0.000". */}
        {numField('Rod aim', 'launchRodAimDeg', 15, ...ROD_AIM_DEG_RANGE, false, ROD_AIM_HELP, undefined, 0)}
        {numField('Wind avg', 'windAverage', 0.5, WIND_MS_RANGE[0])}
        {numField('Wind gusts σ', 'windStdDev', 0.1, WIND_MS_RANGE[0])}
        {/* The gust-to-σ chip (weather build, step 4): directly under the wind
            pair, full width, and only here — never inside LaunchField, which the
            Fly screen shares. */}
        <GustEstimate value={value} onChange={onChange} onEstimate={onWeatherSigma} forecastWind={forecastWind} />
        {numField('Rod length', 'launchRodLengthM', 0.1, ROD_LENGTH_M_RANGE[0])}
        {numField('Site altitude', 'launchAltitudeM', 50, ...SITE_ALTITUDE_M_RANGE)}
        {/* The atmosphere bounds are atmosphere.ts's, not literals: the importers
            and kernelSimOptions's chokepoint read the same arrays, so the panel
            refusing a value and the flight refusing it are one rule. */}
        {numField('Temperature', 'temperatureC', 1, ...PAD_TEMP_C_RANGE, true, SITE_TEMPERATURE_HELP,
          isaTemperatureK(value.launchAltitudeM) - 273.15)}
        {/* "Station pressure", not "Pressure" (2026-09-08). The bare label let
            every reader supply their own meaning, and the common one — the
            altimeter setting an airport broadcasts, or the sea-level figure a
            weather app shows — is the wrong number by 15 % at 3,900 ft. Two
            words, sentence case, the same shape as "Site altitude" above it. */}
        {numField('Station pressure', 'pressureHPa', 5, ...PAD_PRESSURE_HPA_RANGE, true, STATION_PRESSURE_HELP,
          isaPressurePa(value.launchAltitudeM) / 100)}
        <DensityAltitudeReadout value={value} />
        {/* Blank = 0.05 s, the engine's and desktop OpenRocket's default. Smaller
            is slower and NOT more accurate: measured against a converged dt
            0.002 reference on four designs with real thrust curves, 0.05 lands
            apogee within 0.06 m on a 6.4 km flight and produces an identical
            warning set. The simulator already shortens the step by itself where
            the flight is changing fast, and lands exactly on each event — this
            is a ceiling, not the step.
            Floor 0.01 (PANEL_TIME_STEP_FLOOR_S), matching desktop OpenRocket's
            own spinner minimum: below that the cost runs away (0.001 is ~2 minutes
            of frozen tab on a file this release exists to make fast) for no
            measurable accuracy. */}
        {numField('Time step (s)', 'timeStepS', 0.01, PANEL_TIME_STEP_FLOOR_S, 1, true)}
        {numField('Latitude (°)', 'latitudeDeg', 1, ...LATITUDE_DEG_RANGE)}
        {/* Beside Latitude, its pair (weather build, step 3). Blank shows the
            −80.6 it flies. */}
        {numField('Longitude (°)', 'longitudeDeg', 1, ...LONGITUDE_DEG_RANGE, true, LONGITUDE_HELP,
          KERNEL_DEFAULT_LONGITUDE_DEG)}
      </div>
      {/* Not a .field-caution: the tests (and a reader) take the FIRST caution
          as the one about what was typed. */}
      {weather && (
        <WeatherStrip weather={weather} launch={value} onChange={onChange}
          onUndo={() => onWeatherUndo?.()} onDismiss={() => onWeatherDismiss?.()}
          onFetchAgain={onWeatherFetchAgain ?? onGetWeather} />
      )}
      <PadPressureCaution value={value} />
      <TimeStepCaution dt={value.timeStepS} lastRun={lastRun} />
      <button className="launch-btn" onClick={onLaunch}
        disabled={!canLaunch || simulating}
        title={!canLaunch ? 'Assign a motor first' : 'Simulate the flight'}>
        {simulating ? 'Simulating…' : <><Icon name="rocket" size={15} /> Launch</>}
      </button>
    </div>
  );
}
