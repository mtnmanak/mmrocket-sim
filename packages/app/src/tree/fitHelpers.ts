import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { axialLength, positionOf, startFromPosition } from './position.js';
import { num, numOrNull } from './nodeNum.js';
import { applyFieldLimit, fieldLimit } from './schema.js';

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
 *
 * The motor tube is one ALONGSIDE the fins (`mountRadiusAlongside`). This
 * took the first inner tube in the parent that stated a radius, wherever it
 * sat (audit 2026-09-30 review): with a forward payload tube listed before the
 * mount, a 3" airframe's aft fins got a 28.6 mm tab that ran 5.8 mm into the
 * 29 mm mount, and canards reached a mount at the other end of the tube.
 */
export function finTabFit(fin: ComponentNode, parent: ComponentNode | 'stage' | null): FinTabFit | null {
  if (!parent || parent === 'stage' || parent.type !== 'bodytube') return null;
  const outerR = numOrNull(parent, 'outerRadius');
  if (outerR === null) return null;
  const mountR = mountRadiusAlongside(parent, fin);
  // One-shot sizes obey the typed field's limits too (open-items, 22–23
  // September: "Fit shoulder can still write what it repairs").
  const depth = applyFieldLimit(fieldLimit(fin.type, 'tabHeight')!,
    mountR !== null ? outerR - mountR : num(parent, 'thickness', WALL_FALLBACK));
  if (depth <= 0) return null;
  const hasLength = num(fin, 'tabLength', 0) > 0;
  return {
    depth,
    toMount: mountR !== null,
    patch: {
      tabHeight: depth,
      ...(hasLength ? {} : {
        tabLength: applyFieldLimit(fieldLimit(fin.type, 'tabLength')!, axialLength(fin) * NEW_TAB_FRACTION),
      }),
      ...(typeof fin['tabOffsetMethod'] === 'string' ? {} : { tabOffsetMethod: 'middle', tabOffset: 0 }),
    },
  };
}

/**
 * The outer radius (m) of the motor tube beside `fin` that the tab is fitted
 * to, or null when no inner tube that states one sits alongside the fin.
 *
 * "Alongside" is desktop's own test (FinSetConfig.isComponentInsideFinSpan on
 * the fin's ROOT chord, term for term): a tube that only touches either end of
 * the root is not alongside it. Stations are in the parent's frame.
 *
 * Among the tubes alongside, the widest MOTOR tube — one marked as a motor
 * mount, or holding one (a 38 mm tube around a 29 mm adapter) — and only when
 * there is none, the widest tube of all, which is desktop's whole rule
 * (calculateAutoTab keeps the largest outer radius alongside). Desktop's rule
 * alone loses the motor tube to a wider tube beside it — measured on the
 * RockSim corpus, 25 fin sets: 20 in kits whose piston, insulator tube or
 * sleeve overlaps the fins' root (Hydra, Matrix, Pterodactyl, 1/2-scale
 * Patriot, Black Brant VC) fell from the motor tube's 12.8-68.5 mm to
 * 1.6-46.3 mm, and 5 whose full-width inner tube left no depth lost the button.
 * Black_Brant_VC.rkt's own 18.0 mm tab passes its sleeve to the motor tube.
 * The button promises the motor tube; this keeps it.
 */
function mountRadiusAlongside(parent: ComponentNode, fin: ComponentNode): number | null {
  const pLen = axialLength(parent);
  const span = (n: ComponentNode): [number, number] => {
    const len = axialLength(n);
    const start = startFromPosition(positionOf(n), len, pLen);
    return [start, start + len];
  };
  const holdsMount = (n: ComponentNode): boolean => (n.children ?? [])
    .some((c) => c.type === 'innertube' && (c['motorMount'] === true || holdsMount(c)));
  const [finFore, finAft] = span(fin);
  let widest: number | null = null;
  let widestMotor: number | null = null;
  for (const tube of parent.children ?? []) {
    if (tube.type !== 'innertube') continue;
    const r = numOrNull(tube, 'outerRadius');
    if (r === null) continue;
    const [fore, aft] = span(tube);
    const alongside = (fore >= finFore && fore < finAft) || (aft > finFore && aft <= finAft)
      || (fore <= finFore && aft >= finAft);
    if (!alongside) continue;
    widest = Math.max(widest ?? r, r);
    if (tube['motorMount'] === true || holdsMount(tube)) widestMotor = Math.max(widestMotor ?? r, r);
  }
  return widestMotor ?? widest;
}

export interface ShoulderFit {
  /** The fitted shoulder radius (m), bounded by the field's hard limits. */
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
  const innerR = applyFieldLimit(fieldLimit(nose.type, 'shoulderRadius')!, outerR - num(tube, 'thickness', 0));
  return { innerR, patch: { shoulderRadius: innerR } };
}
