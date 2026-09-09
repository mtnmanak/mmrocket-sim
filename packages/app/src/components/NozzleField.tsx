import { useEffect, useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, siToUi, uiToSi } from '../prefs/units.js';
import { nozzleForMotorId, type NozzleEntry } from '../services/nozzleDb.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';

/**
 * A stage's nozzle exit diameter, on the Motors & Launch page, filled from
 * AeroTech's own published drawings and showing where the number came from.
 *
 * WHY IT MOVED HERE (Eric, 2026-09-08b): "where is the field to input the nozzle
 * exit diameter? In v0.120, I can no longer find it. I thought we were going to
 * put it on the Motors and Launch page". It had not been removed — it is a
 * STAGE property and lived in the Property Panel, reachable only by selecting
 * the stage in the component tree. But the number belongs to the MOTOR, which is
 * why he went looking for it beside the motor, so it is now here as well.
 *
 * WHY IT FILLS ITSELF IN (his §6(a) ruling the same day): "it should be
 * automatic with provenance." The exit area is not decoration — since v0.119 it
 * buys thrust as the air thins — and it was a field the user had to know about
 * and then fill from a drawing they had to go and find. 189 of AeroTech's 272
 * in-production motors now have a published figure in the app.
 *
 * THREE RULES, and the second is the one that matters:
 *
 *  1. Field EMPTY and the motor has a published nozzle -> fill it, and say
 *     where it came from.
 *  2. Field ALREADY HAS a value that disagrees -> do NOT overwrite it. Show
 *     both numbers and offer a one-click accept. A RASAero file's own nozzle is
 *     the user's data; silently replacing it would be the same class of
 *     surprise the whole provenance requirement exists to prevent. (It is also
 *     where the database earns its keep: a tester's file gave the N1000W a
 *     2.737 in exit where AeroTech's drawing says 1.750 — 2.4x the area.)
 *  3. No published figure -> say nothing. Loki and Cesaroni publish none, and a
 *     line reporting an absence on every non-AeroTech motor is one users learn
 *     to skip.
 *
 * Provenance is DERIVED, never stored: the entry is looked up fresh and
 * compared with the field. So it survives a `.ork` round-trip without a new
 * key, and it cannot go stale against a rebuilt database — which a stored
 * "filled from AeroTech" flag would, silently, the first time a drawing was
 * re-read.
 */
export function NozzleField({ stageName, exitDiameterM, motorIds, motorLabel, onCommit }: {
  stageName: string;
  /** The stage's current value (m), or null when the field is empty. */
  exitDiameterM: number | null;
  /**
   * Catalogue ids of the motors mounted in this stage. Usually one; a cluster
   * of identical motors is still one nozzle, and a mixed cluster is looked up
   * on the first that has a published figure.
   */
  motorIds: readonly string[];
  /** What to call the motor in the provenance line. */
  motorLabel: string | null;
  onCommit: (m: number | null) => void;
}) {
  const { prefs } = usePrefs();
  const sym = prefs.units.motorDimensions;
  const [entry, setEntry] = useState<NozzleEntry | null>(null);

  const key = motorIds.join(',');
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const id of motorIds) {
        const e = await nozzleForMotorId(id);
        if (!live) return;
        if (e) { setEntry(e); return; }
      }
      if (live) setEntry(null);
    })();
    return () => { live = false; };
    // `motorIds` is a fresh array each render; `key` is its stable content.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key IS motorIds
  }, [key]);

  // Rule 1: fill an empty field from the published figure. In an effect and not
  // in render, because it writes to the design.
  useEffect(() => {
    if (entry && exitDiameterM === null) onCommit(entry.exitDiameterM);
    // onCommit is a per-render closure; re-running on its identity would fight
    // the write it just made.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fill once, on arrival
  }, [entry, exitDiameterM]);

  const ui = (m: number) => `${fmtSi('motorDimensions', sym, m)} ${sym}`;
  // 0.05 mm: finer than any drawing states, coarse enough that a unit
  // round-trip through the display never reads as a disagreement.
  const differs = entry !== null && exitDiameterM !== null
    && Math.abs(entry.exitDiameterM - exitDiameterM) > 0.00005;
  const matches = entry !== null && exitDiameterM !== null && !differs;

  return (
    <div style={{ marginTop: 8 }}>
      <div className="field">
        <label>
          Nozzle exit diameter <UnitChip quantity="motorDimensions" />
        </label>
        <NumField
          ariaLabel={`Nozzle exit diameter for ${stageName} (${sym})`}
          value={exitDiameterM === null ? undefined : siToUi('motorDimensions', sym, exitDiameterM)}
          step={0.5}
          min={0}
          nullable
          placeholder={entry ? fmtSi('motorDimensions', sym, entry.exitDiameterM) : 'none (0 = off)'}
          onCommit={(v) => onCommit(v === null ? null : uiToSi('motorDimensions', sym, v))}
        />
      </div>
      {matches && (
        <p className="comp-stats" style={{ margin: '3px 0 0' }} data-nozzle="published">
          {ui(entry.exitDiameterM)} — AeroTech&rsquo;s published figure
          {motorLabel ? ` for ${motorLabel}` : ''}
          {entry.nozzlePartNo ? `, nozzle ${entry.nozzlePartNo}` : ''}.
          {entry.confidence !== 'high' && ' Read at lower confidence.'}
          {entry.drawings.length > 0 && ` Source: ${entry.drawings[0]}.`}
        </p>
      )}
      {differs && (
        <p className="field-caution" style={{ margin: '3px 0 0' }} data-nozzle="disagrees">
          <strong>This design says {ui(exitDiameterM)}; AeroTech publish {ui(entry.exitDiameterM)}</strong>
          {motorLabel ? ` for ${motorLabel}` : ''}
          {entry.nozzlePartNo ? ` (nozzle ${entry.nozzlePartNo})` : ''}.
          {' '}The exit area drives both base drag and the thrust a motor gains as the air thins, so
          the difference moves apogee. Yours is kept — a value from your own file is not overwritten.
          {' '}
          <button className="file-btn" style={{ marginLeft: 4 }}
            onClick={() => onCommit(entry.exitDiameterM)}>
            Use AeroTech&rsquo;s {ui(entry.exitDiameterM)}
          </button>
        </p>
      )}
      {entry?.note && (
        <p className="comp-stats" style={{ margin: '3px 0 0' }} data-nozzle="alternatives">
          {entry.note}
        </p>
      )}
    </div>
  );
}
