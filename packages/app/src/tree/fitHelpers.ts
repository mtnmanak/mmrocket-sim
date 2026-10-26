import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { axialLength, positionOf, startFromPosition } from './position.js';
import { num, numOrNull } from './nodeNum.js';
import { applyFieldLimit, fieldLimit } from './schema.js';
import { isTailCone } from './tailCone.js';
import { kernelNum } from './kernelDefaults.js';
import { clusterCount } from './cluster.js';
import { innerTubeSections } from './tubeLayout.js';
import { finCountOf } from './counts.js';
import { finTabFront } from './finTab.js';

/**
 * The property panel's two one-shot FIT buttons — "Fit tab to motor tube" and
 * "Fit shoulder to tube ⌀" — as rules: what each would write, or null where
 * the panel does not offer it (and a shoulder fit marked `solid` where the
 * panel refuses it, as railButtonPlacement marks an infeasible pair). Moved
 * out of PropertyPanel's render body (audit 2026-09-22, extractions carried
 * from 8 September) so they can be tested without a panel;
 * PropertyPanel.oneShots.test.tsx pins the buttons.
 *
 * The readers are nodeNum's (the house reader): identical to the inline
 * `typeof … === 'number'` reads they replace for every finite value, while a
 * NaN counts as a missing field, as audit row 522 asks — where a missing
 * radius withholds the button, so does a NaN one, instead of offering a NaN
 * depth.
 */

/** A new fin tab spans this fraction of the root chord. */
const NEW_TAB_FRACTION = 0.6;

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
 *
 * Not on a SOLID tube either (Solid (filled), a dowel): it has no wall for a
 * tab to pass through and no motor tube inside it, so there is nothing to fit
 * — withheld, as on a nose cone or transition, which can be solid too. Read
 * through the wall a solid tube states, it offered that wall as the depth.
 */
export function finTabFit(fin: ComponentNode, parent: ComponentNode | 'stage' | null): FinTabFit | null {
  if (!parent || parent === 'stage' || parent.type !== 'bodytube') return null;
  if (parent['filled'] === true) return null;
  const outerR = numOrNull(parent, 'outerRadius');
  if (outerR === null) return null;
  const mountR = mountRadiusAlongside(parent, fin);
  if (mountR === undefined) return null;
  // One-shot sizes obey the typed field's limits too (open-items, 22–23
  // September: "Fit shoulder can still write what it repairs").
  const depth = applyFieldLimit(fieldLimit(fin.type, 'tabHeight')!,
    mountR !== null ? outerR - mountR : kernelNum(parent, 'thickness'));
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
 * to, or null when no usable centred inner tube sits alongside the fin.
 *
 * "Alongside" is desktop's own test (FinSetConfig.isComponentInsideFinSpan on
 * the fin's ROOT chord, term for term): a tube that only touches either end of
 * the root is not alongside it. Stations are in the parent's frame.
 *
 * Among the tubes alongside, the widest MOTOR tube — one marked as a motor
 * mount, or holding one (a 38 mm tube around a 29 mm adapter). Desktop's rule
 * alone loses the motor tube to a wider tube beside it — measured on the
 * RockSim corpus, 25 fin sets: 20 in kits whose piston, insulator tube or
 * sleeve overlaps the fins' root (Hydra, Matrix, Pterodactyl, 1/2-scale
 * Patriot, Black Brant VC) fell from the motor tube's 12.8-68.5 mm to
 * 1.6-46.3 mm, and 5 whose full-width inner tube left no depth lost the button.
 * Black_Brant_VC.rkt's own 18.0 mm tab passes its sleeve to the motor tube.
 * The button promises the motor tube; this keeps it. Without a flagged mount,
 * use the widest centred inner tube alongside, as desktop does.
 */
