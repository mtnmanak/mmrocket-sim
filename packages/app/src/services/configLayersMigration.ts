import type { ComponentNode } from '@online-openrocket/engine';
import type { ConfigurationLayers, DeploymentTuple, IgnitionTuple, LayeredSavedConfig,
  MountMotor, SeparationTuple } from '../model/design.js';
import type { SessionState } from './session.js';
import type { OrkMotorRef } from './orkFile.js';
import { designFingerprint } from './dirtyState.js';
import { num } from '../tree/nodeNum.js';
import { separationEventOrDefault } from '../tree/sanitize.js';
import { knownIgnitionEvent } from './ignitionEvent.js';
import { overrideFor, sparsify } from './flightState.js';

export type ConfigLayersSession = Omit<SessionState, 'tree' | 'savedConfigs' | 'mountMotors' | 'activeConfigId'>
  & ConfigurationLayers & { mountMotors: Record<string, MountMotor>; activeConfigId: string | null };
export type ConfigLayersInput = SessionState & Partial<Pick<ConfigurationLayers, 'configLayers' | 'detachedOverrides'>>;

const deploymentOf = (node: ComponentNode | undefined): DeploymentTuple => ({
  deployEvent: typeof node?.['deployEvent'] === 'string' ? node['deployEvent'] : 'ejection',
  deployAltitude: num(node ?? {}, 'deployAltitude', 200), deployDelay: num(node ?? {}, 'deployDelay', 0),
});
const separationOf = (node: ComponentNode | undefined): SeparationTuple => ({
  separationEvent: typeof node?.['separationEvent'] === 'string' ? node['separationEvent'] : 'ejection',
  separationDelay: num(node ?? {}, 'separationDelay', 0), separationAltitude: num(node ?? {}, 'separationAltitude', 200),
});
const AUTOMATIC: IgnitionTuple = { event: 'automatic', delay: 0 };
const ignitionOfRef = (ref: OrkMotorRef): IgnitionTuple => ({
  event: knownIgnitionEvent(ref.ignitionEvent) ?? 'automatic', delay: ref.ignitionDelay ?? 0,
});

/** Match the existing dirty-state inputs, including the legacy length-limit field. */
function fingerprint(state: SessionState): string {
  return designFingerprint({ ...state, mountMotors: state.mountMotors ?? {}, savedConfigs: state.savedConfigs ?? [],
    activeConfigId: state.activeConfigId ?? null, measured: state.measured ?? { massKg: null, cgM: null } });
}

/**
 * Pure, one-shot transition (audit 2026-10-11, FC-1; FC-SPEC decision 8).
 * Call AFTER the established session normalizations (including plugged-delay
 * revival and legacy nozzle-zero conversion) and tree restore. No I/O here.
 * FC-4 must call it for BOTH restore and backup, persist the whole result
 * atomically, and supply its new layered fingerprint if that algorithm changes.
 * The legacy capture rules are local deliberately: FC-4 will change configSync.
 */
