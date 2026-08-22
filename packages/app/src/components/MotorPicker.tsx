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
    type: 'SU',
    propellant: 'black powder',
  };
}

export function MotorPicker({ mountDiameterMm, maxMotorLengthM, selectedLabel, onSelect }: {
  mountDiameterMm: number;
  /** Rocket-level max motor length (SI m); null = no limit. */
  maxMotorLengthM: number | null;
  selectedLabel: string;
  onSelect: (label: string, spec: MotorSpec, meta: MotorMeta) => void;
}) {
  const [browsing, setBrowsing] = useState(false);

  return (
    <div>
      <div className="field">
        <label>Quick picks (built-in, offline)</label>
        <select
          aria-label="Quick picks (built-in, offline)"
          value={BUILT_IN_MOTORS[selectedLabel] ? selectedLabel : ''}
          onChange={(e) => {
            const m = BUILT_IN_MOTORS[e.target.value];
            if (m) onSelect(e.target.value, m, builtInMeta(e.target.value));
          }}
        >
          {!BUILT_IN_MOTORS[selectedLabel] && (
            <option value="">
              {selectedLabel ? `${selectedLabel} (from database)` : '— no motor —'}
            </option>
          )}
          {Object.keys(BUILT_IN_MOTORS).map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
      </div>
      <button
        className="file-btn"
        style={{ marginTop: 8, width: '100%' }}
        title="Full thrustcurve.org database, plus import of your own EX/research motors from RASP (.eng) or RockSim (.rse) files — single files or a whole folder"
        onClick={() => setBrowsing(true)}
      >
        🔎 Browse motors / import EX (.eng, .rse)…
      </button>
      {browsing && (
        <MotorBrowser
          mountDiameterMm={mountDiameterMm}
          maxMotorLengthM={maxMotorLengthM}
          onSelect={onSelect}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
