import type { ComponentNode } from '@online-openrocket/engine';
import type { DeploymentTuple, FlightOverrides, FlightTree } from '../model/design.js';
import { num } from '../tree/nodeNum.js';
import { overrideFor } from './flightState.js';
import { lookupTable } from './xmlUtil.js';

export function deploymentTuple(node: ComponentNode): DeploymentTuple {
  return { deployEvent: String(node['deployEvent'] ?? 'ejection'),
    deployAltitude: num(node, 'deployAltitude', 200), deployDelay: num(node, 'deployDelay', 0) };
}

/** Export references retain identity/delay metadata; only the active ignition layer changes. */
export function exportIgnitions<M extends { ignitionEvent?: string; ignitionDelay?: number }>(
  tree: FlightTree, motors: Record<string, M> | undefined, overrides: FlightOverrides,
): Record<string, M> | undefined {
  if (!motors) return motors;
  return lookupTable(Object.fromEntries(Object.entries(motors).map(([id, m]) => {
    const ignition = overrideFor(overrides.ignitions, id) ?? overrideFor(tree.ignitionDefaults, id);
    return [id, ignition ? { ...m, ignitionEvent: ignition.event, ignitionDelay: ignition.delay } : m];
  })));
}
