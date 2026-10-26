import { INITIAL_UNITS, type UnitSelection } from '../prefs/units.js';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { overrideFor } from './flightState.js';
import { ownEntry } from './ownEntry.js';
import { savedConfigLabel } from '../model/design.js';
import type { ImportedDesign, ResolvedImportMotors } from './importApply.js';
import type { MotorDbEntry } from './motorDb.js';
import type { OrkMotorRef } from './orkFile.js';
import { fetchSpecByDigest, fileMotorIdentity, mountMotorFromDb, namesOtherMaker, type MotorMatchDeps } from './motorMatch.js';
import { exToDbEntry, exToMotorSpec, type ExMotor } from './exMotors.js';
import { defaultDelay, delayOptions } from './thrustcurve.js';
import { findNode, kernelStageIdByNode, motorMounts, mountName } from '../tree/treeModel.js';
import { knownIgnitionEvent } from './ignitionEvent.js';
import { lookupTable } from './xmlUtil.js';
import type { DesignSnapshot } from './dirtyState.js';
import type { MotorMatchResult } from './motorMatch.js';

export interface OpenMotorIdentity {
  key: string;
  ref: OrkMotorRef;
  candidates: MotorDbEntry[];
  locations: { configId: string | null; mountId: string; ref: OrkMotorRef }[];
  carriedBy: string[];
}

export type OpenMotorChoice = { kind: 'catalogue'; motor: MotorDbEntry }
  | { kind: 'ex'; motor: ExMotor } | { kind: 'empty' };
export type OpenMotorState = Pick<DesignSnapshot, 'mountMotors' | 'savedConfigs'> & {
  unmatchedRefs: Record<string, OrkMotorRef>;
};

const identityKey = (ref: OrkMotorRef) => JSON.stringify([
  ref.manufacturer.trim().toLowerCase(), ref.designation.trim().toLowerCase(),
]);

export function acceptedOtherMakerNotes(resolved: ResolvedImportMotors): ResolvedImportMotors {
  const clear = (results: Record<string, MotorMatchResult>) => Object.fromEntries(
    Object.entries(results).map(([id, result]) => {
      if (!result.otherMaker) return [id, result];
      const { openNote: _note, ...rest } = result;
      if (!rest.motor) return [id, rest];
      const { openNote: _motorNote, ...motor } = rest.motor;
      return [id, { ...rest, motor }];
    }));
  return { ...resolved, working: clear(resolved.working),
    configResults: Object.fromEntries(Object.entries(resolved.configResults ?? {}).map(([id, results]) => [id, clear(results)])) };
}

// @atestani TRF #162, Eric 2026-10-06: a question belongs to the file identity,
// including configurations not on screen, rather than to the substituted motor.
export function collectOpenMotorIdentities(
  imported: ImportedDesign, resolved: ResolvedImportMotors, snapshot: DesignSnapshot,
): OpenMotorIdentity[] {
  const groups = new Map<string, OpenMotorIdentity>();
  for (const results of [resolved.working, ...Object.values(resolved.configResults ?? {})]) {
    for (const result of Object.values(results)) {
      if (!result.motor || !result.otherMaker) continue;
      const { ref, candidates } = result.otherMaker;
      const key = identityKey(ref);
      const group = groups.get(key);
      if (group) {
        for (const row of candidates) {
          if (!group.candidates.some(m => m.motorId === row.motorId)) group.candidates.push(row);
        }
      } else groups.set(key, { key, ref, candidates: [...candidates], locations: [], carriedBy: [] });
    }
  }
  const sets: { configId: string | null; motors: Record<string, OrkMotorRef> }[] = (imported.configs ?? []).map(c => ({ configId: c.id, motors: c.motors }));
  if (!imported.chosenConfigId) sets.push({ configId: null, motors: imported.motors });
  const mounts = motorMounts(snapshot.tree);
  for (const set of sets) {
    for (const [mountId, ref] of Object.entries(set.motors)) {
      const result = set.configId === (imported.chosenConfigId ?? null)
        ? ownEntry(resolved.working, mountId) : ownEntry(ownEntry(resolved.configResults, set.configId!), mountId);
      // @atestani TRF #162, Eric 2026-10-06: a shared name alone does not
      // authorize replacing an embedded EX or a differently resolved motor.
      if (!result?.otherMaker) continue;
      const group = groups.get(identityKey(ref));
      if (!group) continue;
      group.locations.push({ configId: set.configId, mountId, ref });
      const config = snapshot.savedConfigs.find(c => c.id === set.configId);
      const number = mounts.findIndex(m => m.id === mountId) + 1;
      const mount = mountName(findNode(snapshot.tree, mountId));
      const label = `${mount}${number ? ` (mount ${number})` : ''} — ${config ? savedConfigLabel(config) : 'Loaded motors'}`;
      if (!group.carriedBy.includes(label)) group.carriedBy.push(label);
    }
  }
  return [...groups.values()];
}

