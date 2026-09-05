import { useState } from 'react';
import type { MotorSpec } from '@online-openrocket/engine';
import { MotorBrowser } from './MotorBrowser.js';
import type { MotorMeta } from '../services/simReport.js';
import { loadCatalogueMotor } from '../services/motorMatch.js';

/**
 * Motor selection: a short list of common motors for one-click loading, and
 * the full-database browser (filters + sortable table over the bundled
 * thrustcurve.org catalogue, plus .eng/.rse import).
 *
 * The quick picks are ORDINARY CATALOGUE MOTORS, resolved through the same
 * path as everything else — findDbMotor for the entry, fetchMotorSpec for the
 * curve, which the shipped bundle answers with no network. Until 2026-09-05 this
 * dropdown was labelled "Quick picks (built-in, offline)" and served three
 * thrust curves written by hand on the project's first day; those are gone, and
 * there is no second class of motor data left in the app.
 */

/** Manufacturer + designation + the delay each is normally flown with. */
const QUICK_PICKS: ReadonlyArray<{ mfr: string; des: string; delay: number }> = [
  { mfr: 'Estes', des: 'A8', delay: 3 },
  { mfr: 'Estes', des: 'B6', delay: 4 },
  { mfr: 'Estes', des: 'C6', delay: 5 },
  { mfr: 'Estes', des: 'D12', delay: 5 },
];

const pickLabel = (p: { mfr: string; des: string; delay: number }): string => `${p.mfr} ${p.des}-${p.delay}`;

export function MotorPicker({ mountDiameterMm, maxMotorLengthM, selectedLabel, onSelect, loadedMotors }: {
  mountDiameterMm: number;
  /** Rocket-level max motor length (SI m); null = no limit. */
  maxMotorLengthM: number | null;
  selectedLabel: string;
  onSelect: (label: string, spec: MotorSpec, meta: MotorMeta) => void;
  /** Every motor loaded in the design, so a catalogue check can name the ones it changed. */
  loadedMotors?: readonly { label: string; manufacturer?: string }[];
}) {
  const [browsing, setBrowsing] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const current = QUICK_PICKS.find((p) => pickLabel(p) === selectedLabel || `${p.des}-${p.delay}` === selectedLabel);

  const pick = async (p: { mfr: string; des: string; delay: number }): Promise<void> => {
    setProblem(null);
    setLoading(pickLabel(p));
    try {
      const m = await loadCatalogueMotor(p.mfr, p.des, p.delay);
      if (!m) throw new Error(`${pickLabel(p)} is not in the motor database.`);
      onSelect(m.label, m.spec, m.meta);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div>
      <div className="field">
        <label>Quick picks</label>
        <select
          aria-label="Quick picks"
          value={current ? pickLabel(current) : ''}
          disabled={loading !== null}
          onChange={(e) => {
            const p = QUICK_PICKS.find((q) => pickLabel(q) === e.target.value);
            if (p) void pick(p);
          }}
        >
          {!current && (
            <option value="">
              {selectedLabel ? `${selectedLabel} (from database)` : '— no motor —'}
            </option>
          )}
          {QUICK_PICKS.map((p) => (
            <option key={pickLabel(p)} value={pickLabel(p)}>
              {loading === pickLabel(p) ? `${pickLabel(p)} — loading…` : pickLabel(p)}
            </option>
          ))}
        </select>
        {problem && <p className="print-note print-note-warn" role="alert">{problem}</p>}
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
          loadedMotors={loadedMotors}
        />
      )}
    </div>
  );
}
