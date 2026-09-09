import { DEFAULT_TIME_STEP_S, type SimulationOptions } from '@online-openrocket/engine';
import { useId } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, niceStep, siToUi, uiToSi, type Quantity } from '../prefs/units.js';
import { isaPressurePa, isaTemperatureK, padPressureIssue } from '../services/atmosphere.js';
import { Icon } from './Icon.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';

export interface LaunchConditions {
  launchRodLengthM: number;
  launchRodAngleDeg: number;
  windAverage: number;
  /** Gusts: standard deviation (m/s). */
  windStdDev: number;
  launchAltitudeM: number;
  /** °C at the launch site; blank/NaN = ISA standard. */
  temperatureC: number | null;
  /** hPa at the launch site; blank/NaN = ISA standard. */
  pressureHPa: number | null;
  latitudeDeg: number;
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
  const bothBlank = l.temperatureC === null && l.pressureHPa === null;
  return {
    launchRodLength: l.launchRodLengthM,
    launchRodAngle: (l.launchRodAngleDeg * Math.PI) / 180,
    windAverage: l.windAverage,
    windStdDeviation: l.windStdDev,
    launchAltitude: l.launchAltitudeM,
    temperature: l.temperatureC !== null ? l.temperatureC + 273.15
      : bothBlank ? undefined : isaTemperatureK(l.launchAltitudeM),
    pressure: l.pressureHPa !== null ? l.pressureHPa * 100
      : bothBlank ? undefined : isaPressurePa(l.launchAltitudeM),
    launchLatitude: l.latitudeDeg,
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

/** How each stored field maps to a preference quantity (stored value → SI). */
const FIELD_SPEC: Partial<Record<keyof LaunchConditions, { quantity: Quantity; storedToSI: number; storedOffset?: number }>> = {
  launchRodLengthM: { quantity: 'length', storedToSI: 1 },
  launchRodAngleDeg: { quantity: 'angle', storedToSI: Math.PI / 180 },
  windAverage: { quantity: 'windspeed', storedToSI: 1 },
  windStdDev: { quantity: 'windspeed', storedToSI: 1 },
  launchAltitudeM: { quantity: 'distance', storedToSI: 1 },
  temperatureC: { quantity: 'temperature', storedToSI: 1, storedOffset: 273.15 },
  pressureHPa: { quantity: 'pressure', storedToSI: 100 },
};

/**
 * One unit-aware launch-condition field. Extracted from LaunchPanel's local
 * closure so the phone Fly screen (S4) renders the SAME conversion and
 * validation for its three field-side conditions instead of a copy.
 */
export function LaunchField({ label, field, value, onChange, stepStored, min, max, nullable = false, autoStored, help }: {
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
   * Only the two atmosphere fields pass one. It is deliberately a placeholder
   * and not a committed value: blank stays LINKED to Site altitude, so moving
   * the pad from 500 ft to 5,000 ft re-reads both. Writing real numbers into
   * the boxes instead would freeze them at the old site's air the moment the
   * altitude changed — the same stale-number trap in a new place.
   */
  autoStored?: number;
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
        value={value[field] === null ? undefined : toUi(value[field] as number)}
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
        placeholder={autoStored !== undefined
          ? fmtSi(spec!.quantity, symbol!, storedToSi(autoStored))
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
export const STATION_PRESSURE_HELP =
  'Filled in from your Site altitude — the greyed number is what a blank field flies, and it '
  + 'follows the altitude when you change it. Type a value only to try a specific day’s air. '
  + 'If you do, it is STATION pressure — what a barometer reads at the pad — not the '
  + 'sea-level altimeter setting an airport broadcasts; those differ by about 15 % at 3,900 ft.';

export const SITE_TEMPERATURE_HELP =
  'Filled in from your Site altitude — the greyed number is what a blank field flies (the ISA '
  + 'standard, 15 °C at sea level falling 6.5 °C per km), and it follows the altitude when '
  + 'you change it. Type a value only to try a specific day’s air: a hot pad thins it and '
  + 'raises the speed of sound, which moves both apogee and the Mach numbers.';

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
export function PadPressureCaution({ value }: { value: LaunchConditions }) {
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

export function LaunchPanel({ value, onChange, onLaunch, simulating, lastRun }: {
  value: LaunchConditions;
  onChange: (v: LaunchConditions) => void;
  onLaunch: () => void;
  simulating: boolean;
  /**
   * The last flight's measured duration and the step it flew at, when there has
   * been one. Turns the time-step caution from an abstract multiplier into the
   * number the user cares about: how many seconds they are about to wait.
   */
  lastRun?: { ms: number; timeStepS?: number } | null;
}) {
  const numField = (label: string, key: keyof LaunchConditions, stepStored: number,
      min?: number, max?: number, nullable = false, help?: string, autoStored?: number) => (
    <LaunchField label={label} field={key} value={value} onChange={onChange}
      stepStored={stepStored} min={min} max={max} nullable={nullable}
      autoStored={autoStored} help={help} />
  );

  return (
    <div className="panel">
      <h2>Launch conditions</h2>
      <div className="field-grid">
        {numField('Rod length', 'launchRodLengthM', 0.1, 0)}
        {numField('Rod angle', 'launchRodAngleDeg', 1, -30, 30)}
        {numField('Wind avg', 'windAverage', 0.5, 0)}
        {numField('Wind gusts σ', 'windStdDev', 0.1, 0)}
        {numField('Site altitude', 'launchAltitudeM', 50, 0, 10000)}
        {numField('Latitude (°)', 'latitudeDeg', 1, -90, 90)}
        {numField('Temperature', 'temperatureC', 1, -60, 60, true, SITE_TEMPERATURE_HELP,
          isaTemperatureK(value.launchAltitudeM) - 273.15)}
        {/* "Station pressure", not "Pressure" (2026-09-08). The bare label let
            every reader supply their own meaning, and the common one — the
            altimeter setting an airport broadcasts, or the sea-level figure a
            weather app shows — is the wrong number by 15 % at 3,900 ft. Two
            words, sentence case, the same shape as "Site altitude" beside it. */}
        {numField('Station pressure', 'pressureHPa', 5, 300, 1100, true, STATION_PRESSURE_HELP,
          isaPressurePa(value.launchAltitudeM) / 100)}
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
      </div>
      <PadPressureCaution value={value} />
      <TimeStepCaution dt={value.timeStepS} lastRun={lastRun} />
      <button className="launch-btn" onClick={onLaunch} disabled={simulating}>
        {simulating ? 'Simulating…' : <><Icon name="rocket" size={15} /> Launch</>}
      </button>
    </div>
  );
}
