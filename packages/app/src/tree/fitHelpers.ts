import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { axialLength } from './position.js';
import { num, numOrNull } from './nodeNum.js';

/**
 * The property panel's two one-shot FIT buttons — "Fit tab to motor tube" and
 * "Fit shoulder to tube ⌀" — as rules: what each would write, or null where
 * the panel does not offer it. Moved out of PropertyPanel's render body
 * (audit 2026-09-22, extractions carried from 8 September) so they can be
 * tested without a panel; PropertyPanel.oneShots.test.tsx pins the buttons.
 *
 * The readers are nodeNum's (the house reader): identical to the inline
 * `typeof … === 'number'` reads they replace for every finite value, while a
 * NaN counts as a missing field, as audit row 522 asks — where a missing
 * radius withholds the button, so does a NaN one, instead of offering a NaN
 * depth.
 */

/** A new fin tab spans this fraction of the root chord. */
const NEW_TAB_FRACTION = 0.6;
/** The tube wall assumed when a fin's tube states none (m). */
const WALL_FALLBACK = 0.001;

export interface FinTabFit {
  /** Tab depth (m): from the tube's outside to the motor tube, or the wall. */
  depth: number;
  /** Whether it reaches a motor tube (false: the tube wall, no mount found). */
  toMount: boolean;
  /** The one write. */
  patch: Partial<ComponentNode>;
}

/**
 * Tab depth so the tab just touches the motor-mount tube (the owner's
 * real-build default); the tube wall when there is no mount. Only on a fin set
 * whose parent is a body tube with a stated radius, and only when that leaves
 * a depth to fill.
 *
 * A fin with no tab yet gets one 60 % of the ROOT chord — `axialLength`, the
 * kernel's length: rootChord for a trapezoid/ellipse, the last point's x for a
 * freeform fin. This used to take the outline's furthest-aft x, so on a fin
 * whose tip overhangs its root the "60 %" tab came out as 60 % of the overhang
 * span: 288 mm on the 361 mm root of `ninja_4in_54mm-MMT.ork`'s fin shape, 80 %
 * of the root it promised. A tab offset method already chosen is kept.
 */
export function finTabFit(fin: ComponentNode, parent: ComponentNode | 'stage' | null): FinTabFit | null {
  if (!parent || parent === 'stage' || parent.type !== 'bodytube') return null;
  const outerR = numOrNull(parent, 'outerRadius');
  if (outerR === null) return null;
  // The first inner tube that states a radius is the motor mount.
  const mountR = (parent.children ?? [])
    .map((c) => (c.type === 'innertube' ? numOrNull(c, 'outerRadius') : null))
    .find((r) => r !== null) ?? null;
  const depth = mountR !== null ? outerR - mountR : num(parent, 'thickness', WALL_FALLBACK);
  if (depth <= 0) return null;
  const hasLength = num(fin, 'tabLength', 0) > 0;
  return {
    depth,
    toMount: mountR !== null,
    patch: {
      tabHeight: depth,
      ...(hasLength ? {} : { tabLength: axialLength(fin) * NEW_TAB_FRACTION }),
      ...(typeof fin['tabOffsetMethod'] === 'string' ? {} : { tabOffsetMethod: 'middle', tabOffset: 0 }),
    },
  };
}

export interface ShoulderFit {
  /** The inner radius (m) of the tube behind the nose — the shoulder it sets. */
  innerR: number;
  /** The one write. */
  patch: Partial<ComponentNode>;
}

/**
 * Snap a nose cone's shoulder into the tube behind it: the next body tube
 * among the nose's SIBLINGS — the enclosing stage's children, or the rocket's
 * top level (`tree.components` holds only stage nodes since v0.009). Never a
 * tube forward of the nose; null when there is none, or it states no radius.
 * A tube with no stated wall is its own outer radius.
 */
export function shoulderFit(
  tree: RocketTree, nose: ComponentNode, parent: ComponentNode | 'stage' | null,
): ShoulderFit | null {
  const siblings = parent && parent !== 'stage' ? (parent.children ?? []) : tree.components;
  const idx = siblings.findIndex((n) => n.id === nose.id);
  const tube = siblings.slice(idx + 1).find((n) => n.type === 'bodytube');
  if (!tube) return null;
  const outerR = numOrNull(tube, 'outerRadius');
  if (outerR === null) return null;
  const innerR = outerR - num(tube, 'thickness', 0);
  return { innerR, patch: { shoulderRadius: innerR } };
}
