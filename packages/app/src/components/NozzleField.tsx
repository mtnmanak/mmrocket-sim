import { useEffect, useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, siToUi, uiToSi } from '../prefs/units.js';
import { nozzleForMotorId, type NozzleEntry } from '../services/nozzleDb.js';
import { equivalentExitDiameterM } from '../services/nozzleFollow.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';

/**
 * A stage's nozzle exit diameter, on the Motors & Launch page, filled from the
 * manufacturer's own published data and showing where the number came from.
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
 * and then fill from a drawing they had to go and find.
 *
 * THE RULES, and the second changed on 2026-09-13:
 *
 *  1. Field EMPTY and the stage's motors have a published nozzle -> fill it,
 *     and say whose figure it is.
 *  2. THE MOTORS CHANGED -> the value follows them: replaced by the new
 *     motors' published figure, or cleared when they have none. Eric's ruling,
 *     2026-09-13: "the info is per motor, not per rocket ... if a user inputs a
 *     number into that field and then changes the motor, that field would have
 *     to change as well since the value they input was for the previous motor".
 *     THAT DECISION IS NOT MADE HERE — App owns it, because only App can tell a
 *     motor change from a file being opened. See `services/nozzleFollow.ts`.
 *  3. Field has a value that DISAGREES with the published figure and the motors
 *     have not changed under it -> do NOT overwrite. Show both numbers and
 *     offer a one-click accept. That is the file-import case, and it is where
 *     the database earns its keep: a tester's file gave the N1000W a 2.737 in
 *     exit where AeroTech's drawing says 1.750 — 2.4x the area.
 *  4. No published figure -> say nothing, unless the value was JUST cleared
 *     because the motor changed, which the user has to be told about because it
 *     is a number that disappeared from under them.
 *
 * Provenance is DERIVED, never stored: the entry is looked up fresh and
 * compared with the field. So it survives a `.ork` round-trip without a new
 * key, and it cannot go stale against a rebuilt database — which a stored
 * "filled from AeroTech" flag would, silently, the first time a drawing was
 * re-read.
 */
