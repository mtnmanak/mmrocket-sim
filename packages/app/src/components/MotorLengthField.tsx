import { useId } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, niceStep, siToUi, uiToSi } from '../prefs/units.js';
import type { MotorRoom } from '../tree/motorRoom.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';

/** One field contract for both mount cards and the Design property panel. */
export function MotorLengthField({ mountName, value, onCommit, room }: {
  mountName: string;
  value: number | null;
  onCommit: (value: number | undefined) => void;
  /** Omitted in Design; null on a card with no positive estimate. */
  room?: MotorRoom | null;
}) {
  const id = useId();
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
        : 'No positive motor-room estimate is available for this mount. Check its length, position and overhang.'}
    </p>}
  </div>;
}
