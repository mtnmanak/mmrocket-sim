import { useId, useState } from 'react';
import type { ComponentNode } from '@online-openrocket/engine';
import type { DeploymentTuple, FlightOverrides, SeparationTuple } from '../model/design.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtFieldValue, siToUi, uiToSi } from '../prefs/units.js';
import { deploymentTuple } from '../services/foreignConfigLayers.js';
import { num } from '../tree/nodeNum.js';
import { DEPLOY_EVENTS, SEPARATION_EVENTS } from '../tree/schema.js';
import { NumField } from './NumField.js';

export type ComponentFlightTuple = DeploymentTuple | SeparationTuple;

/** Defaults stay in the ordinary fields; this region edits only the flown layer (FC-5). */
export function FlightOverrideBanner({ node, overrides, configLabel, onEdit, onEditStart, onEditEnd, onEditCancel, onReset, onEverywhere }: {
  node: ComponentNode; overrides: FlightOverrides; configLabel: string | null;
  onEdit: (tuple: ComponentFlightTuple, numeric?: boolean) => void;
  onEditStart: () => void; onEditEnd: (tuple: ComponentFlightTuple) => void;
  onEditCancel: () => void;
  onReset: () => void; onEverywhere: () => void;
}) {
  const { prefs } = usePrefs();
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const recovery = node.type === 'parachute' || node.type === 'streamer';
  const tuple = recovery ? overrides.deployments?.[node.id!] : overrides.separations?.[node.id!];
  if (!tuple) return null;
  const own = recovery ? deploymentTuple(node) : {
    separationEvent: String(node['separationEvent'] ?? 'ejection'),
    separationDelay: num(node, 'separationDelay', 0), separationAltitude: num(node, 'separationAltitude', 200),
  };
  const values = (t: ComponentFlightTuple) => 'deployEvent' in t
    ? { event: t.deployEvent, altitude: t.deployAltitude, delay: t.deployDelay }
    : { event: t.separationEvent, altitude: t.separationAltitude, delay: t.separationDelay };
  const current = values(tuple);
  const options = recovery ? DEPLOY_EVENTS : SEPARATION_EVENTS;
  const unit = prefs.units.distance;
  const describe = (t: ComponentFlightTuple) => {
    const v = values(t);
    const event = options.find(([key]) => key === v.event.toLowerCase())?.[1] ?? v.event;
    const altitude = `${fmtFieldValue(siToUi('distance', unit, v.altitude))} ${unit}`;
    return `${event}${v.event.toLowerCase().startsWith('altitude') ? ` ${altitude}` : ` (stored altitude ${altitude})`}, delay ${fmtFieldValue(v.delay)} s`;
  };
  const edit = (patch: Partial<ReturnType<typeof values>>, numeric = false) => {
    const v = { ...current, ...patch };
    onEdit(recovery ? { deployEvent: v.event, deployAltitude: v.altitude, deployDelay: v.delay }
      : { separationEvent: v.event, separationAltitude: v.altitude, separationDelay: v.delay }, numeric);
  };
  const subject = recovery ? node.type : 'stage';
  return <div className="flight-override" role="region" aria-label={recovery ? 'Recovery override' : 'Stage separation override'}
    style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: 6, padding: 10, overflowWrap: 'anywhere' }}>
    <p className="comp-stats" style={{ marginTop: 0 }}>
      {configLabel ? `Flight configuration “${configLabel}”` : 'The detached working settings'} overrides this {subject}:
      {' '}{recovery ? 'it deploys at' : 'it separates at'} {describe(tuple)}.
      {' '}These fields are the {subject}'s own setting ({describe(own)}), used by every configuration without an override.
    </p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <button type="button" className="file-btn" aria-expanded={editing} aria-controls={`${uid}-editor`}
        onClick={() => setEditing(!editing)}>Edit the override</button>
      <button type="button" className="file-btn" onClick={onReset}>Reset to this setting</button>
      <button type="button" className="file-btn" onClick={onEverywhere}>Use the override everywhere</button>
    </div>
    {editing && <div id={`${uid}-editor`} className="field-grid" style={{ marginTop: 8 }}>
      <div className="field">
        <label htmlFor={`${uid}-event`}>Override event</label>
        <select id={`${uid}-event`} aria-label="Override event" value={current.event}
          onChange={e => edit({ event: e.target.value })}>
          {!options.some(([value]) => value === current.event) && <option value={current.event}>{current.event}</option>}
          {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${uid}-altitude`}>Override altitude ({unit})</label>
        <NumField id={`${uid}-altitude`} ariaLabel={`Override altitude (${unit})`}
          onEditStart={onEditStart} onEditEnd={() => onEditEnd(tuple)} onEditCancel={onEditCancel}
          value={siToUi('distance', unit, current.altitude)}
          validate={v => Number.isFinite(uiToSi('distance', unit, v))}
          onCommit={(v, editing) => { if (v !== null) edit({ altitude: uiToSi('distance', unit, v) }, editing); }} />
      </div>
      <div className="field">
        <label htmlFor={`${uid}-delay`}>Override delay (s)</label>
        <NumField id={`${uid}-delay`} ariaLabel="Override delay (s)" value={current.delay} step={0.5}
          onEditStart={onEditStart} onEditEnd={() => onEditEnd(tuple)} onEditCancel={onEditCancel}
          onCommit={(v, editing) => { if (v !== null) edit({ delay: v }, editing); }} />
      </div>
    </div>}
  </div>;
}
