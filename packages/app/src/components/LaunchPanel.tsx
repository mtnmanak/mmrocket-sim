import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
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
import { coordinateLabel } from '../services/coordinates.js';
import {
  DEFAULT_TIME_STEP_S, flownGeodeticMethod, GEODETIC_METHODS, KERNEL_DEFAULT_LONGITUDE_DEG, LATITUDE_DEG_RANGE,
  LONGITUDE_DEG_RANGE, PANEL_TIME_STEP_FLOOR_S, ROD_AIM_DEG_RANGE, ROD_ANGLE_DEG_RANGE, ROD_LENGTH_M_RANGE,
  timeStepCostFactor, WIND_MS_RANGE, type LaunchConditions,
} from '../services/launchConditions.js';
import { editProfileSurface } from '../services/windProfile.js';
import { WindProfile } from './WindProfile.js';

// The launch conditions themselves — the stored shape, kernelSimOptions, the
// bounds, the rod-aim and longitude rules, the import clamp — are domain logic
// and live in the React-free services/launchConditions.ts (audit 2026-09-30,
// Step 8 item 22): while they lived here, the file readers, the flight report
// and the corpus sweep loaded React and every weather component with them.
// Re-exported for the components and tests that name the panel.
export {
  canonicalRodAimDeg, DEFAULT_CONDITIONS, DEFAULT_TIME_STEP_S, flownGeodeticMethod, flownLongitudeDeg, flownRodAimDeg,
  GEODETIC_METHODS, importLaunchValue, KERNEL_DEFAULT_LONGITUDE_DEG, kernelSimOptions, LATITUDE_DEG_RANGE,
  LONGITUDE_DEG_RANGE, normalizeRodAimDeg, PANEL_TIME_STEP_FLOOR_S, ROD_AIM_DEG_RANGE, ROD_ANGLE_DEG_RANGE,
  ROD_LENGTH_M_RANGE, timeStepCostFactor, WIND_MS_RANGE,
} from '../services/launchConditions.js';
export type { LaunchConditions } from '../services/launchConditions.js';

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
          onChange(editProfileSurface(value, { ...value, [field]: fromUi(ui) }));
        }}
      />
      {(field === 'latitudeDeg' || field === 'longitudeDeg') && (
        <span className="field-provenance" data-coordinate={field}>
          {coordinateLabel(value[field] ?? KERNEL_DEFAULT_LONGITUDE_DEG,
            field === 'latitudeDeg' ? 'latitude' : 'longitude', 6)}
          {value[field] == null ? ' (blank; flown default)' : ''}
        </span>
      )}
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
 * tests. The sign is the thing to say first: a positive number typed from a
 * map that prints "119.06° W" would put the flight in China. Said as the
 * conversion, not as "every US site is negative" — false for Guam, the
 * Northern Mariana Islands and the western Aleutians, across 180° (review of
 * 2026-09-23).
 */
export const LONGITUDE_HELP =
  'East is positive, west negative — a map’s 119.06° W is −119.06. Blank flies −80.6°, the desktop '
  + 'default. Longitude moves no flight number; it places the flight in the flight-data file’s '
  + 'Longitude column and travels with the .ork.';

/**
 * Help for the Geodetic calculations selector (board Tier 1 row 2, GS1).
 * Exported for the tests. The sizes are measured through the app's own open
 * and Launch on desktop OpenRocket's example designs that name Flat Earth
 * (2026-10-01): the landing point moved 0.015–0.28 m on the C6/B6 flights and
 * 3.0–3.4 m on the two 2.3 km L540 flights, apogee −59 to +2 mm. WGS84 is the
 * same physics as Spherical Earth (one Coriolis formula; engine geodetic.test.ts).
 */
export const GEODETIC_HELP =
  'How the flight treats the Earth — desktop OpenRocket’s setting of the same name. Spherical Earth, '
  + 'the default (desktop’s “Spherical approximation”), includes the Coriolis effect of the Earth’s '
  + 'spin. Flat Earth leaves it out, which moves the landing point by centimetres on a small flight and '
  + 'a few metres on a high one, and apogee by millimetres to centimetres. WGS84 ellipsoid flies the '
  + 'same physics as Spherical Earth and places the flight’s latitude and longitude on the WGS84 '
  + 'ellipsoid, the shape GPS uses. Desktop opens a file that names no model on Flat Earth, and so '
  + 'does this app.';

/**
 * THE GEODETIC SELECTOR, a `.field` like its neighbours so it sits in the grid.
 * It shows what the flight flies (`flownGeodeticMethod`), so a design saved
 * before the setting — or a stored value that is not a method — reads as the
 * Spherical Earth it flies; nothing is written until the user picks.
 */
