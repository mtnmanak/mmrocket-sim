import { useId } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtFieldValue, fmtSi, niceStep, siToUi, uiToSi } from '../prefs/units.js';
import type { MotorRoom, NoBore } from '../tree/motorRoom.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';

/**
 * Why no motor fits a mount with no bore — ONE sentence, said both on Design
 * (under the Estimate) and on the mount's motor card (CFG-3 review, finding
 * 2: when the Estimate moved to Design the card lost it, and a user facing an
 * empty motor browser was left with "no limit").
 */
export function noBoreText(noBore: NoBore): string {
  return noBore === 'solid'
    ? 'No motor fits this mount: it is ticked Solid (filled), so it has no bore. Untick Solid (filled) on it to make it a tube.'
    : 'No motor fits this mount: its wall is as thick as its radius, so it has no bore.';
}

/**
 * The Design property panel's Max motor length field: edited ONLY there, on the
 * physical mount, with its ⌾ Estimate (CFG-SPEC A4). The motor card shows it
 * read-only through `MotorLengthReadout`.
 */
export function MotorLengthField({ mountName, value, onCommit, room, noBore, inputId }: {
  mountName: string;
  /** A stable id for the input, so another tab can focus it. */
  inputId?: string;
  value: number | null;
  onCommit: (value: number | undefined) => void;
  /** Null when the mount has no positive estimate; omitted, no Estimate is offered. */
  room?: MotorRoom | null;
  /**
   * Why the mount has no bore, when it has none (`noBoreReason`) — the cause
   * of a null `room` the hint then names, in place of the length, position
   * and overhang it otherwise suspects.
   */
  noBore?: NoBore | null;
}) {
  const generated = useId();
  const id = inputId ?? generated;
  const { prefs } = usePrefs();
  const unit = prefs.units.motorDimensions;
  return <div className="field" style={{ marginBottom: 8 }}>
    <label htmlFor={id}>Max motor length <UnitChip quantity="motorDimensions" /></label>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <NumField id={id} ariaLabel={`Max motor length for ${mountName}`}
        value={value === null ? undefined : siToUi('motorDimensions', unit, value)}
        step={niceStep(siToUi('motorDimensions', unit, 0.005))}
        nullable min={0} placeholder="no limit" describedBy={`${id}-help`}
        onCommit={(v) => onCommit(v === null ? undefined : uiToSi('motorDimensions', unit, v))} />
      {room !== undefined && <button className="file-btn" disabled={!room}
        aria-label={`Estimate maximum motor length for ${mountName}`}
        title="An estimate from the modelled parts. Check the room: wadding, baffles and packed recovery gear may reduce it."
        onClick={() => { if (room) onCommit(room.lengthM); }}>⌾ Estimate</button>}
    </div>
    <p id={`${id}-help`} className="comp-stats" style={{ margin: '3px 0 0' }}>
      Blank = no limit. Longer motors are flagged in this mount’s browser and excluded from Batch candidates for this mount.
      {' '}They remain selectable unless “only motors that fit” is on.
    </p>
    {room !== undefined && <p className="comp-stats" style={{ margin: '3px 0 0' }}>
      {room ? <>Room for {fmtSi('motorDimensions', unit, room.lengthM)} {unit} to {room.limitedBy}.</>
        : noBore ? noBoreText(noBore)
          : 'No positive motor-room estimate is available for this mount. Check its length, position and overhang.'}
    </p>}
  </div>;
}

/**
 * A motor card's Max motor length, read-only (CFG-SPEC A4): the limit belongs
 * to the physical mount and is set on Design, where its Estimate is.
 */
export function MotorLengthReadout({ mountName, value, onOpenDesign, noBore }: {
  mountName: string;
  value: number | null;
  onOpenDesign: () => void;
  /** Why the mount has no bore, when it has none (`noBoreReason`). */
  noBore?: NoBore | null;
}) {
  const { prefs } = usePrefs();
  const unit = prefs.units.motorDimensions;
  return <p className="comp-stats motor-length-readout" style={{ margin: '0 0 8px' }}>
    Max motor length: {value === null ? 'no limit' : `${fmtFieldValue(siToUi('motorDimensions', unit, value), prefs.fieldPrecision)} ${unit}`}
    {/* The accessible name CONTAINS the visible words (WCAG 2.5.3, label in
        name), so a speech-input user can say what they see. */}
    {' — '}<button type="button" className="file-btn" aria-label={`Max motor length for ${mountName}: set on Design`}
      onClick={onOpenDesign}>set on Design ▸</button>
    {noBore && <><br />{noBoreText(noBore)}</>}
  </p>;
}
