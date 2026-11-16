import type { IgnitionEvent, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { findNode, motorMounts, mountMotorCount, mountName, stageIdByNode } from '../tree/treeModel.js';
import { mountBore } from '../tree/scaleRocket.js';
import { CLUSTER_OPTIONS, clusterCount } from '../tree/cluster.js';
import { boundedLoadoutMotorNames, motorLabelEntry } from './motorLabels.js';
import { overrideFor } from './flightState.js';
import { noteText } from './noteField.js';
import type { BatchMountOption } from './batchSweep.js';
import { mountLoadoutText, namedBatchMounts } from './batchLoadout.js';
import type { BatchMountRecord } from './simReport.js';
import { motorIdentity } from './hardwareMass.js';
import { batchRingSplits } from './batchRing.js';

const and = (names: string[]) => names.length < 3 ? names.join(' and ')
  : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;

/** One definition for the checkbox, disclosure and sweep target set. */
export function batchMatchingMounts(tree: RocketTree, mounts: readonly BatchMountOption[], selected: BatchMountOption) {
  const target = findNode(tree, selected.id);
  const stages = stageIdByNode(tree);
  const stage = stages.get(selected.id);
  return mounts.filter(m => {
    if (m.id === selected.id) return true;
    const node = findNode(tree, m.id);
    return !!target && !!node && stage !== undefined && stages.get(m.id) === stage
      && Math.abs(mountBore(node) - mountBore(target)) <= 0.0005;
  });
}

export function batchTargetsDefault(mounts: readonly BatchMountOption[], motors: Record<string, MotorSpec>,
  metadata: Record<string, MountMotor>, ids: Record<string, string | undefined>) {
  const identity = (id: string) => {
    const spec = overrideFor(motors, id);
    if (!spec) return null;
    const meta = overrideFor(metadata, id)?.meta;
    return overrideFor(ids, id) ?? motorIdentity(meta ?? {}, spec.designation);
  };
  return mounts.every(m => identity(m.id) === identity(mounts[0]!.id));
}

/** Current picker evidence only; completed rows always use their frozen loadout. */
export function batchMountDisclosure(tree: RocketTree, mounts: readonly BatchMountOption[], selected: BatchMountOption,
  motors: Record<string, MotorSpec>, metadata: Record<string, MountMotor>, ids: Record<string, string | undefined>,
  ignitions: Record<string, { event: IgnitionEvent; delay: number }>, targetIds: readonly string[] = [selected.id]) {
  const target = findNode(tree, selected.id);
  const names = new Map(namedBatchMounts(motorMounts(tree).map(m => ({ id: m.id, mountName: mountName(m) })))
    .map(m => [m.id, m.mountName]));
  const nameOf = (id: string) => names.get(id) ?? noteText(mountName(findNode(tree, id)));
  const count = mountMotorCount(tree, selected.id);
  const others = mounts.filter(m => !targetIds.includes(m.id));
  const matchingMounts = batchMatchingMounts(tree, mounts, selected);
  const matching = matchingMounts.some(m => !targetIds.includes(m.id));
  const groups = new Map<string, { motor: string | null; names: string[] }>();
  const keptMounts: BatchMountRecord[] = [];
  const entries = others.flatMap(m => {
    const spec = overrideFor(motors, m.id);
    return spec ? [motorLabelEntry({ spec, meta: {
      ...overrideFor(metadata, m.id)?.meta, label: '', motorId: overrideFor(ids, m.id),
    } })] : [];
  });
  const motorNames = boundedLoadoutMotorNames(entries);
  let index = 0;
  for (const m of others) {
    const spec = overrideFor(motors, m.id);
    const motor = spec && motorNames ? motorNames[index++]! + (overrideFor(ignitions, m.id)?.event === 'never' ? ' (never ignites)' : '') : null;
    const key = JSON.stringify(motor);
    const group = groups.get(key) ?? { motor, names: [] };
    group.names.push(nameOf(m.id));
    groups.set(key, group);
    if (motor !== null) keptMounts.push({ mountId: m.id, mountName: nameOf(m.id), role: 'kept', motor,
      count: mountMotorCount(tree, m.id) });
  }
  const kept = [...groups.values()].filter(g => g.motor !== null);
  const empty = [...groups.values()].find(g => g.motor === null);
  const sentences = [targetIds.length > 1 ? `Candidates fly in ${and(targetIds.map(nameOf))}.`
    : `Candidates fly ${count > 1 ? `×${count} ` : ''}in ${nameOf(selected.id)} only.`];
  if (keptMounts.some(m => m.count > 1)) sentences.push(`Each flight keeps ${mountLoadoutText(keptMounts)}.`);
  else if (kept.length) sentences.push(`${and(kept.map(g => `${and(g.names)} ${g.names.length === 1 ? 'keeps' : 'keep'} ${g.motor!}`))} for every flight.`);
  if (empty) sentences.push(`${and(empty.names)} ${empty.names.length === 1 ? 'stays' : 'stay'} empty.`);
  if (matching) sentences.push('Each row is that mix, not the candidate in every tube.');
  const layout = target?.type === 'innertube' && typeof target['cluster'] === 'string' ? target['cluster'] : 'single';
  const layoutLabel = CLUSTER_OPTIONS.find(([value]) => value === layout)?.[1];
  let mixedUnavailable = layout !== '4-ring' && layout !== '6-ring'
    ? target?.type === 'innertube' && (clusterCount(layout) > 1 || !layoutLabel)
      ? `Mixed batches (2+2, 3+3) need a 4-ring or 6-ring cluster; this mount's layout is ${noteText(layoutLabel ?? layout)}.`
      : mounts.length > 1 || count > 1 ? `Mixed batches (2+2, 3+3) need one inner tube with Cluster layout 4-ring or 6-ring. ${nameOf(selected.id)} ${count > 1
        ? `represents ${count} tubes in the flown design, so each candidate flies in all ${count}.`
        : 'is a single tube, so each candidate flies in it alone.'}` : null
    : null;
  const qualifying = others.find(m => {
    const node = findNode(tree, m.id);
    return node?.type === 'innertube' && (node['cluster'] === '4-ring' || node['cluster'] === '6-ring');
  });
  if (mixedUnavailable && qualifying) mixedUnavailable += ` Choose ${nameOf(qualifying.id)} in the mount picker for mixed batches.`;
  if (targetIds.length > 1) {
    const ring = batchRingSplits(tree, mounts.filter(m => targetIds.includes(m.id)));
    mixedUnavailable = ring.halves ? null
      : `Mixed batches (2+2, 3+3) need four or six single tubes on one ring; these ${targetIds.length} mounts are not evenly spaced around one ring with the same parent and bore.`;
  }
  return { text: (others.length || targetIds.length > 1) && motorNames ? sentences.join(' ') : null,
    matching, mixedUnavailable, matchingMounts,
    matchingLabel: `Use all ${matchingMounts.length} matching mounts (${matchingMounts.map(m => nameOf(m.id)).join(', ')})` };
}
