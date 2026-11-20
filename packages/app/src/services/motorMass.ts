import { noticeEqual } from '../prefs/units.js';
import { MAX_STATED_MASS_KG } from '../tree/schema.js';

/** File and catalogue motor weights share the same gram-based contract. */
export function usableMotorMasses(t: unknown, p: unknown): boolean {
  return typeof t === 'number' && typeof p === 'number' && Number.isFinite(t) && Number.isFinite(p)
    && t > 0 && p > 0 && t / 1000 <= MAX_STATED_MASS_KG
    && (p <= t || noticeEqual(p / 1000, t / 1000));
}
