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

/** Banner and launch warnings describe the complete tuple, including dormant altitude. */
export function describeComponentFlightTuple(tuple: ComponentFlightTuple, unit: string): string {
  const recovery = 'deployEvent' in tuple;
  const event = recovery ? tuple.deployEvent : tuple.separationEvent;
  const altitude = recovery ? tuple.deployAltitude : tuple.separationAltitude;
  const delay = recovery ? tuple.deployDelay : tuple.separationDelay;
  const options = recovery ? DEPLOY_EVENTS : SEPARATION_EVENTS;
  const label = options.find(([key]) => key === event.toLowerCase())?.[1] ?? event;
  const height = `${fmtFieldValue(siToUi('distance', unit, altitude))} ${unit}`;
  return `${label}${event.toLowerCase().startsWith('altitude') ? ` ${height}` : ` (stored altitude ${height})`}, delay ${fmtFieldValue(delay)} s`;
}

export const IGNITION_EVENT_LABELS = {
  automatic: "Automatic (launch / lower stage's ejection)",
  burnout: 'Lower stage burnout + delay (electronics)',
  launch: 'Launch + delay (timer)',
  ejectioncharge: 'Lower stage ejection charge + delay',
  never: 'Never',
} as const;

export function describeIgnitionTuple(tuple: IgnitionTuple): string {
  return `${IGNITION_EVENT_LABELS[tuple.event] ?? tuple.event}, delay ${fmtFieldValue(tuple.delay)} s`;
}
