import type { ComponentNode } from '@online-openrocket/engine';

/**
 * THE SPILL-HOLE CEILING — a vent cannot be bigger than the canopy it is cut
 * in. One rule, read by the two places that must agree on it: `engineTree`
 * (tree/treeModel.ts), which clamps the hole it FLIES when it scales the
 * canopy's Cd by 1 − (hole/D)², and the property panel, which caps the spill
 * hole a user can type or slide at the same figure.
 *
 * They were two copies of `0.95 · D` with the same 0.3 m fallback (audit
 * 2026-09-22, carried from 8 September). The panel's copy was added because
 * the kernel's clamp was silent — the panel could show a 1 m vent on a 0.3 m
 * chute that the rocket was not flying, on the one control that scales descent
 * Cd — and a ceiling kept in step by a comment is one edit from disagreeing.
 *
 * `services/recoverySizing.ts` mirrors the flown formula for its sizing lines
 * (canopyCdA, ventFactor) from a different reader — a catalogue row, and a
 * design chute with no 0.3 m fallback — and keeps its own.
 */

/** A canopy with no stated diameter is flown at this (m) — engineTree's fallback. */
export const CANOPY_DIAMETER_FALLBACK = 0.3;
/** The widest vent flown, as a fraction of the canopy's diameter. */
export const SPILL_HOLE_MAX_FRACTION = 0.95;

export interface VentLimit {
  /** The canopy diameter the vent is measured against (m). */
  diameter: number;
  /** The widest hole it can carry (m). */
  maxHole: number;
}

/**
 * The canopy diameter a vent is measured against, and the widest vent it can
 * carry — or null where the canopy states a diameter no vent fits: 0, a
 * negative, NaN. That null is engineTree's divide guard (its note has the
 * whole story: a diameter STORED as a literal 0 is a `typeof 'number'` hit, and
 * (0/0)² is NaN).
 *
 * A `typeof` read and not nodeNum's `num`, deliberately: this is the reader the
 * kernel has always been handed, and a NaN or infinite diameter keeps doing
 * exactly what it did (no vent scaling / no ceiling). Folding it into `num`
 * would change what the kernel flies for one — a decision for audit row 522's
 * sweep, not for an extraction.
 */
export function ventLimit(canopy: ComponentNode): VentLimit | null {
  const d = canopy['diameter'];
  const diameter = typeof d === 'number' ? d : CANOPY_DIAMETER_FALLBACK;
  return diameter > 0 ? { diameter, maxHole: diameter * SPILL_HOLE_MAX_FRACTION } : null;
}
