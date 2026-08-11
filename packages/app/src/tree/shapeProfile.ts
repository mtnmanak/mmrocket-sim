/**
 * Nose-cone / transition radius profiles — an exact port of the carved
 * kernel's Transition.Shape.getRadius() implementations and the
 * Transition.getRadius() outer-profile logic (incl. the clipped path), so the
 * 2D schematic and the 3D view draw the same geometry the engine flies.
 *
 * Kernel semantics mirrored here (issue batch 2026-08-11a):
 * - A nose cone is never clipped (NoseCone.isClipped() → false): its profile
 *   is Shape.getRadius(x, aftRadius, length, param) directly.
 * - A transition built by the bridge keeps the kernel default clipped state,
 *   which setShapeType() leaves at type.isClippable() — so ellipsoid / power /
 *   haack transitions simulate (and therefore must draw) CLIPPED: the profile
 *   is the continuation of the virtual nose shape, cut off at the fore radius.
 *   Conical / ogive / parabolic transitions are never clippable.
 */

const MINFEATURE = 0.001;
const CLIP_PRECISION = 0.0001;

const safeSqrt = (v: number): number => Math.sqrt(Math.max(0, v));
const pow2 = (x: number): number => x * x;
const pow3 = (x: number): number => x * x * x;

/** Mirrors Transition.Shape.defaultParameter() in the carved kernel. */
export function shapeParamDefault(shape: string): number {
  switch (shape) {
    case 'ogive':
    case 'parabolic':
      return 1.0;
    case 'power':
      return 0.5;
    default:
      return 0.0; // conical, ellipsoid, haack
  }
}

/** Mirrors Shape.usesParameter() — whether the shape-parameter field matters. */
export function shapeUsesParameter(shape: string): boolean {
  return shape === 'ogive' || shape === 'power' || shape === 'parabolic' || shape === 'haack';
}

/** Mirrors Shape.maxParameter() (haack tops out at LV-Haack, 1/3). */
export function shapeParamMax(shape: string): number {
  return shape === 'haack' ? 1 / 3 : 1;
}

/** Mirrors Shape.isClippable() — ellipsoid, power and haack transitions clip. */
export function shapeIsClippable(shape: string): boolean {
  return shape === 'ellipsoid' || shape === 'power' || shape === 'haack';
}

/**
 * Shape.getRadius(x, radius, length, param): radius of the pure shape at
 * distance x from its (virtual) tip. Exact port, shape by shape.
 */
export function shapeRadius(shape: string, x: number, radius: number, length: number, param: number): number {
  switch (shape) {
    case 'conical':
      return radius * x / length;
    case 'ellipsoid': {
      const xs = x * radius / length;
      return safeSqrt(2 * radius * xs - xs * xs); // radius/length * sphere
    }
    case 'power': {
      if (param <= 0.00001) {
        return x <= 0.00001 ? 0 : radius;
      }
      return radius * Math.pow(x / length, param);
    }
    case 'parabolic':
      return radius * ((2 * x / length - param * pow2(x / length)) / (2 - param));
    case 'haack': {
      const theta = Math.acos(1 - 2 * x / length);
      if (param === 0) {
        return radius * safeSqrt((theta - Math.sin(2 * theta) / 2) / Math.PI);
      }
      return radius * safeSqrt((theta - Math.sin(2 * theta) / 2 + param * pow3(Math.sin(theta))) / Math.PI);
    }
    case 'ogive':
    default: {
      // Impossible to calculate ogive for length < radius, scale instead.
      if (length < radius) {
        x = x * radius / length;
        length = radius;
      }
      if (param < MINFEATURE) {
        return shapeRadius('conical', x, radius, length, param);
      }
      const R = safeSqrt((pow2(length) + pow2(radius)) *
        (pow2((2 - param) * length) + pow2(param * radius)) / (4 * pow2(param * radius)));
      const L = length / param;
      const y0 = safeSqrt(R * R - L * L);
      return safeSqrt(R * R - (L - x) * (L - x)) - y0;
    }
  }
}

/**
 * Transition.calculateClip(): solve clipLength from
 * r1 == getRadius(clipLength, r2, clipLength + length) by binary search.
 * Assumes r1 < r2 (the caller has already flipped).
 */
function calculateClip(shape: string, param: number, length: number, r1: number, r2: number): number {
  let min = 0;
  let max = length;
  if (r1 === 0 || length <= 0) return 0;
  let n = 0;
  while (shapeRadius(shape, max, r2, max + length, param) - r1 < 0) {
    min = max;
    max *= 2;
    n++;
    if (n > 10) break;
  }
  for (;;) {
    const clip = (min + max) / 2;
    if (max - min < CLIP_PRECISION) return clip;
    const val = shapeRadius(shape, clip, r2, clip + length, param);
    if (val - r1 > 0) {
      max = clip;
    } else {
      min = clip;
    }
  }
}

/**
 * Sampled outer profile of a nose cone or transition: steps+1 points
 * [x, r] with x from 0 (fore end) to `length` (aft end). The shape
 * parameter is clamped exactly like Transition.setShapeParameter().
 * Nose cones are this with foreR = 0.
 */
export function outerProfile(
  shape: string, param: number | undefined, length: number,
  foreR: number, aftR: number, steps = 32,
): [number, number][] {
  const p = Math.min(Math.max(param ?? shapeParamDefault(shape), 0), shapeParamMax(shape));
  const pts: [number, number][] = [];

  if (foreR === aftR || length <= 0) {
    for (let i = 0; i <= steps; i++) pts.push([(i / steps) * length, foreR]);
    return pts;
  }

  // Transition.getRadius() normalizes to the small end first: r1 < r2,
  // x measured from the small end, flipped back afterwards.
  const flipped = foreR > aftR;
  const r1 = flipped ? aftR : foreR;
  const r2 = flipped ? foreR : aftR;
  const clipped = r1 > 0 && shapeIsClippable(shape);
  const clipLength = clipped ? calculateClip(shape, p, length, r1, r2) : 0;

  const radiusAt = (x: number): number => {
    if (x <= 0) return r1;
    if (x >= length) return r2;
    if (clipped) return shapeRadius(shape, clipLength + x, r2, clipLength + length, p);
    return r1 + shapeRadius(shape, x, r2 - r1, length, p);
  };

  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * length;
    pts.push([x, radiusAt(flipped ? length - x : x)]);
  }
  return pts;
}
