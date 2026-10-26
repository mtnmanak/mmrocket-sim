import type { ComponentNode } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';
import type { FlightOverrides, FlightTree, MountMotor, SavedConfig } from '../model/design.js';
import { primaryMountOf, stagesWithNozzle } from '../tree/treeModel.js';
import { assignedMotorsOf, physicsKeyOf, provenanceKeyOf } from './designDerivation.js';
import { resolveFlightState } from './flightState.js';
import { configOntoTree } from './importApply.js';
import type { OrkExportConfig, OrkExportMotor, OrkMotorRef } from './orkFile.js';
import type { FlightDataForExportInput } from './orkFlightData.js';
import { orkMotorSet, type ExLibrary, type FlownAutoDelays } from './orkExportMotors.js';
import { motorSetKeyOf, type DesignMatchKey } from './simReport.js';

/**
 * Save/share/loss-check assembly, extracted without changing the writer's
 * ordering or Option C layers (audit 2026-10-11, S2-8). No storage reads:
 * the caller supplies the EX lookup, asked for only by EX motor mapping.
 */
export function exportMotorsMap(input: {
  assigned: readonly (readonly [string, MountMotor])[];
  unmatchedRefs: Record<string, OrkMotorRef>;
  tree: FlightTree;
  activeConfigId: string | null;
  exLibrary: ExLibrary;
}, flown: FlownAutoDelays = {}): Record<string, OrkExportMotor> {
  const { assigned, unmatchedRefs, tree, activeConfigId, exLibrary } = input;
  // Loaded motors first: on a tied primary, keep the pad mass shown on its card.
  return orkMotorSet({ records: Object.fromEntries(assigned), refs: unmatchedRefs, tree, flown,
    configKey: activeConfigId ?? '', exLibrary, first: 'records' });
}

interface ExportFlightState extends Pick<FlightDataForExportInput,
  'runs' | 'importedDocument' | 'activeConfigId' | 'assigned' | 'refusedMountIds' | 'hardwareDeltaKg'> {
  tree: FlightTree;
  savedConfigs: SavedConfig[];
  mounts: ComponentNode[];
  mountMotors: Record<string, MountMotor>;
  detachedOverrides: FlightOverrides;
  provenanceKey: DesignMatchKey;
  launch: LaunchConditions;
  aeroMode: FlightDataForExportInput['model']['aeroMode'];
  effectiveKbf: boolean;
  autoSupersonic: boolean;
}

/** The same owner-specific effective inputs Launch stamps onto a stored flight. */
export function flightExportInput(input: ExportFlightState): FlightDataForExportInput {
  const { runs, importedDocument, savedConfigs, activeConfigId, assigned, refusedMountIds, mounts, provenanceKey,
    aeroMode, effectiveKbf, autoSupersonic, hardwareDeltaKg, tree, detachedOverrides, mountMotors, launch } = input;
  const states = new Map<string | null, ReturnType<NonNullable<FlightDataForExportInput['configurationState']>>>();
  return {
    runs, importedDocument, savedConfigs, activeConfigId, assigned, refusedMountIds,
    mountIds: mounts.map((m) => m.id).filter((id): id is string => typeof id === 'string'),
    designKey: provenanceKey.designKey,
    configurationState: (id) => {
      const cached = states.get(id);
      if (cached) return cached;
      const cfg = savedConfigs.find(c => c.id === id);
      const working = id === activeConfigId;
      const resolved = resolveFlightState(!working && cfg ? configOntoTree(tree, cfg) : tree,
        savedConfigs, id, detachedOverrides, working ? mountMotors : cfg?.motors ?? mountMotors);
      const motors = assignedMotorsOf(resolved.mountMotors, mounts);
      const state = { ...provenanceKeyOf({ tree: resolved.tree, physicsKey: physicsKeyOf(resolved.tree.components),
        assigned: motors, hardwareDeltaKg: working ? hardwareDeltaKg : 0, launch,
        aero: { aeroMode, effectiveKbf, autoSupersonic } }), motors };
      states.set(id, state);
      return state;
    },
    conditionsKey: provenanceKey.conditionsKey,
    model: { aeroMode, effectiveKbf, autoSupersonic },
    // Tree-only: another configuration may burn in a stage that is bare now.
    hasNozzle: stagesWithNozzle(tree).length > 0,
    requiresPhysicsRevision: provenanceKey.requiresPhysicsRevision,
    physicsRevisions: provenanceKey.physicsRevisions,
    motorSetKeyOf,
    hardwareDeltaKg,
    primaryMountOf: (ids) => primaryMountOf(tree, ids),
  };
}

/** Stable ids and sparse layers ride through; references retain the stored tie order. */
export function exportConfigs(
  configs: readonly SavedConfig[], tree: FlightTree, exLibrary: ExLibrary, flown: FlownAutoDelays = {},
): OrkExportConfig[] {
  return configs.map((c) => ({
    id: c.id, name: c.name, isDefault: c.isDefault,
    ...(c.stageActiveness ? { stageActiveness: c.stageActiveness } : {}),
    ...(c.motorLoadoutRefusal ? { motorLoadoutRefusal: c.motorLoadoutRefusal } : {}),
    motors: orkMotorSet({ records: c.motors, refs: c.unmatchedRefs, tree, flown, configKey: c.id, exLibrary, first: 'refs' }),
    ...(c.ignitions ? { ignitions: c.ignitions } : {}),
    ...(c.deployments ? { deployments: c.deployments } : {}),
    ...(c.separations ? { separations: c.separations } : {}),
    ...(c.stageMassOverrides ? { stageMassOverrides: c.stageMassOverrides } : {}),
  }));
}
