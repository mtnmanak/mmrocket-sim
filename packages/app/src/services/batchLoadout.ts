import type { BatchMountRecord, SimRun } from './simReport.js';
import { validDelayResolution, type MountDelayRecord } from './autoDelaySolver.js';
import { boundedLoadoutMotorNames, motorEntryForIdentity, labelCatalogue } from './motorLabels.js';
import { noteText } from './noteField.js';

/** Persisted evidence is accepted whole or discarded; never infer missing roles. */
export function validBatchMounts(value: unknown): value is BatchMountRecord[] {
  if (!Array.isArray(value) || value.length > 64) return false;
  const seen = new Set<string>();
  const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 1024 && noteText(v).length <= 1024;
  return value.every((m: unknown) => {
    if (!m || typeof m !== 'object') return false;
    const r = m as BatchMountRecord;
    if (!text(r.mountId) || !r.mountId || seen.has(r.mountId) || !text(r.mountName) || !noteText(r.mountName).trim()
      || !['candidate', 'kept', 'empty'].includes(r.role)
      || (r.role === 'empty' ? r.motor !== null : !text(r.motor) || !noteText(r.motor).trim())
      || !Number.isInteger(r.count) || r.count < 1 || r.count > 1000
      || (r.ignition !== undefined && (r.ignition !== 'never' || r.role === 'empty'))) return false;
    seen.add(r.mountId);
    return true;
  }) && value.some(m => m.role === 'candidate');
}

/** Number duplicate display names in design order, before any role filtering. */
export function namedBatchMounts<T extends { mountName: string }>(mounts: readonly T[]): T[] {
  const names = mounts.map(m => noteText(m.mountName).trim().replace(/\s+/g, ' '));
  const totals = new Map<string, number>();
  for (const name of names) totals.set(name, (totals.get(name) ?? 0) + 1);
  const reserved = new Set(names);
  const seen = new Map<string, number>();
  return mounts.map((m, i) => {
    const name = names[i]!;
    let index = (seen.get(name) ?? 0) + 1;
    if (totals.get(name)! === 1) return { ...m, mountName: name };
    while (reserved.has(`${name} ${index}`)) index++;
    seen.set(name, index);
    const mountName = `${name} ${index}`;
    reserved.add(mountName);
    return { ...m, mountName };
  });
}

/** Format already-named mounts; role subsets must never allocate names again. */
export function mountLoadoutText(mounts: readonly BatchMountRecord[]): string {
  const groups = new Map<string, BatchMountRecord[]>();
  for (const m of mounts) {
    const key = JSON.stringify([m.motor, m.ignition]);
    const group = groups.get(key) ?? [];
    group.push(m);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!;
    if (first.motor === null) return `${group.map(m => noteText(m.mountName)).join(', ')} empty`;
    const ignition = first.ignition === 'never' ? ' (never ignites)' : '';
    // With unequal counts the multiplier must stay beside its own mount.
    const unequal = group.some(m => m.count !== first.count);
    const locations = group.map((m, i) => `${unequal || (i === 0 && m.count > 1) ? `×${m.count} ` : ''}${i === 0 || unequal ? 'in ' : ''}${noteText(m.mountName)}`);
    return `${noteText(first.motor)}${ignition} ${locations.join(', ')}`;
  }).join('; ');
}

type LoadoutRun = Pick<SimRun, 'batch' | 'batchMounts' | 'delayResolution'>;
const legacyLabels = new WeakMap<LoadoutRun, { evidence: LoadoutRun['delayResolution']; text: string | null }>();

/** Delay vectors use solver order; frozen batch names belong to mount ids. */
export function delayReportMotorNames(mounts: readonly MountDelayRecord[], run: Pick<SimRun, 'batch' | 'batchMounts'> = {},
  mountOrder: readonly string[] = []): Map<string, string | null> | null {
  if (run.batch === true && validBatchMounts(run.batchMounts)) {
    return new Map(run.batchMounts.map(m => [m.mountId, m.motor]));
  }
  // Legacy evidence still needs identity resolution. Use design order where
  // available, with a stable id order for mounts no longer in today's tree.
  const order = new Map(mountOrder.map((id, i) => [id, i]));
  const ordered = [...mounts].sort((a, b) => (order.get(a.mountId) ?? Infinity) - (order.get(b.mountId) ?? Infinity)
    || (a.mountId < b.mountId ? -1 : a.mountId > b.mountId ? 1 : 0));
  const catalogue = labelCatalogue();
  const names = boundedLoadoutMotorNames(ordered.map(m => motorEntryForIdentity(m.motorIdentity, catalogue)), catalogue);
  return names ? new Map(ordered.map((m, i) => [m.mountId, names[i]!])) : null;
}

export function batchLoadoutText(run: LoadoutRun): string | null {
  if (run.batch !== true) return null;
  if (validBatchMounts(run.batchMounts)) {
    // A homogeneous sweep can now target several mounts; separate-ring mixes
    // also need their tube names. Legacy split-cluster group labels already
    // carry their counts and retain their compact configuration heading.
    const severalTargets = run.batchMounts.length > 1 && (run.batchMounts.every(m => m.motor === run.batchMounts![0]!.motor)
      || run.batchMounts.every(m => m.count === 1));
    return severalTargets || run.batchMounts.some(m => m.role !== 'candidate')
      ? mountLoadoutText(namedBatchMounts(run.batchMounts)) : null;
  }
  const cached = legacyLabels.get(run);
  if (cached && cached.evidence === run.delayResolution) return cached.text;
  const text = legacyLoadoutText(run.delayResolution);
  legacyLabels.set(run, { evidence: run.delayResolution, text });
  return text;
}

function legacyLoadoutText(legacy: LoadoutRun['delayResolution']): string | null {
  // Check size limits before resolving identities or constructing any display text.
  if (!legacy || !Array.isArray(legacy.mounts) || legacy.mounts.length < 2 || legacy.mounts.length > 64
    || !legacy.mounts.every(m => m && [m.mountId, m.mountName, m.motorIdentity]
      .every(v => typeof v === 'string' && v.length <= 1024 && noteText(v).trim())) || !validDelayResolution(legacy)) return null;
  const catalogue = labelCatalogue();
  const motors = boundedLoadoutMotorNames(legacy.mounts.map(m => motorEntryForIdentity(m.motorIdentity, catalogue)), catalogue);
  if (!motors) return null;
  // Solver order cannot establish design-order numbers. Repeat recorded names.
  return mountLoadoutText(legacy.mounts.map((m, i) => ({
    mountId: m.mountId, mountName: m.mountName, role: 'kept',
    motor: motors[i]!, count: 1,
  })));
}

/** New exports need explicit roles; legacy delay vectors cannot identify a candidate. */
export function batchOtherMountsText(run: LoadoutRun): string {
  return run.batch === true && validBatchMounts(run.batchMounts)
    ? mountLoadoutText(namedBatchMounts(run.batchMounts).filter(m => m.role !== 'candidate')) : '';
}
