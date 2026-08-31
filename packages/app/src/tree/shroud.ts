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
 * design. Only a shroud that has never had a shape at all gets the new default
 * pair (streamlined fore, domed aft: a rear-facing camera, which is both the
 * common case and the one that puts the tapered end into the wind).
 *
 * Do NOT drop the `fairingShape` read. That is the exact shape of the v0.087
 * data loss: a value written by an older version, ignored on import, and
 * overwritten on the next save.
 */
export function shroudEnds(n: ComponentNode): { fore: EndShape; aft: EndShape } {
  const legacy = typeof n['fairingShape'] === 'string'
    ? asEnd(n['fairingShape'], 'halfround')
    : undefined;
  return {
    fore: asEnd(n['fairingForeShape'], legacy ?? 'streamlined'),
    aft: asEnd(n['fairingAftShape'], legacy ?? 'halfround'),
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
 * NOT YET WIRED INTO THE DRAG MODEL — it would move the numbers of every design
 * carrying a shroud, and shroud drag is a queued question of its own (Eric,
 * 2026-08-31: *"at some point, we need to answer the physics questions for
 * these objects"*). It lives here, tested, so the decision is a one-line change
 * rather than a re-derivation.
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