function GeodeticField({ value, onChange }: { value: LaunchConditions; onChange: (v: LaunchConditions) => void }) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="field" title={GEODETIC_HELP}>
      <label htmlFor={id}>Geodetic calculations</label>
      <span id={helpId} className="sr-only">{GEODETIC_HELP}</span>
      <select id={id} aria-describedby={helpId} value={flownGeodeticMethod(value) ?? 'spherical'}
        onChange={(e) => {
          const picked = GEODETIC_METHODS.find((m) => m.value === e.target.value);
          if (picked) onChange({ ...value, geodeticMethod: picked.value });
        }}>
        {GEODETIC_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
    </div>
  );
}

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
  // The site the flight flies (`padAir` clamps the stored one into its range),
  // so "Clear the field and the app uses …" names the pressure it really would.
  const siteM = padAir(value).altitudeM;
  const site = fmtSi('distance', altSym, siteM);
  const standing = `${fmtSi('pressure', sym, isaPressurePa(siteM))} ${sym}`;
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
  onWeatherDismiss, onWeatherSigma, hasLaunchGuide = false,
}: {
  value: LaunchConditions;
  hasLaunchGuide?: boolean;
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
  // Both are number | null, and finite or null wherever a snapshot is built
  // (openMeteo's finiteOrNull, weatherSnapshot's finiteNullOrInvalid), so this
  // is a null test.
  // eslint-disable-next-line no-restricted-syntax -- a null test, not a design number (audit row 522)
  const forecastWind = weather && typeof fetched?.windSpeedMs === 'number' && typeof fetched.windGustMs === 'number'
    ? { meanMs: fetched.windSpeedMs, gustMs: fetched.windGustMs, source: sourceWord(weather.endpoint) } : null;
  // The Site altitude the flight flies: `padAir` clamps the stored one into the
  // field's range (NaN as 0). The blank atmosphere boxes advertise, and their
  // spinners step from, the standard day HERE — the stored figure is not a pad
  // the design flies (audit 2026-09-30: a session stored at 12,000 m showed,
  // and one step committed, 12 km air for a flight at 10 km).
  const siteM = padAir(value).altitudeM;
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
              Geodetic calculations
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
        <WindProfile value={value} onChange={onChange} />
        {/* The gust-to-σ chip (weather build, step 4): directly under the wind
            pair, full width, and only here — never inside LaunchField, which the
            Fly screen shares. */}
        <GustEstimate value={value} onChange={onChange} onEstimate={onWeatherSigma} forecastWind={forecastWind} />
        <div>
          {numField('Rod length', 'launchRodLengthM', 0.1, ROD_LENGTH_M_RANGE[0], undefined, false,
            rodLengthHelp(hasLaunchGuide, value.launchGuideAllowance))}
          {hasLaunchGuide && <label className="launch-guide-toggle">
            <input type="checkbox" checked={value.launchGuideAllowance !== false}
              onChange={(e) => onChange({ ...value, launchGuideAllowance: e.target.checked })} />
            Allow for lug and rail-button positions
          </label>}
        </div>
        {numField('Site altitude', 'launchAltitudeM', 50, ...SITE_ALTITUDE_M_RANGE)}
        {/* The atmosphere bounds are atmosphere.ts's, not literals: the importers
            and kernelSimOptions's chokepoint read the same arrays, so the panel
            refusing a value and the flight refusing it are one rule. */}
        {numField('Temperature', 'temperatureC', 1, ...PAD_TEMP_C_RANGE, true, SITE_TEMPERATURE_HELP,
          isaTemperatureK(siteM) - 273.15)}
        {/* "Station pressure", not "Pressure" (2026-09-08). The bare label let
            every reader supply their own meaning, and the common one — the
            altimeter setting an airport broadcasts, or the sea-level figure a
            weather app shows — is the wrong number by 15 % at 3,900 ft. Two
            words, sentence case, the same shape as "Site altitude" above it. */}
        {numField('Station pressure', 'pressureHPa', 5, ...PAD_PRESSURE_HPA_RANGE, true, STATION_PRESSURE_HELP,
          isaPressurePa(siteM) / 100)}
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
        {/* Under the coordinates its Coriolis term reads (GS1); desktop keeps it
            in its simulation options, beside the time step. */}
        <GeodeticField value={value} onChange={onChange} />
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

/** App tree only: synthetic protuberance carriers are not launch guides. */
export function hasLaunchGuides(tree: RocketTree): boolean {
  const guide = (n: ComponentNode): boolean => n.type === 'launchlug' || n.type === 'railbutton'
    || (n.children ?? []).some(guide);
  return tree.components.some(guide);
}

export function rodLengthHelp(hasGuide: boolean, allowance?: boolean): string {
  if (!hasGuide) return 'This design has no launch lug or rail button, so the whole length guides it (a tower, say) and no allowance is made.';
  if (allowance === false) return 'The allowance for lugs and rail buttons is switched off. The entered length is flown as the guided length.';
  return "Enter the rod's or rail's real length — do not shorten it yourself. The app allows for where your guides sit: a lug guides until it clears the top; rail buttons guide until the second-to-last station on their line clears it. With both a lug and usable rail buttons, the app uses whichever guides the shorter distance.";
}
