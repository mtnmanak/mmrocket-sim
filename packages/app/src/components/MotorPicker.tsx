import { useMemo, useState } from 'react';
import type { MotorSpec } from '@online-openrocket/engine';
import { MotorBrowser } from './MotorBrowser.js';
import { useCatalogue } from './useCatalogue.js';
import type { MotorMeta } from '../services/simReport.js';
import { loadCatalogueMotor } from '../services/motorMatch.js';
import { findDbMotor, fitsMount } from '../services/motorDb.js';

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
 *
 * WHEN THE PICKS ARE OFFERED AT ALL (Eric, 2026-09-21, issues-2026-09-18a item
 * 15). They are the QUICK START's four motors, so they are advice only while
 * the design is still the rocket the Quick Start handed you. The moment it is
 * not — a different airframe, a different name — the list goes and the field
 * becomes a plain readout of the motor on this mount; every motor then comes
 * from the browser, which filters. An A8 offered beside a 50 lb rocket read as
 * a suggestion, and on a safety-adjacent number the app should not be making
 * suggestions it cannot stand behind.
 *
 * AND THEY ARE FILTERED TO THE MOUNT. The D12 is 24 mm; the starter rocket's
 * mount is 18 mm, so one of the four had never fitted the rocket it was offered
 * for. The browser has always refused it there (`classesFittingMount`); this
 * list did not, and `assignMotor` applies no diameter check of its own.
 */

/** Manufacturer + designation + the delay each is normally flown with. */
const QUICK_PICKS: ReadonlyArray<{ mfr: string; des: string; delay: number }> = [
  { mfr: 'Estes', des: 'A8', delay: 3 },
  { mfr: 'Estes', des: 'B6', delay: 4 },
  { mfr: 'Estes', des: 'C6', delay: 5 },
  { mfr: 'Estes', des: 'D12', delay: 5 },
];

const pickLabel = (p: { mfr: string; des: string; delay: number }): string => `${p.mfr} ${p.des}-${p.delay}`;

export function MotorPicker({ mountDiameterMm, maxMotorLengthM, selectedLabel, onSelect, loadedMotors, showQuickPicks }: {
  mountDiameterMm: number;
  /** Rocket-level max motor length (SI m); null = no limit. */
  maxMotorLengthM: number | null;
  selectedLabel: string;
  onSelect: (label: string, spec: MotorSpec, meta: MotorMeta) => void;
  /** Every motor loaded in the design, so a catalogue check can name the ones it changed. */
  loadedMotors?: readonly { label: string; manufacturer?: string }[];
  /** Offer the Quick Picks at all — false once the design is no longer the
   *  untouched starter rocket (App: `isPristineDefault`). */
  showQuickPicks: boolean;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The live catalogue, so a "check thrustcurve.org" overlay reaches the picks
  // the same way it reaches the browser.
  const catalogue = useCatalogue();
  /**
   * The picks that FIT this mount, resolved through the SAME lookup `pick`
   * will use (`loadCatalogueMotor` -> `findDbMotor`) — so the diameter filtered
   * on is the diameter of the motor that actually loads, not a second
   * hard-coded copy of it that a catalogue refresh could falsify.
   */
  const picks = useMemo(() => QUICK_PICKS.filter((p) => {
    const db = findDbMotor(p.des, undefined, catalogue, p.mfr);
    return db !== null && fitsMount(mountDiameterMm, db, catalogue);
  }), [catalogue, mountDiameterMm]);
  const offerPicks = showQuickPicks && picks.length > 0;

  const current = picks.find((p) => pickLabel(p) === selectedLabel || `${p.des}-${p.delay}` === selectedLabel);

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
        <label>{offerPicks ? 'Quick picks' : 'Motor'}</label>
        {offerPicks ? (
          <select
            aria-label="Quick picks"
            value={current ? pickLabel(current) : ''}
            disabled={loading !== null}
            onChange={(e) => {
              const p = picks.find((q) => pickLabel(q) === e.target.value);
              if (p) void pick(p);
            }}
          >
            {!current && (
              <option value="">
                {selectedLabel ? `${selectedLabel} (from database)` : '— no motor —'}
              </option>
            )}
            {picks.map((p) => (
              <option key={pickLabel(p)} value={pickLabel(p)}>
                {loading === pickLabel(p) ? `${pickLabel(p)} — loading…` : pickLabel(p)}
              </option>
            ))}
          </select>
        ) : (
          // NOT simply dropping the field: that dropdown's placeholder option
          // is the only place this mount card names the motor it is flying, so
          // hiding the block would strip the motor's name off every card.
          <p className="motor-db-meta" style={{ margin: 0 }}>{selectedLabel || '— no motor —'}</p>
        )}
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
