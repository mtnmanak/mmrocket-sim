import type { ComponentNode } from '@online-openrocket/engine';
import { snapshotLoadedConfig } from './configSnapshot.js';
import type { DeploymentTuple, FlightOverrides, FlightTree, IgnitionTuple, SavedConfig,
  MountMotor, SeparationTuple } from '../model/design.js';

export type FlightTuple = DeploymentTuple | SeparationTuple | IgnitionTuple;
type OverrideMap<T> = Readonly<Record<string, T>> | undefined;

/** Exact storage equality: do not fold events, tolerate differences, or drop dormant altitude. */
export function sparsify<T extends FlightTuple>(defaultTuple: T, tuple: T): T | undefined {
  const keys = Object.keys(defaultTuple) as (keyof T)[];
  return keys.length === Object.keys(tuple).length && keys.every(key => defaultTuple[key] === tuple[key])
    ? undefined : tuple;
}

export function overrideFor<T>(overrides: OverrideMap<T>, id: string): T | undefined {
  return overrides && Object.hasOwn(overrides, id) ? overrides[id] : undefined;
}

/** Reset drops ownership rather than copying today's default into the configuration. */
export function resetOverride<T>(overrides: OverrideMap<T>, id: string): Record<string, T> {
  const next = { ...overrides };
  delete next[id];
  return next;
}

export function setOverride<T extends FlightTuple>(
  overrides: OverrideMap<T>, id: string, defaultTuple: T, tuple: T,
): Record<string, T> {
  return sparsify(defaultTuple, tuple) === undefined
    ? resetOverride(overrides, id) : { ...overrides, [id]: { ...tuple } };
}

/**
 * Supply this family's maps from ALL configurations plus the detached set.
 * Commit the returned default and maps together as one history step (FC-4/5).
 */
export function useOverrideEverywhere<T extends FlightTuple>(
  id: string, tuple: T, overrideMaps: readonly OverrideMap<T>[],
): { defaultTuple: T; overrideMaps: Record<string, T>[] } {
  return { defaultTuple: { ...tuple }, overrideMaps: overrideMaps.map(map => resetOverride(map, id)) };
}

/**
 * One pure projection for flight readers (audit 2026-10-11, FC-1). Editors keep
 * the input tree. Motors are the supplied working loadout, so unsaved motor edits
 * survive; only ignition is projected. Nozzle and stage mass remain Apply-time
 * working values, and stage activeness remains metadata (FC-SPEC decision 2).
 */
export function resolveFlightState(
  tree: FlightTree, savedConfigs: readonly SavedConfig[], activeConfigId: string | null,
  detached: FlightOverrides, mountMotors: Record<string, MountMotor>,
): { tree: FlightTree; mountMotors: Record<string, MountMotor> } {
  const overrides = savedConfigs.find(c => c.id === activeConfigId) ?? detached;
  const visit = (nodes: ComponentNode[]): ComponentNode[] => {
    let changed = false;
    const next = nodes.map(node => {
      const tuple = node.id ? node.type === 'parachute' || node.type === 'streamer'
        ? overrideFor(overrides.deployments, node.id)
        : node.type === 'stage' || node.type === 'parallelstage'
          ? overrideFor(overrides.separations, node.id) : undefined : undefined;
      const children = node.children ? visit(node.children) : undefined;
      if (!tuple && children === node.children) return node;
      changed = true;
      return { ...node, ...tuple, ...(children ? { children } : {}) };
    });
    return changed ? next : nodes;
  };
  const components = visit(tree.components);
  let motors = mountMotors;
  for (const [id, motor] of Object.entries(mountMotors)) {
    const ignition = overrideFor(overrides.ignitions, id)
      ?? overrideFor(tree.ignitionDefaults, id) ?? motor.ignition;
    if (sparsify(motor.ignition, ignition) === undefined) continue;
    if (motors === mountMotors) motors = { ...mountMotors };
    motors[id] = { ...motor, ignition: { ...ignition } };
  }
  return { tree: components === tree.components ? tree : { ...tree, components }, mountMotors: motors };
}

/** Only the three layered families travel when an active owner is deleted. */
export function activeFlightOverrides(
  configs: readonly SavedConfig[], activeId: string | null, detached: FlightOverrides,
): FlightOverrides {
  const active = configs.find(c => c.id === activeId);
  if (!active) return detached;
  // Only importer/migration output enters App. SavedConfig retains the legacy
  // partial-map type for the migration boundary; do not reconstruct or reorder
  // complete tuples here (the canonical physics document retains key order).
  return {
    ...(active.deployments ? { deployments: active.deployments as FlightOverrides['deployments'] } : {}),
    ...(active.separations ? { separations: active.separations as FlightOverrides['separations'] } : {}),
    ...(active.ignitions ? { ignitions: active.ignitions } : {}),
  };
}

/** New owns only effective tuples which differ from today's component defaults. */
export function snapshotFlightOverrides(
  tree: FlightTree, configs: readonly SavedConfig[], activeId: string | null,
  detached: FlightOverrides, motors: Record<string, MountMotor>,
): FlightOverrides {
  const effective = resolveFlightState(tree, configs, activeId, detached, motors);
  const defaults = snapshotLoadedConfig(tree, {});
  const flown = snapshotLoadedConfig(effective.tree, {});
  const deployments = Object.fromEntries(Object.entries(flown.deployments).filter(([id, d]) =>
    JSON.stringify(d) !== JSON.stringify(defaults.deployments[id]))) as Record<string, DeploymentTuple>;
  const separations = Object.fromEntries(Object.entries(flown.separations).filter(([id, d]) =>
    JSON.stringify(d) !== JSON.stringify(defaults.separations[id]))) as Record<string, SeparationTuple>;
  // Unloaded mounts still own ignition choices; New must retain them too.
  const ignitionChoices = { ...activeFlightOverrides(configs, activeId, detached).ignitions,
    ...Object.fromEntries(Object.entries(effective.mountMotors).map(([id, m]) => [id, m.ignition])) };
  const ignitions = Object.fromEntries(Object.entries(ignitionChoices).filter(([id, tuple]) =>
    sparsify(tree.ignitionDefaults?.[id] ?? motors[id]?.ignition ?? { event: 'automatic', delay: 0 }, tuple)));
  return { deployments, separations, ignitions };
}
