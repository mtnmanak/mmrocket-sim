import { DEFAULT_TIME_STEP_S, ISA_SEA_LEVEL, type SimulationOptions } from '@online-openrocket/engine';
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
  return {
    launchRodLength: l.launchRodLengthM,
    launchRodAngle: (l.launchRodAngleDeg * Math.PI) / 180,
    windAverage: l.windAverage,
    windStdDeviation: l.windStdDev,
    launchAltitude: l.launchAltitudeM,
    temperature: l.temperatureC === null ? undefined : l.temperatureC + 273.15,
    pressure: l.pressureHPa === null ? undefined : l.pressureHPa * 100,
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
export function LaunchField({ label, field, value, onChange, stepStored, min, max, nullable = false, help }: {
  label: string;
  field: keyof LaunchConditions;
  value: LaunchConditions;
  onChange: (v: LaunchConditions) => void;
  stepStored: number;
  min?: number;
  max?: number;
  nullable?: boolean;
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
  const toUi = (stored: number) => spec && symbol
    ? siToUi(spec.quantity, symbol, stored * spec.storedToSI + (spec.storedOffset ?? 0) * spec.storedToSI)
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
        placeholder={nullable ? 'standard' : undefined}
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
 * Both exist because of the 2026-09-08 finding: the kernel takes temperature
 * and pressure as a PAIR, and fills whichever one is blank with the standard
 * SEA-LEVEL value applied at the pad (see services/atmosphere.ts for the
 * mechanism and the measurements). So "left blank it is computed from your
 * site altitude" is true of either field only when BOTH are blank.
 *
 * The temperature half was still stated wrongly through v0.120, and by the very
 * copy that steered people into it: it promised "the ISA standard 15 °C at sea
 * level, lapsing with your site altitude" one line after telling the reader to
 * type a station pressure — which is the thing that switches the lapse off.
 * Measured at 2,682 m, that leaves 288.15 K at the pad against a standard
 * 270.72 K: air 6.05 % thin and a speed of sound 3.17 % high. Both helps now
 * say the same thing, which is: type the two together, or leave both blank.
 */
export const STATION_PRESSURE_HELP =
  'The pressure AT THE PAD — what a barometer reads standing there — not the sea-level '
  + 'altimeter setting an airport broadcasts. Leave this and Temperature BOTH blank and the '
  + 'app computes the pad\'s pressure from your site altitude. Leave only this blank while a '
  + 'temperature is typed and it does not: the flight then uses sea-level pressure — 101,325 Pa '
  + '— at your pad however high the site. Type the two together, or leave both blank.';

export const SITE_TEMPERATURE_HELP =
  'Air temperature at the pad. Leave this and Station pressure BOTH blank and the app computes '
  + 'the pad\'s temperature from your site altitude — the ISA standard, 15 °C at sea level '
  + 'falling 6.5 °C per km. Leave only this blank while a pressure is typed and it does not: the '
  + 'flight then uses 15 °C at your pad however high the site, so the air comes out too thin and '
  + 'the speed of sound too high. Type the two together, or leave both blank: if you type a '
  + 'temperature, type the pad\'s station pressure with it.';

/**
 * Live caution when the pad's air is wrong for the site — the panel half of the
 * 2026-09-08 pad-pressure finding, and the place a user actually fixes what the
 * RASAero import note told them about.
 *
 * It fires on exactly the three cases `padPressureIssue` names, and it quotes
 * the number the site itself implies, because "type your station pressure" is
 * not actionable without one. Silent below 600 m and silent when both fields
 * are blank — that input is correct, and a caution that cries on correct input
 * is one users learn to skip past.
 *
 * The third branch — a pressure typed with the temperature left blank — was
 * added from review (2026-09-08). It is the mirror of the first, and the app
 * itself steers people into it: the Station pressure help asks for a pressure,
 * and typing one on its own pins 288.15 K at the pad. Nothing caught it, because
 * the pressure in that case is entirely plausible.
 */
export function PadPressureCaution({ value }: { value: LaunchConditions }) {
  const { prefs } = usePrefs();
  const issue = padPressureIssue(value);
  if (!issue) return null;
  const sym = prefs.units.pressure;
  const altSym = prefs.units.distance;
  const tSym = prefs.units.temperature;
  const site = fmtSi('distance', altSym, value.launchAltitudeM);
  const standing = `${fmtSi('pressure', sym, isaPressurePa(value.launchAltitudeM))} ${sym}`;
  const seaLevel = `${fmtSi('pressure', sym, ISA_SEA_LEVEL.pressurePa)} ${sym}`;
  const standingT = `${fmtSi('temperature', tSym, isaTemperatureK(value.launchAltitudeM))} ${tSym}`;
  const seaLevelT = `${fmtSi('temperature', tSym, ISA_SEA_LEVEL.temperatureK)} ${tSym}`;
  return (
    <p className="field-caution" role="status" data-caution="pad-pressure">
      <Icon name="zap" size={13} />{' '}
      {issue === 'blank'
        ? <><strong>Station pressure is blank and a temperature is typed.</strong> The flight then
            uses sea-level pressure — <strong>{seaLevel}</strong> — at a pad {site} {altSym} up,
            where a barometer reads about {standing}. The air comes out too dense and the motor
            loses the thrust thin air owes it.{' '}
            Type the pad&rsquo;s station pressure, or clear the temperature too and the app
            computes it from your site altitude.</>
        : issue === 'blank-temperature'
          ? <><strong>Temperature is blank and a station pressure is typed.</strong> The flight then
              uses the sea-level standard — <strong>{seaLevelT}</strong> — at a pad {site} {altSym} up,
              where a standard day is about {standingT}. The air comes out too thin and the speed of
              sound too high, which shifts every Mach number the drag is read at.{' '}
              Type the pad&rsquo;s temperature, or clear the pressure too and the app computes both
              from your site altitude.</>
          : <><strong>{fmtSi('pressure', sym, value.pressureHPa! * 100)} {sym} is about sea-level
              pressure</strong>, and this pad is {site} {altSym} up, where a barometer reads about{' '}
              {standing}. That looks like an altimeter setting rather than what the pad reads.{' '}
              Type the pad&rsquo;s station pressure.</>}
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
      min?: number, max?: number, nullable = false, help?: string) => (
    <LaunchField label={label} field={key} value={value} onChange={onChange}
      stepStored={stepStored} min={min} max={max} nullable={nullable} help={help} />
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
        {numField('Temperature', 'temperatureC', 1, -60, 60, true, SITE_TEMPERATURE_HELP)}
        {/* "Station pressure", not "Pressure" (2026-09-08). The bare label let
            every reader supply their own meaning, and the common one — the
            altimeter setting an airport broadcasts, or the sea-level figure a
            weather app shows — is the wrong number by 15 % at 3,900 ft. Two
            words, sentence case, the same shape as "Site altitude" beside it. */}
        {numField('Station pressure', 'pressureHPa', 5, 300, 1100, true, STATION_PRESSURE_HELP)}
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
