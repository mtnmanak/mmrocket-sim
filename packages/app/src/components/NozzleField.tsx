import { useEffect, useId, useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, niceStep, siToUi, uiToSi } from '../prefs/units.js';
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
  stageName, exitDiameterM, motors, motorLabel, clearedFor, onCommit, parallel = false,
}: {
  stageName: string;
  parallel?: boolean;
  /** The stage's current value (m), or null when the field is empty. */
  exitDiameterM: number | null;
  /**
   * The motors mounted in this stage, with their cluster counts. The field is
   * the stage's SINGLE EQUIVALENT nozzle (exit areas summed, `schema.ts`), so
   * the count is load-bearing and not decoration: four 29 mm motors are twice
   * the equivalent diameter of one.
   */
  motors: readonly { motorId: string; count: number; label?: string }[];
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
  const inputId = useId();
  /** `entries: null` — the look-up FAILED for this loadout (below). */
  const [lookup, setLookup] = useState<{ key: string; entries: (NozzleEntry | null)[] | null } | null>(null);

  const key = motors.map((m) => `${m.motorId}x${m.count}`).join(',');
  useEffect(() => {
    let live = true;
    void (async () => {
      // THE DATA CAN FAIL TO ARRIVE (audit 2026-09-30). nozzles.json is a lazy
      // chunk of its own: offline before the service worker had cached it, or
      // in a tab older than the deploy that replaced it, the import rejects.
      // With no catch here that rejection went nowhere — main.tsx's handler
      // paints only into an EMPTY root — and the field waited for an answer
      // that never came: no fill, no disagreement, no provenance, no word why.
      let found: (NozzleEntry | null)[] | null;
      try {
        found = await Promise.all(motors.map((m) => nozzleForMotorId(m.motorId)));
      } catch (err) {
        console.error('The nozzle data could not be loaded:', err);
        found = null;
      }
      if (live) setLookup({ key, entries: found });
    })();
    return () => { live = false; };
    // `motors` is a fresh array each render; `key` is its stable content.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key IS motors
  }, [key]);

  const settled = lookup?.key === key ? lookup : null;
  const entries = settled?.entries ?? null;
  const unavailable = settled !== null && settled.entries === null;

  // The stage's equivalent nozzle: null when it has no motors, or when any
  // motor in it has no published figure (a partial sum is short by whatever it
  // could not see, and a number quietly too small is worse than a blank).
  const published = entries === null ? null : equivalentExitDiameterM(
    motors.map((m, i) => ({ count: m.count, exitDiameterM: entries[i]?.exitDiameterM ?? null })),
  );
  // Single-source attribution; mixed loadouts list every contributing source.
  const entry = entries?.find((e): e is NozzleEntry => e !== null) ?? null;
  const clustered = motors.length > 1 || motors.some((m) => m.count > 1);
  const mixed = new Set(motors.map((m) => m.motorId)).size > 1;

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
  const differs = published !== null && exitDiameterM !== null && exitDiameterM > 0
    && Math.abs(published - exitDiameterM) > 0.00005;
  const matches = published !== null && exitDiameterM !== null && exitDiameterM > 0 && !differs;
  const maker = entry?.manufacturer ?? 'The manufacturer';
  // An EX motor's exit comes out of the .rse the USER imported, not out of a
  // manufacturer's drawing, and the panel must not dress one as the other:
  // "Klima's published figure" for a number somebody typed into their own
  // motor file is exactly the unfollowable provenance this line exists to
  // prevent (2026-09-21).
  const fromFile = entry?.fromImportedFile === true;

  return (
    <div style={{ marginTop: 8 }}>
      <div className="field">
        {/* htmlFor, or the label's control is the unit chip's <select> — its
            first labelable descendant — and clicking the words focused that
            instead of the box (audit 2026-09-22). */}
        <label htmlFor={inputId}>
          Nozzle exit diameter <UnitChip quantity="motorDimensions" />
        </label>
        <NumField
          id={inputId}
          describedBy={`${inputId}-help`}
          ariaLabel={`Nozzle exit diameter for ${stageName} (${sym})`}
          value={exitDiameterM === null ? undefined : siToUi('motorDimensions', sym, exitDiameterM)}
          // Half a millimetre's worth in the display unit. A fixed 0.5 was half
          // an INCH in inches — 12.7 mm a click on a 4.8 mm exit (audit 2026-09-22).
          step={niceStep(siToUi('motorDimensions', sym, 0.0005))}
          min={0}
          nullable
          placeholder={published !== null ? fmtSi('motorDimensions', sym, published) : 'automatic (0 = off)'}
          onCommit={(v) => onCommit(v === null ? null : uiToSi('motorDimensions', sym, v))}
        />
      </div>
      <p className="comp-stats" id={`${inputId}-help`} style={{ margin: '3px 0 0' }}>
        {parallel && 'For ONE strap-on. If it carries several motors, enter the diameter of one nozzle with their combined exit area. The app accounts for the number of strap-ons. '}
        Blank means automatic. Enter 0 to switch off; 0 stays off when motors change.
        {' '}This value controls pressure thrust and power-on base drag under Rogers Kbf, Auto and Supersonic.
      </p>
      {exitDiameterM === 0 && <p className="comp-stats" data-nozzle="off">Nozzle effects are off.</p>}
      {mixed && published !== null && entries && (
        <ul className="comp-stats" data-nozzle="sources">
          {entries.map((source, i) => source && <li key={i}>
            {motors[i]?.label ?? `Motor ${i + 1}`}: {motors[i]?.count} × {ui(source.exitDiameterM)} — {source.fromImportedFile ? 'imported motor file' : source.manufacturer}
            {source.nozzlePartNo ? `, nozzle ${source.nozzlePartNo}` : ''}
            {source.drawings.length > 0 ? `. Source: ${source.drawings[0]}` : ''}.
            {source.confidence !== 'high' && ' Read at lower confidence.'}
            {source.note && ` ${source.note}`}
            {source.customExitNote && ` ${source.customExitNote}`}
          </li>)}
        </ul>
      )}
      {matches && entry && (
        <p className="comp-stats" style={{ margin: '3px 0 0' }} data-nozzle="published">
          {ui(published)} — {clustered ? `equivalent exit from ${mixed ? 'the motor sources' : fromFile ? 'the imported motor file' : `${maker} data`}` : fromFile
            ? `from the motor file you imported${motorLabel ? ` for ${motorLabel}` : ''}`
            : `${maker}\u2019s published figure${motorLabel ? ` for ${motorLabel}` : ''}`}
          {!mixed && entry.nozzlePartNo ? `, nozzle ${entry.nozzlePartNo}` : ''}.
          {clustered && !mixed && ` One motor's exit: ${ui(entry.exitDiameterM)}.`}
          {clustered && ` Exit areas summed over the ${motors.reduce((n, m) => n + m.count, 0)} motors ${parallel ? 'in one strap-on' : 'in this stage'}.`}
          {!mixed && entry.confidence !== 'high' && ' Read at lower confidence.'}
          {!mixed && entry.drawings.length > 0 && ` Source: ${entry.drawings[0]}.`}
        </p>
      )}
      {differs && entry && (
        <p className="field-caution" style={{ margin: '3px 0 0' }} data-nozzle="disagrees">
          <strong>This design says {ui(exitDiameterM)}; {clustered ? `the equivalent from the motor sources is ${ui(published)}` : fromFile
            ? `the motor file you imported says ${ui(published)}`
            : `${maker} publish ${ui(published)}`}</strong>
          {!mixed && motorLabel ? ` for ${motorLabel}` : ''}
          {!mixed && entry.nozzlePartNo ? ` (nozzle ${entry.nozzlePartNo})` : ''}.
          {' '}The exit area drives both base drag and the thrust a motor gains as the air thins, so
          the difference moves apogee. Yours is kept — a value that came in with your own file is not
          overwritten. Change the motor and it will follow the new one.
          {' '}
          {/* Credited the way the sentence above credits it: the button used to
              say "Use Klima's" for a figure from the user's own .rse while the
              sentence said the file (audit 2026-09-22). */}
          <button className="file-btn" style={{ marginLeft: 4 }}
            onClick={() => onCommit(published)}>
            Use {clustered ? 'equivalent' : `${fromFile ? 'the file' : maker}’s`} {ui(published)}
          </button>
        </p>
      )}
      {clearedFor && exitDiameterM === null && (
        <p className="field-caution" style={{ margin: '3px 0 0' }} data-nozzle="cleared">
          <strong>Cleared — the {ui(clearedFor.previousM)} here was for {clearedFor.previousLabel}.</strong>
          {' '}
          {motors.length === 0
            ? 'No motor is loaded in this stage, so there is no nozzle.'
            // "No published exit diameter" would be false when the figure could
            // not be LOOKED UP — the note below says that, and what blank does.
            : unavailable ? null
            : `No published exit diameter for ${motorLabel ?? 'this motor'}. Type one if you have measured it — blank means the pressure-thrust term and the power-on base-drag reduction are both off for this stage.`}
        </p>
      )}
      {/* Not on a stage switched OFF: nothing is filled or checked there anyway.
          The reload is the cure, as for the lazy dialogs (LazyDialog.tsx): it
          fetches the current build's chunk, or the service worker's copy. */}
      {unavailable && exitDiameterM !== 0 && (
        <p className="field-caution" style={{ margin: '3px 0 0' }} data-nozzle="unavailable">
          <strong>The nozzle data could not be loaded</strong>, so this field cannot fill itself in
          from the published figure or check a typed value against it.
          {exitDiameterM === null && ' Blank means the pressure-thrust term and the power-on base-drag reduction are both off for this stage.'}
          {' '}The connection may have dropped, or the app may have been updated since this page loaded.
          {' '}
          <button className="file-btn" style={{ marginLeft: 4 }} onClick={() => window.location.reload()}>
            ↻ Reload the page
          </button>
        </p>
      )}
      {!mixed && entry?.note && published !== null && (
        <p className="comp-stats" style={{ margin: '3px 0 0' }} data-nozzle="alternatives">
          {entry.note}
        </p>
      )}
      {/* The manufacturer's own caution about this figure — Loki's 76 mm
          custom exits today. Eric's ruling (b), 2026-09-13: show it under the
          field and nowhere else, because "since these are custom built nozzles,
          the user will definitely know they are using a non-standard exit
          diameter and will know to update that field. The average user may not
          even know what the exit diameter is or why it should be changed."
          Shown whenever the stage HAS a published figure, filled or not, since
          the point is that the figure may not describe the part in the case. */}
      {!mixed && entry?.customExitNote && published !== null && (
        <p className="comp-stats" style={{ margin: '3px 0 0' }} data-nozzle="custom-exit">
          {entry.customExitNote}
        </p>
      )}
    </div>
  );
}
