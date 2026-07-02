import type { RocketSpec } from '@online-openrocket/engine';
import { BUILT_IN_MOTORS } from '../motors.js';

/**
 * Rocket design form. UI units: millimeters and degrees (the hobby's units);
 * conversion to the engine's SI meters/radians happens HERE, at the boundary
 * — never inside the engine (upstream bug #2475's lesson).
 */
export interface DesignFormState {
  spec: RocketSpec;
  motorKey: string;
  launchRodLengthM: number;
  launchRodAngleDeg: number;
  windAverage: number;
}

function NumField({ label, value, onChange, step = 1, min = 0 }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        step={step}
        min={min}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </div>
  );
}

const mm = (m: number) => m * 1000;
const toM = (millis: number) => millis / 1000;

export function DesignForm({ state, onChange, onLaunch, simulating }: {
  state: DesignFormState;
  onChange: (next: DesignFormState) => void;
  onLaunch: () => void;
  simulating: boolean;
}) {
  const { spec } = state;
  const set = (partial: Partial<RocketSpec>) => onChange({ ...state, spec: { ...spec, ...partial } });

  return (
    <div>
      <div className="panel">
        <h2>Nose cone</h2>
        <div className="field-grid">
          <NumField label="Length (mm)" value={mm(spec.noseCone.length)}
            onChange={(v) => set({ noseCone: { ...spec.noseCone, length: toM(v) } })} />
          <div className="field">
            <label>Shape</label>
            <select value={spec.noseCone.shape ?? 'ogive'}
              onChange={(e) => set({ noseCone: { ...spec.noseCone, shape: e.target.value as RocketSpec['noseCone']['shape'] } })}>
              <option value="ogive">Ogive</option>
              <option value="conical">Conical</option>
              <option value="ellipsoid">Ellipsoid</option>
              <option value="parabolic">Parabolic</option>
              <option value="haack">Haack</option>
            </select>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 10 }}>
        <h2>Body tube</h2>
        <div className="field-grid">
          <NumField label="Length (mm)" value={mm(spec.bodyTube.length)}
            onChange={(v) => set({ bodyTube: { ...spec.bodyTube, length: toM(v) } })} />
          <NumField label="Diameter (mm)" value={mm(spec.bodyTube.outerRadius * 2)} step={0.5}
            onChange={(v) => {
              const radius = toM(v) / 2;
              set({
                bodyTube: { ...spec.bodyTube, outerRadius: radius },
                noseCone: { ...spec.noseCone, aftRadius: radius },
              });
            }} />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 10 }}>
        <h2>Fins (trapezoidal)</h2>
        <div className="field-grid">
          <NumField label="Count" value={spec.fins.count} min={2}
            onChange={(v) => set({ fins: { ...spec.fins, count: Math.max(2, Math.round(v)) } })} />
          <NumField label="Height (mm)" value={mm(spec.fins.height)}
            onChange={(v) => set({ fins: { ...spec.fins, height: toM(v) } })} />
          <NumField label="Root chord (mm)" value={mm(spec.fins.rootChord)}
            onChange={(v) => set({ fins: { ...spec.fins, rootChord: toM(v) } })} />
          <NumField label="Tip chord (mm)" value={mm(spec.fins.tipChord)}
            onChange={(v) => set({ fins: { ...spec.fins, tipChord: toM(v) } })} />
          <NumField label="Sweep (mm)" value={mm(spec.fins.sweep)}
            onChange={(v) => set({ fins: { ...spec.fins, sweep: toM(v) } })} />
          <NumField label="Thickness (mm)" value={mm(spec.fins.thickness)} step={0.5}
            onChange={(v) => set({ fins: { ...spec.fins, thickness: toM(v) } })} />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 10 }}>
        <h2>Recovery & motor</h2>
        <div className="field-grid">
          <NumField label="Chute diameter (mm)" value={mm(spec.parachute?.diameter ?? 0.3)} step={10}
            onChange={(v) => set({ parachute: { ...(spec.parachute ?? {}), diameter: toM(v) } })} />
          <div className="field">
            <label>Motor</label>
            <select value={state.motorKey}
              onChange={(e) => onChange({ ...state, motorKey: e.target.value })}>
              {Object.keys(BUILT_IN_MOTORS).map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 10 }}>
        <h2>Launch conditions</h2>
        <div className="field-grid">
          <NumField label="Rod length (m)" value={state.launchRodLengthM} step={0.1}
            onChange={(v) => onChange({ ...state, launchRodLengthM: v })} />
          <NumField label="Rod angle (°)" value={state.launchRodAngleDeg} step={1} min={-30}
            onChange={(v) => onChange({ ...state, launchRodAngleDeg: Math.max(-30, Math.min(30, v)) })} />
          <NumField label="Wind avg (m/s)" value={state.windAverage} step={0.5}
            onChange={(v) => onChange({ ...state, windAverage: v })} />
        </div>
        <button className="launch-btn" onClick={onLaunch} disabled={simulating}>
          {simulating ? 'Simulating…' : '🚀 Launch'}
        </button>
      </div>
    </div>
  );
}