function mountRadiusAlongside(parent: ComponentNode, fin: ComponentNode): number | null | undefined {
  const pLen = axialLength(parent);
  const span = (n: ComponentNode): [number, number] => {
    const len = axialLength(n);
    const start = startFromPosition(positionOf(n), len, pLen);
    return [start, start + len];
  };
  const holdsMount = (n: ComponentNode): boolean => (n.children ?? [])
    .some((c) => (c.type === 'innertube' || c.type === 'tubecoupler') && (c['motorMount'] === true || holdsMount(c)));
  // Conservative radial bound in the containing tube's frame, including any
  // descendants. A contained offset mount cannot change the holder's exterior.
  const [finFore, finAft] = span(fin);
  const obstacles: ReturnType<typeof innerTubeSections> = [];
  let widestMotor: number | null = null;
  let widest: number | null = null;
  for (const tube of parent.children ?? []) {
    if (tube.type !== 'innertube' && tube.type !== 'tubecoupler') continue;
    const [fore, aft] = span(tube);
    const alongside = (fore >= finFore && fore < finAft) || (aft > finFore && aft <= finAft)
      || (fore <= finFore && aft >= finAft);
    const isMount = tube['motorMount'] === true || holdsMount(tube);
    const sections = innerTubeSections(tube, pLen).filter(s => s.end > finFore && s.start < finAft);
    if (!alongside || tube.type === 'tubecoupler') {
      if (sections.length && isMount) return undefined;
      obstacles.push(...sections);
      continue;
    }
    const r = numOrNull(tube, 'outerRadius');
    if (r === null) { obstacles.push(...sections); continue; }
    // The tab contacts this tube's exterior, not the mounts inside its holder.
    if (num(tube, 'radialPosition', 0) !== 0 || clusterCount(tube['cluster'] as string | undefined) > 1
      || sections.some(s => Math.hypot(s.y, s.z) + s.r > r + 1e-9)) {
      if (isMount) return undefined;
      obstacles.push(...sections);
      continue;
    }
    widest = Math.max(widest ?? r, r);
    if (isMount) widestMotor = Math.max(widestMotor ?? r, r);
  }
  const selected = widestMotor ?? widest;
  if (selected !== null) {
    const outer = num(parent, 'outerRadius', 0);
    const root = axialLength(fin), half = root / 2;
    const tabLength = num(fin, 'tabLength', 0) > 0 ? num(fin, 'tabLength', 0) : root * NEW_TAB_FRACTION;
    const tab = { ...fin, tabLength,
      ...(typeof fin['tabOffsetMethod'] === 'string' ? {} : { tabOffsetMethod: 'middle', tabOffset: 0 }) };
    const tabFront = Math.max(0, finTabFront(tab, root));
    const tabAft = Math.min(root, finTabFront(tab, root) + tabLength);
    const cant = Math.max(-Math.PI / 12, Math.min(Math.PI / 12, num(fin, 'cant', 0)));
    const c = Math.cos(cant), tangent = Math.tan(cant);
    const count = finCountOf(fin);
    for (let i = 0; i < count; i++) {
      const angle = num(fin, 'rotation', 0) + 2 * Math.PI * i / count;
      for (const s of obstacles) {
        const fore = Math.max(s.start, finFore + half + (tabFront - half) * c);
        const aft = Math.min(s.end, finFore + half + (tabAft - half) * c);
        if (aft <= fore) continue;
        const along = s.y * Math.cos(angle) + s.z * Math.sin(angle);
        const across = s.z * Math.cos(angle) - s.y * Math.sin(angle);
        const z0 = -(fore - finFore - half) * tangent, z1 = -(aft - finFore - half) * tangent;
        const nearestAcross = Math.min(Math.max(z0, z1), Math.max(Math.min(z0, z1), across));
        const nearest = Math.min(outer, Math.max(selected, along));
        if (Math.hypot(along - nearest, across - nearestAcross) < s.r + kernelNum(fin, 'thickness') / (2 * c)) return undefined;
      }
    }
  }
  return selected;
}

export interface ShoulderFit {
  /** The fitted shoulder radius (m), bounded by the field's hard limits. */
  innerR: number;
  /** The one write. */
  patch: Partial<ComponentNode>;
  /**
   * The tube is SOLID (Solid (filled)): its bore is 0, and the panel refuses
   * the fit and says why instead of offering a zero shoulder.
   */
  solid?: true;
}

/**
 * Snap a nose cone's shoulder into the tube behind it: the next body tube
 * among the nose's SIBLINGS — the enclosing stage's children, or the rocket's
 * top level (`tree.components` holds only stage nodes since v0.009). Never a
 * tube forward of the nose; null when there is none, or it states no radius.
 * A tube with no stated wall uses the kernel's default. A TAIL CONE's shoulder
 * is at its front (tailCone.ts), so it fits the nearest body tube AHEAD.
 *
 * A SOLID tube (Solid (filled)) has no bore — BodyTube.getInnerRadius is 0
 * when filled — so its fit is a zero shoulder marked `solid`, which the panel
 * refuses with its reason. Read through the wall a solid tube states, the fit
 * sized the shoulder to that wall, and to the tube's outside for the .ork
 * reader's solid tube, which states none.
 */
export function shoulderFit(
  tree: RocketTree, nose: ComponentNode, parent: ComponentNode | 'stage' | null,
): ShoulderFit | null {
  const siblings = parent && parent !== 'stage' ? (parent.children ?? []) : tree.components;
  const idx = siblings.findIndex((n) => n.id === nose.id);
  const toward = isTailCone(nose) ? siblings.slice(0, Math.max(idx, 0)).reverse() : siblings.slice(idx + 1);
  const tube = toward.find((n) => n.type === 'bodytube');
  if (!tube) return null;
  if (tube['filled'] === true) return { innerR: 0, patch: { shoulderRadius: 0 }, solid: true };
  const outerR = numOrNull(tube, 'outerRadius');
  if (outerR === null) return null;
  const innerR = applyFieldLimit(fieldLimit(nose.type, 'shoulderRadius')!, outerR - kernelNum(tube, 'thickness'));
  return { innerR, patch: { shoulderRadius: innerR } };
}