export function migrateConfigLayers(
  input: ConfigLayersInput, migratedFingerprint: (state: ConfigLayersSession) => string = fingerprint,
): { state: ConfigLayersSession; note: string | null } {
  if (input.configLayers === 1) return { state: input as ConfigLayersSession, note: null };
  const wasClean = !!input.savedMark && input.savedMark === fingerprint(input);
  const nodes = new Map<string, ComponentNode>();
  const visit = (children: ComponentNode[]) => {
    for (const node of children) {
      if (node.id) nodes.set(node.id, node);
      visit(node.children ?? []);
    }
  };
  visit(input.tree.components);
  const configs = input.savedConfigs ?? [];
  const active = configs.find(c => c.id === input.activeConfigId);
  const mountMotors = input.mountMotors ?? {};
  const unmatchedRefs = Object.fromEntries(Object.entries(input.unmatchedRefs ?? active?.unmatchedRefs ?? {})
    .filter(([id]) => !Object.hasOwn(mountMotors, id)));
  const ignitionDefaults: Record<string, IgnitionTuple> = {};
  // Inactive-only mounts have no restored working ignition: use the kernel's
  // default and retain their legacy resolved value as an override.
  for (const c of configs) {
    for (const id of [...Object.keys(c.motors), ...Object.keys(c.unmatchedRefs ?? {})]) {
      Object.defineProperty(ignitionDefaults, id, { value: { ...AUTOMATIC }, enumerable: true, writable: true, configurable: true });
    }
  }
  for (const [id, ref] of Object.entries(unmatchedRefs)) {
    Object.defineProperty(ignitionDefaults, id, { value: ignitionOfRef(ref), enumerable: true, writable: true, configurable: true });
  }
  for (const [id, motor] of Object.entries(mountMotors)) {
    Object.defineProperty(ignitionDefaults, id, { value: { ...motor.ignition }, enumerable: true, writable: true, configurable: true });
  }

  let partial = false;
  const savedConfigs: LayeredSavedConfig[] = configs.map(config => {
    const isActive = config === active;
    const deployments: Record<string, DeploymentTuple> = {};
    const separations: Record<string, SeparationTuple> = {};
    for (const [id, stored] of Object.entries(config.deployments ?? {})) {
      const node = nodes.get(id);
      const baseline = deploymentOf(node);
      if (Object.keys(baseline).some(key => stored[key as keyof DeploymentTuple] === undefined)) partial = true;
      // Legacy sync captured live values for owned, still-present nodes; absent
      // nodes kept their stored records for undo. A full tuple freezes any gaps.
      const tuple = isActive && node ? {
        ...baseline,
        // Unlike delay/altitude, legacy liveOverride had no event fallback:
        // an absent live event retained the stored event rather than erasing it.
        deployEvent: typeof node['deployEvent'] === 'string' ? node['deployEvent']
          : stored.deployEvent ?? baseline.deployEvent,
      } : {
        deployEvent: stored.deployEvent ?? baseline.deployEvent,
        deployAltitude: stored.deployAltitude ?? baseline.deployAltitude,
        deployDelay: stored.deployDelay ?? baseline.deployDelay,
      };
      if (!node || sparsify(baseline, tuple)) {
        Object.defineProperty(deployments, id, { value: tuple, enumerable: true, writable: true, configurable: true });
      }
    }
    for (const [id, stored] of Object.entries(config.separations ?? {})) {
      const node = nodes.get(id);
      const baseline = separationOf(node);
      if (Object.keys(baseline).some(key => stored[key as keyof SeparationTuple] === undefined)) partial = true;
      const tuple = isActive && node ? {
        ...baseline, separationEvent: separationEventOrDefault(baseline.separationEvent),
      } : {
        // Legacy configOntoTree normalized only explicit separation events.
        separationEvent: stored.separationEvent === undefined ? baseline.separationEvent
          : separationEventOrDefault(stored.separationEvent),
        separationDelay: stored.separationDelay ?? baseline.separationDelay,
        separationAltitude: stored.separationAltitude ?? baseline.separationAltitude,
      };
      if (!node || sparsify(baseline, tuple)) {
        Object.defineProperty(separations, id, { value: tuple, enumerable: true, writable: true, configurable: true });
      }
    }
    const motors = isActive ? mountMotors : config.motors;
    const refs = isActive ? unmatchedRefs : config.unmatchedRefs ?? {};
    const ignitions: Record<string, IgnitionTuple> = {};
    const tuples = Object.fromEntries([
      ...Object.entries(refs).map(([id, ref]) => [id, ignitionOfRef(ref)] as const),
      ...Object.entries(motors).map(([id, motor]) => [id, motor.ignition] as const),
    ]);
    for (const [id, tuple] of Object.entries(tuples)) {
      if (sparsify(overrideFor(ignitionDefaults, id) ?? AUTOMATIC, tuple)) {
        Object.defineProperty(ignitions, id, { value: { ...tuple }, enumerable: true, writable: true, configurable: true });
      }
    }
    const next: LayeredSavedConfig = { ...config, motors, deployments, separations, ignitions };
    if (isActive) {
      delete next.unmatched;
      delete next.unmatchedRefs;
      if (Object.keys(refs).length) {
        next.unmatchedRefs = refs;
        next.unmatched = Object.values(refs).map(ref => ref.designation);
      }
    }
    return next;
  });
  const state: ConfigLayersSession = { ...input, configLayers: 1,
    tree: { ...input.tree, ignitionDefaults }, savedConfigs, mountMotors, unmatchedRefs,
    activeConfigId: active?.id ?? null, detachedOverrides: {} };
  // These qualifications cannot be proven from a restored session alone. Keep
  // file-owned historical summaries (already exported OUTDATED), not a claim
  // that their inputs or old Auto-delay answers still qualify for this design.
  delete state.lossySaved;
  delete state.flownAutoDelays;
  const nextMark = migratedFingerprint(state);
  if (wasClean) state.savedMark = nextMark;
  else if (state.savedMark === nextMark) delete state.savedMark;
  return { state, note: 'The component settings are what the autosave had. Reopening the original file brings back '
    + "the file's own settings. Saved flight configurations keep their restored settings as overrides."
    + (partial ? ' Missing legacy fields were fixed to the restored component settings; earlier configuration-switch sequences cannot be recovered.' : '') };
}