export function NozzleField({
  stageName, exitDiameterM, motors, motorLabel, clearedFor, onCommit,
}: {
  stageName: string;
  /** The stage's current value (m), or null when the field is empty. */
  exitDiameterM: number | null;
  /**
   * The motors mounted in this stage, with their cluster counts. The field is
   * the stage's SINGLE EQUIVALENT nozzle (exit areas summed, `schema.ts`), so
   * the count is load-bearing and not decoration: four 29 mm motors are twice
   * the equivalent diameter of one.
   */
  motors: readonly { motorId: string; count: number }[];
  /** What to call the motor in the provenance line. */
  motorLabel: string | null;
  /**
   * Set by App when it has just cleared this stage's value because the motors
   * changed and the new ones publish nothing. Names what the value belonged to,
   * so the user is told rather than left to notice.
   */
  clearedFor?: { previousLabel: string; previousM: number } | null;
  onCommit: (m: number | null) => void;
}) {
  const { prefs } = usePrefs();
  const sym = prefs.units.motorDimensions;
  const [entries, setEntries] = useState<(NozzleEntry | null)[] | null>(null);

  const key = motors.map((m) => `${m.motorId}x${m.count}`).join(',');
  useEffect(() => {
    let live = true;
    void (async () => {
      const found = await Promise.all(motors.map((m) => nozzleForMotorId(m.motorId)));
      if (live) setEntries(found);
    })();
    return () => { live = false; };
    // `motors` is a fresh array each render; `key` is its stable content.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key IS motors
  }, [key]);

  // The stage's equivalent nozzle: null when it has no motors, or when any
  // motor in it has no published figure (a partial sum is short by whatever it
  // could not see, and a number quietly too small is worse than a blank).
  const published = entries === null ? null : equivalentExitDiameterM(
    motors.map((m, i) => ({ count: m.count, exitDiameterM: entries[i]?.exitDiameterM ?? null })),
  );
  // The entry to CREDIT. With one motor it is that motor's; with a cluster of
  // identical motors it is still one published nozzle, so naming it is honest.
  // A mixed stage names the first — the numbers come from all of them and the
  // sentence says "for <this motor>", so it is only ever a pointer at a source.
  const entry = entries?.find((e): e is NozzleEntry => e !== null) ?? null;
  const clustered = motors.length > 1 || motors.some((m) => m.count > 1);

  // Rule 1: fill an empty field from the published figure. In an effect and not
  // in render, because it writes to the design.
  useEffect(() => {
    if (published !== null && exitDiameterM === null) onCommit(published);
    // onCommit is a per-render closure; re-running on its identity would fight
    // the write it just made.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fill once, on arrival
  }, [published, exitDiameterM]);

  const ui = (m: number) => `${fmtSi('motorDimensions', sym, m)} ${sym}`;
  // 0.05 mm: finer than any drawing states, coarse enough that a unit
  // round-trip through the display never reads as a disagreement.
  const differs = published !== null && exitDiameterM !== null
    && Math.abs(published - exitDiameterM) > 0.00005;
  const matches = published !== null && exitDiameterM !== null && !differs;
  const maker = entry?.manufacturer ?? 'The manufacturer';

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
          placeholder={published !== null ? fmtSi('motorDimensions', sym, published) : 'none (0 = off)'}
          onCommit={(v) => onCommit(v === null ? null : uiToSi('motorDimensions', sym, v))}
        />
      </div>
      {matches && entry && (
        <p className="comp-stats" style={{ margin: '3px 0 0' }} data-nozzle="published">
          {ui(published)} — {maker}&rsquo;s published figure
          {motorLabel ? ` for ${motorLabel}` : ''}
          {entry.nozzlePartNo ? `, nozzle ${entry.nozzlePartNo}` : ''}.
          {clustered && ` Exit areas summed over the ${motors.reduce((n, m) => n + m.count, 0)} motors in this stage.`}
          {entry.confidence !== 'high' && ' Read at lower confidence.'}
          {entry.drawings.length > 0 && ` Source: ${entry.drawings[0]}.`}
        </p>
      )}
      {differs && entry && (
        <p className="field-caution" style={{ margin: '3px 0 0' }} data-nozzle="disagrees">
          <strong>This design says {ui(exitDiameterM)}; {maker} publish {ui(published)}</strong>
          {motorLabel ? ` for ${motorLabel}` : ''}
          {entry.nozzlePartNo ? ` (nozzle ${entry.nozzlePartNo})` : ''}.
          {' '}The exit area drives both base drag and the thrust a motor gains as the air thins, so
          the difference moves apogee. Yours is kept — a value that came in with your own file is not
          overwritten. Change the motor and it will follow the new one.
          {' '}
          <button className="file-btn" style={{ marginLeft: 4 }}
            onClick={() => onCommit(published)}>
            Use {maker}&rsquo;s {ui(published)}
          </button>
        </p>
      )}
      {clearedFor && exitDiameterM === null && (
        <p className="field-caution" style={{ margin: '3px 0 0' }} data-nozzle="cleared">
          <strong>Cleared — the {ui(clearedFor.previousM)} here was for {clearedFor.previousLabel}.</strong>
          {' '}
          {motors.length === 0
            ? 'No motor is loaded in this stage, so there is no nozzle.'
            : `No published exit diameter for ${motorLabel ?? 'this motor'}. Type one if you have measured it — blank means the pressure-thrust term and the power-on base-drag reduction are both off for this stage.`}
        </p>
      )}
      {entry?.note && published !== null && (
        <p className="comp-stats" style={{ margin: '3px 0 0' }} data-nozzle="alternatives">
          {entry.note}
        </p>
      )}
    </div>
  );
}
