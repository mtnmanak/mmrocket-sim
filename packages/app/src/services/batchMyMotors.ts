import { fitsMount, sortMotors, type MotorDbEntry } from './motorDb.js';
import { noteText } from './noteField.js';
import { noticeQuantity, type UnitSelection } from '../prefs/units.js';
import { batchMotorNames, type BatchMountOption } from './batchSweep.js';

export const BATCH_MY_MOTORS_KEY = 'online-openrocket.batch-my-motors.v1';

/** Browser-owned ids, including imported ex: ids; malformed storage is empty. */
export function loadBatchMyMotors(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(BATCH_MY_MOTORS_KEY) ?? '[]');
    return Array.isArray(value) && value.every(id => typeof id === 'string') ? [...new Set(value as string[])] : [];
  } catch { return []; }
}

export function saveBatchMyMotors(ids: readonly string[]): void {
  try { localStorage.setItem(BATCH_MY_MOTORS_KEY, JSON.stringify(ids)); } catch { /* best-effort */ }
}

/** Owned motors ignore catalogue filters, but must fit every target's bore and length. */
export function batchMyCandidates(ids: readonly string[], motors: MotorDbEntry[], targets: readonly BatchMountOption[], units: UnitSelection) {
  const byId = new Map(motors.map(m => [m.motorId, m]));
  const names = batchMotorNames(motors);
  const candidates: MotorDbEntry[] = [];
  const excluded: string[] = [];
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) { excluded.push(`${noteText(id)}: unavailable in the catalogue or imported EX library`); continue; }
    const wide = targets.find(t => !fitsMount(t.diameterMm, m));
    const long = targets.find(t => t.maxMotorLengthM !== null && m.length / 1000 > t.maxMotorLengthM + 1e-9);
    if (wide) excluded.push(`${noteText(names.get(id)!)}: too wide for ${noteText(wide.label)} (${noticeQuantity('motorDimensions', wide.diameterMm / 1000, units, { against: m.diameter / 1000 })} bore)`);
    else if (long) excluded.push(`${noteText(names.get(id)!)}: too long for ${noteText(long.label)} (max ${noticeQuantity('motorDimensions', long.maxMotorLengthM!, units, { against: m.length / 1000 })})`);
    else candidates.push(m);
  }
  return { candidates: sortMotors(candidates, 'totImpulseNs', -1), excluded };
}
