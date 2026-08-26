import { DEFAULT_TIME_STEP_S, type SimulationOptions } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { niceStep, siToUi, uiToSi, type Quantity } from '../prefs/units.js';
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
export function LaunchField({ label, field, value, onChange, stepStored, min, max, nullable = false }: {
  label: string;
  field: keyof LaunchConditions;
  value: LaunchConditions;
  onChange: (v: LaunchConditions) => void;
  stepStored: number;
  min?: number;
  max?: number;
  nullable?: boolean;
}) {
  const { prefs } = usePrefs();
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
    <div className="field">
      <label>{label}{spec ? <> <UnitChip quantity={spec.quantity} /></> : ''}</label>
      {/* The .field idiom puts the <label> beside the control, not around it, so
          nothing associates them — a screen reader read these eight launch
          inputs as anonymous "edit" boxes. ariaLabel here names every
          LaunchField call site at once, the Fly screen's included. */}
      <NumField
        ariaLabel={symbol ? `${label} (${symbol})` : label}
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
      min?: number, max?: number, nullable = false) => (
    <LaunchField label={label} field={key} value={value} onChange={onChange}
      stepStored={stepStored} min={min} max={max} nullable={nullable} />
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
        {numField('Temperature', 'temperatureC', 1, -60, 60, true)}
        {numField('Pressure', 'pressureHPa', 5, 300, 1100, true)}
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
      <TimeStepCaution dt={value.timeStepS} lastRun={lastRun} />
      <button className="launch-btn" onClick={onLaunch} disabled={simulating}>
        {simulating ? 'Simulating…' : <><Icon name="rocket" size={15} /> Launch</>}
      </button>
    </div>
  );
}
