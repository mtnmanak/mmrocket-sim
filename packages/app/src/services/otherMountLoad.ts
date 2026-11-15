import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { mountBore } from '../tree/scaleRocket.js';
import { kernelStageIdByNode, motorMounts, mountName } from '../tree/treeModel.js';
import { motorLengthLimit } from '../tree/motorLength.js';
import { diameterClass, fitsMount, MOUNT_TOLERANCE_MM } from './motorDb.js';
import { motorIdentity } from './hardwareMass.js';
import { withAuto, withDelay } from './mountDelayEdits.js';
import { stableJson } from './dirtyState.js';
import { overrideFor } from './flightState.js';
import type { OrkMotorRef } from './orkFile.js';

// All fields reconcileIncludedMotor/restateBackedOutMotor can write or delete.
// Keep raw bookkeeping too: captureStageMass intentionally discards stale marks,
// whereas a silent stale-mark retirement must be reversible by this receipt.
const STAGE_FIELDS = ['overrideMass', 'overrideCGX', 'overrideSubcomponentsMass',
  'overrideSubcomponentsCG', 'overrideIncludesMotor', 'statedStageFigures'] as const;
const stageFields = (node: Record<string, unknown>) => Object.fromEntries(
  STAGE_FIELDS.filter(key => Object.hasOwn(node, key)).map(key => [key, node[key]]));

export function otherMountStageChanges(before: RocketTree, after: RocketTree) {
  return before.components.flatMap(stage => {
    const next = after.components.find(s => s.id === stage.id);
    if (!stage.id || !next) return [];
    const oldFields = stageFields(stage);
    const newFields = stageFields(next);
    return stableJson(oldFields) === stableJson(newFields) ? []
      : [{ id: stage.id, before: oldFields, after: newFields }];
  });
}

export function otherMountStagesHold(tree: RocketTree, changes: ReturnType<typeof otherMountStageChanges>) {
  return changes.every(change => {
    const stage = tree.components.find(s => s.id === change.id);
    return stage && stableJson(stageFields(stage)) === stableJson(change.after);
  });
}

export function restoreOtherMountStages(tree: RocketTree, changes: ReturnType<typeof otherMountStageChanges>): RocketTree {
  return { ...tree, components: tree.components.map(stage => {
    const change = changes.find(c => c.id === stage.id);
    if (!change) return stage;
    const next = { ...stage };
    for (const key of STAGE_FIELDS) delete next[key];
    return Object.assign(next, change.before);
  }) };
}

/** Targets/references keep plugged (Auto off) regardless of prescribed delays; other unavailable fixed delays use the browser's default. */
export function otherMountMotor(fresh: MountMotor, old?: MountMotor, ref?: OrkMotorRef): MountMotor {
  const { padMassKg: _mass, padMassWeighedWith: _set, ...unweighed } = fresh;
  const next = { ...unweighed, ignition: old?.ignition ?? fresh.ignition };
  if (fresh.spec.ejectionDelay === Infinity) return withAuto(next, false);
  if (!old && !ref) return next;
  if (old ? old.meta.autoDelay : ref?.autoDelay) return withAuto(next, true);
  const delay = old?.spec.ejectionDelay ?? ref!.delay;
  const options = fresh.meta.availableDelays ?? [];
  if (delay === Infinity || options.includes(delay)) return withDelay(next, delay);
  const finite = options.filter(Number.isFinite);
  const fallback = finite[finite.length - 1] ?? options[options.length - 1];
  return fallback === undefined ? withAuto(withDelay(next, 0), true) : withDelay(next, fallback);
}

function sameMotor(a: MountMotor, b: MountMotor): boolean {
  return motorIdentity(a.meta, a.spec.designation) === motorIdentity(b.meta, b.spec.designation)
    && a.meta.motorId === b.meta.motorId
    && !!a.meta.autoDelay === !!b.meta.autoDelay
    && stableJson({ ...a.spec, ...(a.meta.autoDelay ? { ejectionDelay: null } : {}) })
      === stableJson({ ...b.spec, ...(b.meta.autoDelay ? { ejectionDelay: null } : {}) });
}

/** Nearest physical stage: a parallel booster is not its carrying core stage. */
function peers(tree: RocketTree, sourceId: string) {
  const stages = kernelStageIdByNode(tree);
  const stage = stages.get(sourceId);
  return stage === undefined ? [] : motorMounts(tree).filter(m => stages.get(m.id!) === stage);
}

/** Ignore automatic nozzle following, but retire an offer whose mounts or fit changed. */
export function otherMountShape(tree: RocketTree, sourceId: string): string {
  const stages = kernelStageIdByNode(tree);
  return JSON.stringify(peers(tree, sourceId).map(m => [m.id, stages.get(m.id!), mountName(m),
    Math.round(mountBore(m) * 1000), motorLengthLimit(m)]));
}

export function otherMountPlan(tree: RocketTree, motors: Record<string, MountMotor>, sourceId: string, refs: Record<string, OrkMotorRef> = {}) {
  const source = overrideFor(motors, sourceId);
  const mounts = peers(tree, sourceId);
  const sourceMount = mounts.find(m => m.id === sourceId);
  const targets: { id: string; name: string; replaces?: string; loadLabel?: string }[] = [];
  const skipped: { name: string; reason: 'narrow' | 'bore' | 'short'; limit?: number }[] = [];
  if (!source || !sourceMount) return { targets, skipped };
  const sourceBore = Math.round(mountBore(sourceMount) * 1000);
  const sourceClass = diameterClass(sourceBore);
  for (const mount of mounts) {
    const id = mount.id!;
    if (id === sourceId) continue;
    const name = mountName(mount);
    const bore = Math.round(mountBore(mount) * 1000);
    const limit = motorLengthLimit(mount);
    if (!fitsMount(bore, { diameter: source.spec.diameter * 1000 })) skipped.push({ name, reason: 'narrow' });
    else if (diameterClass(bore) !== sourceClass
      && Math.abs(bore - sourceBore) > MOUNT_TOLERANCE_MM) skipped.push({ name, reason: 'bore' });
    else if (limit !== null && source.spec.length > limit + 1e-9) skipped.push({ name, reason: 'short', limit });
    else {
      const old = overrideFor(motors, id);
      const ref = overrideFor(refs, id);
      const next = otherMountMotor(source, old, ref);
      if (old && sameMotor(old, next)) continue;
      const replaces = old?.label ?? ref?.designation;
      targets.push({ id, name, loadLabel: next.label, ...(replaces ? { replaces } : {}) });
    }
  }
  return { targets, skipped };
}

/** Restore only the affected mounts; absent records/references become absent again. */
export function restoreOtherMounts<T>(current: Record<string, T>, before: Record<string, T>, ids: readonly string[]): Record<string, T> {
  const next = { ...current };
  for (const id of ids) {
    if (Object.hasOwn(before, id)) next[id] = before[id]!;
    else delete next[id];
  }
  return next;
}
