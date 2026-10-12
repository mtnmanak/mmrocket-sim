import { useRef, useState } from 'react';
import type { IgnitionEvent } from '@online-openrocket/engine';
import type { IgnitionTuple } from '../model/design.js';
import { describeFlownIgnition, flownIgnition } from '../services/flightOverrideSummary.js';
import { sparsify } from '../services/flightState.js';
import { Note } from './Note.js';
import { IGNITION_EVENT_LABELS } from '../services/flightOverrideText.js';
import { defaultFlightScope, FlightScopeChoice, type FlightEditScope } from './ConfigPartEditors.js';
import { NumField } from './NumField.js';

/**
 * CFG-SPEC A3: a motor card's ignition, with the same explicit scope choice as
 * the Recovery and Stages rows. The controls show and edit the chosen layer:
 * the mount's own setting, or the active owner's override. A switched owner
 * starts again from its own default scope; the controls stay mounted.
 */
export function MountIgnitionField({ mountId, mountName, ownerKey, own, override, overrideLabel, isStaged,
  onEdit, onEditStart, onEditEnd, onEditCancel, onReset }: {
  mountId: string; mountName: string; ownerKey: string;
  own: IgnitionTuple; override: IgnitionTuple | undefined;
  /** The override scope's wording; null when no configuration or working set is active. */
  overrideLabel: string | null; isStaged: boolean;
  onEdit: (scope: FlightEditScope, tuple: IgnitionTuple, numeric: boolean) => void;
  onEditStart: () => void;
  onEditEnd: (scope: FlightEditScope, tuple: IgnitionTuple) => void;
  onEditCancel: () => void;
  onReset: () => void;
}) {
  const [chosen, setScope] = useState<FlightEditScope | null>(null);
  const [previousOwner, setPreviousOwner] = useState(ownerKey);
  const select = useRef<HTMLSelectElement>(null);
  if (ownerKey !== previousOwner) {
    setPreviousOwner(ownerKey);
    setScope(null);
  }
  // Pinned on the first edit, so an override that sparsifies away does not
  // flip the controls back to the own setting under the user.
  const scope: FlightEditScope = overrideLabel === null ? 'own' : chosen ?? defaultFlightScope(true, !!override);
  const shown = scope === 'override' && override ? override : own;
  const edit = (tuple: IgnitionTuple, numeric = false) => {
    if (chosen === null && overrideLabel !== null) setScope(scope);
    onEdit(scope, tuple, numeric);
  };
  // The Launch warning's comparison (describeFlightOverrides): an override that
  // flies differently is Caution, as on the Recovery and Stages rows (D7 I10);
  // one that flies the same is said quietly (review of b9-int, finding 12).
  const differs = !!override && sparsify(flownIgnition(own), flownIgnition(override)) !== undefined;
  return <>
    <label htmlFor={`ignition-${mountId}`}>Ignition</label>
    {override
      ? <Note as="p" tier={differs ? 'caution' : 'information'} className="comp-stats">
        Ignition: <strong>overridden here</strong> — {describeFlownIgnition(override)}; own setting: {describeFlownIgnition(own)}
        {differs ? '.' : ' (flies the same as the own setting).'}
      </Note>
      : <p className="comp-stats">Ignition: uses the mount's own setting — {describeFlownIgnition(own)}.</p>}
    {overrideLabel !== null && <FlightScopeChoice scope={scope} overrideLabel={overrideLabel} onChange={setScope}
      legend="Ignition changes apply to" />}
    {override && <button type="button" className="file-btn" onClick={() => {
      onReset();
      // The button goes with the override; keyboard focus moves to the ignition control.
      select.current?.focus();
    }}>Reset to own setting</button>}
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <select
        ref={select}
        id={`ignition-${mountId}`}
        style={{ flex: 1 }}
        value={shown.event}
        onChange={(e) => edit({ ...shown, event: e.target.value as IgnitionEvent })}
      >
        <option value="automatic">{IGNITION_EVENT_LABELS.automatic}</option>
        {/* A single-stage design has no lower stage, so these two would never
            light it (review of v0.169); one already set stays visible to change. */}
        {(isStaged || shown.event === 'burnout') && (
          <option value="burnout">{IGNITION_EVENT_LABELS.burnout}</option>)}
        <option value="launch">{IGNITION_EVENT_LABELS.launch}</option>
        {(isStaged || shown.event === 'ejectioncharge') && (
          <option value="ejectioncharge">{IGNITION_EVENT_LABELS.ejectioncharge}</option>)}
        <option value="never">{IGNITION_EVENT_LABELS.never}</option>
      </select>
      <div style={{ width: 70 }}>
        <NumField
          value={shown.delay}
          onEditStart={onEditStart}
          onEditCancel={onEditCancel}
          onEditEnd={() => onEditEnd(scope, shown)}
          step={0.5}
          max={60}
          ariaLabel={`Ignition delay for ${mountName}`}
          onCommit={(v, editing) => {
            if (v === null) return;
            edit({ ...shown, delay: v }, editing);
          }}
        />
      </div>
      <span className="motor-db-meta">s</span>
    </div>
  </>;
}
