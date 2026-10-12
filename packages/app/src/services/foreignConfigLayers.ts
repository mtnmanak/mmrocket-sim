import type { ComponentNode } from '@online-openrocket/engine';
import type { DeploymentTuple, FlightOverrides, FlightTree } from '../model/design.js';
import { num } from '../tree/nodeNum.js';
import type { LayeredOrkFlightConfig, OrkFlightConfig } from './orkFile.js';
import { snapshotLoadedConfig } from './configSnapshot.js';
import { resolveFlightState } from './flightState.js';

export function deploymentTuple(node: ComponentNode): DeploymentTuple {
  return { deployEvent: String(node['deployEvent'] ?? 'ejection'),
    deployAltitude: num(node, 'deployAltitude', 200), deployDelay: num(node, 'deployDelay', 0) };
}

/** FC-2 compatibility until FC-4: only flight tuples are projected; nozzle/mass stay Apply-owned. */
export function legacyImportFlightState(tree: FlightTree, configs: LayeredOrkFlightConfig[], chosenId: string | null) {
  const layers = configs.map(c => ({ ...c, motors: {} }));
  const full: OrkFlightConfig[] = configs.map(c => {
    const resolved = resolveFlightState(tree, layers, c.id, {}, {}).tree;
    const snapshot = snapshotLoadedConfig(resolved, c.motors);
    return { ...c, deployments: snapshot.deployments, separations: snapshot.separations };
  });
  // The legacy motor editor owns ignition on motor records, which already hold resolved file values.
  const { ignitionDefaults: _defaults, ...workingTree } = resolveFlightState(tree, layers, chosenId, {}, {}).tree;
  return { tree: workingTree, configs: full };
}

/** Export references retain identity/delay metadata; only the active ignition layer changes. */
export function exportIgnitions<M extends { ignitionEvent?: string; ignitionDelay?: number }>(
  tree: FlightTree, motors: Record<string, M> | undefined, overrides: FlightOverrides,
): Record<string, M> | undefined {
  if (!motors) return motors;
  return Object.fromEntries(Object.entries(motors).map(([id, m]) => {
    const ignition = overrides.ignitions?.[id] ?? tree.ignitionDefaults?.[id];
    return [id, ignition ? { ...m, ignitionEvent: ignition.event, ignitionDelay: ignition.delay } : m];
  }));
}