export async function applyOpenMotorChoices(
  state: OpenMotorState & Pick<DesignSnapshot, 'tree'>, activeConfigId: string | null, groups: OpenMotorIdentity[],
  choices: Record<string, OpenMotorChoice>, fetchSpec?: NonNullable<MotorMatchDeps['fetchSpec']>, units: UnitSelection = INITIAL_UNITS,
): Promise<OpenMotorState> {
  const loadSpec = fetchSpec ?? ((motor, delay, digest) => fetchSpecByDigest(motor, delay, digest, units));
  const mountMotors = Object.assign(Object.create(null) as Record<string, MountMotor>, state.mountMotors);
  const unmatchedRefs = { ...state.unmatchedRefs };
  const savedConfigs = state.savedConfigs.map(c => ({ ...c, motors: Object.assign(Object.create(null) as Record<string, MountMotor>, c.motors) }));
  const stageOfMount = kernelStageIdByNode(state.tree);
  const replace = async (motors: Record<string, MountMotor>, mountId: string,
    ref: OrkMotorRef, choice: OpenMotorChoice) => {
    const old = overrideFor(motors, mountId);
    if (choice.kind === 'empty') { delete motors[mountId]; return; }
    // @atestani TRF #162, Eric 2026-10-06: accepting the loaded motor only
    // silences its question; its file delay and offline curve are already valid.
    if (choice.kind === 'catalogue' && choice.motor.motorId === old?.meta.motorId) {
      const kept = { ...old };
      delete kept.openNote;
      Object.defineProperty(motors, mountId, { value: kept, enumerable: true, writable: true, configurable: true });
      return;
    }
    const db = choice.kind === 'ex' ? exToDbEntry(choice.motor) : choice.motor;
    const previousDelay = old?.spec.ejectionDelay ?? ref.delay;
    // The chosen EX motor owns its every-delay list, just as it does on open
    // (audit 2026-10-11, S7a-2). Explicit Auto survives the choice as well.
    const exAuto = choice.kind === 'ex' && (ref.rktEveryDelay ? defaultDelay(db) === null : ref.autoDelay);
    const delay = choice.kind === 'ex' && ref.rktEveryDelay ? defaultDelay(db) ?? 0
      : choice.kind === 'ex' || delayOptions(db).includes(previousDelay) ? previousDelay : defaultDelay(db) ?? 0;
    // The file's <digest> goes along: on the motor the file named, it is the
    // curve desktop flew (thrustcurve.ts pickDigestFile); on another, it names
    // none of its files and changes nothing.
    const spec = choice.kind === 'ex' ? exToMotorSpec(choice.motor, delay) : await loadSpec(db, delay, ref.digest);
    const identity = fileMotorIdentity(ref);
    if (choice.kind === 'catalogue' && namesOtherMaker(ref, db)) delete identity.orkManufacturer;
    const motor = mountMotorFromDb(db, spec, delay,
      old?.ignition ?? { event: knownIgnitionEvent(ref.ignitionEvent) ?? 'automatic', delay: ref.ignitionDelay ?? 0 },
      { ...identity, ...(choice.kind === 'ex' ? { exMotorId: choice.motor.motorId } : {}),
        ...(exAuto || (choice.kind === 'catalogue' && defaultDelay(db) === null) ? { autoDelay: true } : {}) });
    // @atestani TRF #162, Eric 2026-10-06: the weighed-set key must still flag a changed loadout.
    const next = { ...old, ...motor };
    delete next.openNote;
    Object.defineProperty(motors, mountId, { value: next, enumerable: true, writable: true, configurable: true });
  };
  for (const group of groups) {
    const choice = ownEntry(choices, group.key);
    if (!choice) throw new Error(`Choose a motor for ${group.ref.manufacturer} ${group.ref.designation}.`);
    for (const { configId, mountId, ref } of group.locations) {
      const config = savedConfigs.find(c => c.id === configId);
      if (config) {
        const old = overrideFor(config.motors, mountId);
        await replace(config.motors, mountId, ref, choice);
        const stageId = stageOfMount.get(mountId);
        // @atestani TRF #162, Eric 2026-10-06: inactive configurations have
        // no nozzle-follow effect. Clear only a nozzle this configuration owns;
        // an absent stage key leaves nozzle-follow in charge on a later switch.
        // Null clears an owned nozzle instead of inheriting the previous one.
        if (old && old.spec !== config.motors[mountId]?.spec && stageId !== undefined
          && config.nozzles && Object.hasOwn(config.nozzles, stageId) && config.nozzles[stageId] !== 0) {
          config.nozzles = lookupTable({ ...config.nozzles, [stageId]: null });
        }
        if (overrideFor(config.unmatchedRefs, mountId)) {
          config.unmatchedRefs = lookupTable(config.unmatchedRefs ?? {});
          delete config.unmatchedRefs[mountId];
          config.unmatched = Object.values(config.unmatchedRefs).map(r => r.designation);
        }
      }
      if (configId === activeConfigId) {
        await replace(mountMotors, mountId, ref, choice);
        delete unmatchedRefs[mountId];
      }
    }
  }
  return { mountMotors, savedConfigs, unmatchedRefs };
}

/** @atestani TRF #162, Eric 2026-10-06: capture before writing, for one atomic undo step. */
export function commitOpenMotorChoices(next: OpenMotorState, sinks: {
  commitStep: () => void;
  setMountMotors: (motors: Record<string, MountMotor>) => void;
  setSavedConfigs: (configs: SavedConfig[]) => void;
  setUnmatchedRefs: (refs: Record<string, OrkMotorRef>) => void;
}) {
  sinks.commitStep();
  sinks.setMountMotors(next.mountMotors);
  sinks.setSavedConfigs(next.savedConfigs);
  sinks.setUnmatchedRefs(next.unmatchedRefs);
}
