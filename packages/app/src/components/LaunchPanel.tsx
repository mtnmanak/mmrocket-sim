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

export function LaunchPanel({ value, onChange, onLaunch, simulating }: {
  value: LaunchConditions;
  onChange: (v: LaunchConditions) => void;
  onLaunch: () => void;
  simulating: boolean;
}) {
  const numField = (label: string, key: keyof LaunchConditions, step: number,
      min?: number, max?: number, nullable = false) => (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        step={step}
        placeholder={nullable ? 'standard' : undefined}
        value={value[key] === null ? '' : (value[key] as number)}
        onChange={(e) => {
          if (nullable && e.target.value === '') {
            onChange({ ...value, [key]: null });
            return;
          }
          let v = Number(e.target.value);
          if (!Number.isFinite(v)) return;
          if (min !== undefined) v = Math.max(min, v);
          if (max !== undefined) v = Math.min(max, v);
          onChange({ ...value, [key]: v });
        }}
      />
    </div>
  );

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <h2>Launch conditions</h2>
      <div className="field-grid">
        {numField('Rod length (m)', 'launchRodLengthM', 0.1, 0)}
        {numField('Rod angle (°)', 'launchRodAngleDeg', 1, -30, 30)}
        {numField('Wind avg (m/s)', 'windAverage', 0.5, 0)}
        {numField('Wind gusts σ (m/s)', 'windStdDev', 0.1, 0)}
        {numField('Site altitude (m)', 'launchAltitudeM', 50, 0, 10000)}
        {numField('Latitude (°)', 'latitudeDeg', 1, -90, 90)}
        {numField('Temperature (°C)', 'temperatureC', 1, -60, 60, true)}
        {numField('Pressure (hPa)', 'pressureHPa', 5, 300, 1100, true)}
      </div>
      <button className="launch-btn" onClick={onLaunch} disabled={simulating}>
        {simulating ? 'Simulating…' : '🚀 Launch'}
      </button>
    </div>
  );
}
