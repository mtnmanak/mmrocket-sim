import type { ComponentNode } from '@online-openrocket/engine';
import type { DeploymentTuple, IgnitionTuple, SeparationTuple } from '../model/design.js';
import { fmtFieldValue, siToUi } from '../prefs/units.js';
import { num } from '../tree/nodeNum.js';
import { DEPLOY_EVENTS, SEPARATION_EVENTS } from '../tree/schema.js';

export type ComponentFlightTuple = DeploymentTuple | SeparationTuple;

export function separationTuple(node: ComponentNode): SeparationTuple {
  return { separationEvent: String(node['separationEvent'] ?? 'ejection'),
    separationDelay: num(node, 'separationDelay', 0), separationAltitude: num(node, 'separationAltitude', 200) };
}

/** Editors show stored values; launch warnings show only values used by the event. */
export function describeComponentFlightTuple(tuple: ComponentFlightTuple, unit: string, mode: 'editor' | 'warning' = 'editor'): string {
  const recovery = 'deployEvent' in tuple;
  const event = recovery ? tuple.deployEvent : tuple.separationEvent;
  const altitude = recovery ? tuple.deployAltitude : tuple.separationAltitude;
  const delay = recovery ? tuple.deployDelay : tuple.separationDelay;
  const options = recovery ? DEPLOY_EVENTS : SEPARATION_EVENTS;
  const label = options.find(([key]) => key === event.toLowerCase())?.[1] ?? event;
  const height = `${fmtFieldValue(siToUi('altitude', unit, altitude))} ${unit}`;
  if (mode === 'warning') {
    return `${label}${event.toLowerCase().startsWith('altitude') ? `, ${height}` : ''}${delay !== 0 ? `, delay ${fmtFieldValue(delay)} s` : ''}`;
  }
  return `${label}${event.toLowerCase().startsWith('altitude') ? ` ${height}` : ` (stored altitude ${height})`}, delay ${fmtFieldValue(delay)} s`;
}

export const IGNITION_EVENT_LABELS = {
  automatic: "Automatic (launch / lower stage's ejection)",
  burnout: 'Lower stage burnout + delay (electronics)',
  launch: 'Launch + delay (timer)',
  ejectioncharge: 'Lower stage ejection charge + delay',
  never: 'Never',
} as const;

export function describeIgnitionTuple(tuple: IgnitionTuple, mode: 'editor' | 'warning' = 'editor'): string {
  return `${IGNITION_EVENT_LABELS[tuple.event] ?? tuple.event}${mode === 'editor' || tuple.delay !== 0 ? `, delay ${fmtFieldValue(tuple.delay)} s` : ''}`;
}
