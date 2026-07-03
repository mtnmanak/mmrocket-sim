export interface LaunchConditions {
  launchRodLengthM: number;
  launchRodAngleDeg: number;
  windAverage: number;
}

export function LaunchPanel({ value, onChange, onLaunch, simulating }: {
  value: LaunchConditions;
  onChange: (v: LaunchConditions) => void;
  onLaunch: () => void;
  simulating: boolean;
}) {
  const field = (label: string, key: keyof LaunchConditions, step: number, min?: number, max?: number) => (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        step={step}
        value={value[key]}
        onChange={(e) => {
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
        {field('Rod length (m)', 'launchRodLengthM', 0.1, 0)}
        {field('Rod angle (°)', 'launchRodAngleDeg', 1, -30, 30)}
        {field('Wind avg (m/s)', 'windAverage', 0.5, 0)}
      </div>
      <button className="launch-btn" onClick={onLaunch} disabled={simulating}>
        {simulating ? 'Simulating…' : '🚀 Launch'}
      </button>
    </div>
  );
}
