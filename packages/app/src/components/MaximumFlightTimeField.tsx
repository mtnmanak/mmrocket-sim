import { useId, useRef, useState } from 'react';
import { noticeEqual, noticeNumber } from '../prefs/units.js';
import { flownMaxFlightTimeS, MAX_FLIGHT_TIME_S_RANGE, type LaunchConditions } from '../services/launchConditions.js';
import { NumField } from './NumField.js';

export function MaximumFlightTimeField({ value, onChange }: {
  value: LaunchConditions; onChange: (v: LaunchConditions) => void;
}) {
  const id = useId();
  const [clamp, setClamp] = useState<{ from: number; to: number; launch: LaunchConditions } | null>(null);
  const committed = useRef(value);
  const limit = flownMaxFlightTimeS(value);
  return <div className="field">
    <label htmlFor={id}>Maximum flight time (s)</label>
    <NumField id={id} value={limit} step={60} min={MAX_FLIGHT_TIME_S_RANGE[0]} max={MAX_FLIGHT_TIME_S_RANGE[1]}
      clampToBounds describedBy={`${id}-help ${id}-status`}
      onCommit={v => {
        if (v === null) return;
        setClamp(null);
        committed.current = { ...value, maxFlightTimeS: v };
        onChange(committed.current);
      }}
      onClamp={(from, to) => setClamp(noticeEqual(from, to) ? null : { from, to, launch: committed.current })} />
    <p id={`${id}-help`} className="field-help">The simulation stops here even if the rocket is still in the air;
      the flight is then reported as incomplete. Accepts {noticeNumber(MAX_FLIGHT_TIME_S_RANGE[0])} to{' '}
      {noticeNumber(MAX_FLIGHT_TIME_S_RANGE[1])} s.</p>
    <div id={`${id}-status`} role="status">
      {clamp && clamp.launch === value ? <p className="field-caution">Maximum flight time was clamped to{' '}
        {noticeNumber(clamp.to, 6)} s from {noticeNumber(clamp.from, 6) === noticeNumber(clamp.to, 6)
          ? `just ${clamp.from < clamp.to ? 'below' : 'above'} ${noticeNumber(clamp.to, 6)}`
          : noticeNumber(clamp.from, 6)} s.</p> : null}
      {limit > 3600 ? <p className="field-caution">Long flights take longer to simulate and use more memory.</p> : null}
    </div>
  </div>;
}
