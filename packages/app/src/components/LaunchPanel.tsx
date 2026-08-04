import { usePrefs } from '../prefs/PrefsContext.js';
import { niceStep, siToUi, uiToSi, type Quantity } from '../prefs/units.js';
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

export function LaunchPanel({ value, onChange, onLaunch, simulating }: {
  value: LaunchConditions;
  onChange: (v: LaunchConditions) => void;
  onLaunch: () => void;
  simulating: boolean;
}) {
  const { prefs } = usePrefs();

  const numField = (label: string, key: keyof LaunchConditions, stepStored: number,
      min?: number, max?: number, nullable = false) => {
    const spec = FIELD_SPEC[key];
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
        <NumField
          value={value[key] === null ? undefined : toUi(value[key] as number)}
          step={step}
          min={uiMin}
          max={uiMax}
          allowNegative={uiMin === undefined || uiMin < 0}
          nullable={nullable}
          placeholder={nullable ? 'standard' : undefined}
          onCommit={(ui) => {
            if (ui === null) {
              if (nullable) onChange({ ...value, [key]: null });
              return;
            }
            onChange({ ...value, [key]: fromUi(ui) });
          }}
        />
      </div>
    );
  };

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
      </div>
      <button className="launch-btn" onClick={onLaunch} disabled={simulating}>
        {simulating ? 'Simulating…' : '🚀 Launch'}
      </button>
    </div>
  );
}
