import type { ComponentNode } from '@online-openrocket/engine';

/**
 * One place that decides what a camera shroud's shape and seating ARE, so the
 * side view, the end-on view, the 3D mesh, the physics lowering and the `.ork`
 * writer cannot drift apart.
 *
 * They already had: before v0.088 the property panel showed "Streamlined" for a
 * shroud with no `fairingShape` while all three readers independently fell back
 * to half-round. Four copies of a default is three too many.
 */

export type EndShape = 'streamlined' | 'halfround' | 'box';

const END_SHAPES = new Set<EndShape>(['streamlined', 'halfround', 'box']);

const asEnd = (v: unknown, fallback: EndShape): EndShape =>
  (typeof v === 'string' && END_SHAPES.has(v as EndShape)) ? v as EndShape : fallback;

/**
 * The two end shapes, with the legacy migration.
 *
 * A file written before v0.088 carries a single `fairingShape` for the whole
 * part. It applies to BOTH ends, so an existing shroud is drawn and flown
 * exactly as it was — the split adds an option, it does not restyle anyone's
 * design.
 *
 * A shroud carrying NO shape key at all falls back to **half-round on both
 * ends**, which is what every reader independently fell back to before v0.088
 * (TreeSchematic, treeModel and the .ork writer each hard-coded it). That is
 * reachable: the `.ork` reader only sets the key when the tag is present, so an
 * old file missing `<fairingshape>` produces exactly this node. Falling back to
 * the NEW default pair instead would silently change such a shroud's drag
 * coefficient from 0.55 to 0.40 and reshape its strake — a numbers move on a
 * design nobody touched. The new pair belongs to shrouds someone CREATES, and
 * `defaultParams('fairing')` sets it explicitly for those.
 *
 * Do NOT drop the `fairingShape` read. That is the exact shape of the v0.087
 * data loss: a value written by an older version, ignored on import, and
 * overwritten on the next save.
 */
export function shroudEnds(n: ComponentNode): { fore: EndShape; aft: EndShape } {
  const legacy = typeof n['fairingShape'] === 'string'
    ? asEnd(n['fairingShape'], 'halfround')
    : 'halfround';
  return {
    fore: asEnd(n['fairingForeShape'], legacy),
    aft: asEnd(n['fairingAftShape'], legacy),
  };
}

/**
 * Is the underside cut to the curve of the tube?
 *
 * ABSENT reads as TRUE — see schema.CONFORMAL. Every reader must use this
 * function rather than testing the key, or a file saved before the field
 * existed will be conformal in one view and flat in another.
 */
export function isConformal(n: ComponentNode): boolean {
  return n['conformal'] !== false;
}

/**
 * Half the angle the shroud subtends at the body axis, radians.
 *
 * CLAMPED, and the clamp is not theoretical: the app's own defaults are a
 * 25 mm-wide shroud on a 24 mm-diameter tube, so `halfWidth / radius` is 1.04
 * and an unclamped `asin` returns NaN — which in SVG is an invisible element
 * and in three.js is a geometry with a broken bounding sphere. A shroud wider
 * than its tube is a real thing people build (a GoPro on a 38 mm minimum
 * diameter bird); it wraps at most half way round, and that is what π/2 means
 * here.
 */
export function shroudHalfAngle(bodyRadius: number, width: number): number {
  if (!(bodyRadius > 0) || !(width > 0)) return 0;
  return Math.asin(Math.min(1, width / 2 / bodyRadius));
}

/**
 * The frontal area a surface-mounted bump really blocks, m².
 *
 * `width * height` — what the drag model charges today — is the area of a bump
 * on a FLAT wall. A rocket's wall is not flat: the shroud's underside lies on
 * the tangent plane, and between it and the tube there is a dead-air gap the
 * flow does not get to use either. The obstruction runs from the TUBE SURFACE,
 * so it is `width * height + gap`, where the gap is the exact area between the
 * tangent chord and the arc:
 *
 *   gap = 2aR − R²·asin(a/R) − a·√(R²−a²),   a = width/2
 *
 * (Sanity: at a = R that is R²(2 − π/2), the area between a tangent line and a
 * semicircle.) A conformal shroud fills the gap with material instead of dead
 * air, so the blockage is the same either way — this is a body-curvature
 * correction, not a conformal-vs-flat one.
 *
 * Measured under-charge against `width * height`: 5.0 % on the app's default
 * shroud (25×20 mm on a 54 mm body), 11.9 % for a GoPro-class 45×30 mm on the
 * same body, 24.5 % for a low wide shroud on a BT-50. It grows as the shroud
 * gets wider relative to the tube and as it gets lower.
 *
 * LIVE SINCE v0.090 — `engineTree`'s 'fairing' branch charges the shroud's CD
 * override against this area, using the radius of the body the shroud is
 * MOUNTED ON. Eric, 2026-08-31c: *"is this fixed or waiting on my call? If it
 * is waiting on my call, fix it."* Every design carrying a shroud gained drag
 * on that release; measured in flight beforehand, that is +0.57 % to +3.1 % on
 * total CD and −0.15 % to −1.1 % on apogee, subsonic.
 *
 * What it does and does not claim: it makes the AREA right for a coefficient
 * Hoerner measured on a flat wall. It does not improve the COEFFICIENT, which
 * still has no wind-tunnel anchor of its own (the nearest anchors are the
 * Saturn I SA-2/SA-4 flight comparison and Buckeye's shroud CFD, both on the
 * area-ratio method rather than on this Cd table).
 */
export function surfaceBumpFrontalArea(
  bodyRadius: number, width: number, height: number,
): number {
  const flat = Math.max(0, width) * Math.max(0, height);
  if (!(bodyRadius > 0) || !(width > 0)) return flat;
  const a = Math.min(width / 2, bodyRadius);
  const gap = 2 * a * bodyRadius
    - bodyRadius * bodyRadius * Math.asin(a / bodyRadius)
    - a * Math.sqrt(Math.max(0, bodyRadius * bodyRadius - a * a));
  return flat + gap;
}
