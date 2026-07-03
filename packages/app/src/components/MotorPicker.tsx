import { useState } from 'react';
import type { MotorSpec } from '@online-openrocket/engine';
import { BUILT_IN_MOTORS } from '../motors.js';
import { MotorBrowser } from './MotorBrowser.js';
import type { MotorMeta } from '../services/simReport.js';

/**
 * Motor selection: a compact current-motor readout with built-in quick picks
 * (instant, offline) and the full-database browser (filters + sortable table
 * over the bundled thrustcurve.org summary DB).
 */

/** Meta for the built-in quick picks (all Estes; delay is the key suffix). */
export function builtInMeta(label: string): MotorMeta {
  const delay = Number(label.split('-')[1]);
  return {
    label,
    manufacturer: 'Estes',
    availableDelays: Number.isFinite(delay) ? [delay] : undefined,
  };
}

export function MotorPicker({ mountDiameterMm, selectedLabel, onSelect }: {
  mountDiameterMm: number;
  selectedLabel: string;
  onSelect: (label: string, spec: MotorSpec, meta: MotorMeta) => void;
}) {
  const [browsing, setBrowsing] = useState(false);

  return (
    <div>
      <div className="field">
        <label>Quick picks (built-in, offline)</label>
        <select
          value={BUILT_IN_MOTORS[selectedLabel] ? selectedLabel : ''}
          onChange={(e) => {
            const m = BUILT_IN_MOTORS[e.target.value];
            if (m) onSelect(e.target.value, m, builtInMeta(e.target.value));
          }}
        >
          {!BUILT_IN_MOTORS[selectedLabel] && <option value="">{selectedLabel} (from database)</option>}
          {Object.keys(BUILT_IN_MOTORS).map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
      </div>
      <button
        className="file-btn"
        style={{ marginTop: 8, width: '100%' }}
        onClick={() => setBrowsing(true)}
      >
        🔎 Browse motor database…
      </button>
      {browsing && (
        <MotorBrowser
          mountDiameterMm={mountDiameterMm}
          onSelect={onSelect}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
