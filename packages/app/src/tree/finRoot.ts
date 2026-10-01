import { profileRadius } from './shapeProfile.js';

/**
 * WHERE A FIN MEETS THE BODY IT IS MOUNTED ON, the way the kernel attaches it
 * (FinSet.java, 24.12) — shared by the 3D pieces (and the STL, OBJ and glTF
 * exports built from them) and the 2D side view, so the two cannot drift.
 *
 *  - The fin's own y = 0 is the mount's radius AT THE FIN'S LEADING EDGE:
 *    `getFinFront()` is (front station, `parent.getRadius(front)`), and
 *    `getBodyRadius()` returns its y.
 *  - Both root corners sit ON the body: `getFinPoints()` moves the first and
 *    last points onto `getRootPoints()`, the body's surface under the fin.
 *  - The planform closes along that surface (`getFinPointsWithRoot`), which
 *    `getMountPoints` walks in 2.5 mm steps on a transition that is not conical
 *    and takes as one straight segment on a body tube or a cone.
 *
 * Both views used to root every fin at one radius along the whole chord — the
 * LARGER end radius on a transition — so a fin on a 54 -> 38 mm boat tail was
 * drawn and exported floating off the surface, the gap growing aft (audit
 * 2026-09-30). Freeform is the one fin type a transition accepts, and what both
 * importers convert a boat-tail fin to. On a body tube nothing moves: the
 * radius is the same everywhere and an outline whose corners are on y = 0
 * comes back point for point.
 *
 * NOT mirrored: the kernel also raises an interior point that lies inside the
 * body up to its surface (`FreeformFinSet.clampInteriorPoint`). The drawings
 * keep interior points where the design stores them, as they always have.
 */

/** The outer surface a fin set is mounted on, in the mount's own frame (m from its fore end). */
export interface MountSurface {
  /** Outer radius at a station, clamped into the part as `SymmetricComponent.getRadius` clamps it. */
  radiusAt: (x: number) => number;
  /** The mount's length (m): where that clamping begins at the aft end. */
  length: number;
  /** One radius everywhere — a body tube, or a transition whose two ends match. */
  flat: boolean;
  /** One straight segment is NOT the surface: a transition or nose cone that is not conical. */
  curved: boolean;
}

/** A body tube (or anything else of one radius). */
export function flatMount(radius: number, length: number): MountSurface {
  return { radiusAt: () => radius, length, flat: true, curved: false };
}

/** A nose cone (foreR 0) or transition, from the same profile the views draw it with. */
export function profileMount(
  shape: string, param: number | undefined, length: number,
  foreR: number, aftR: number, clipped?: boolean,
): MountSurface {
  const flat = foreR === aftR || length <= 0;
  return {
    radiusAt: profileRadius(shape, param, length, foreR, aftR, clipped),
    length,
    flat,
    // FinSet.getMountPoints' own test: the parent is a Transition whose shape
    // is not CONICAL (a NoseCone is a Transition).
    curved: !flat && shape !== 'conical',
  };
}

/** `getMountPoints`' step (m), and the 3D renderer's cap on the divisions (MAX_ROOT_DIVISIONS_LOW_RES). */
const ROOT_STEP = 0.0025;
const MAX_ROOT_DIVISIONS = 20;

export interface MountedFin {
  /** The mount's radius at the leading edge — where the outline's y = 0 sits. */
  r0: number;
  /**
   * The closed planform in the fin's own frame (x aft of the leading root
   * corner, y outward from `r0`): the outline with its first and last points
   * on the body, then the body's surface back to the leading corner. On a
   * flat mount, an outline whose corners are on y = 0 is returned unchanged.
   */
  outline: [number, number][];
  /** The body's surface under the fin, leading corner to trailing, in the same frame. */
  root: [number, number][];
}

/**
 * A freeform outline (point 0 the leading root corner, the last point the
 * trailing one) placed on its mount. `xFront` is the leading edge's station
 * in the mount's frame — `FinSet.getAxialFront()`.
 */
export function finOnMount(
  points: readonly (readonly [number, number])[], xFront: number, mount: MountSurface,
): MountedFin {
  const r0 = mount.radiusAt(xFront);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const a = first[0];
  const b = last[0];
  // The root's stations in the FIN's frame, so a corner keeps its own x
  // exactly ((xFront + a) - xFront is not always a).
  const xs = [a];
  if (!mount.flat && b > a) {
    const divisions = mount.curved
      ? Math.min(MAX_ROOT_DIVISIONS, Math.max(1, Math.ceil((b - a) / ROOT_STEP)))
      : 1;
    for (let i = 1; i < divisions; i++) xs.push(a + ((b - a) * i) / divisions);
    // getMountPoints adds the mount's own ends when the root runs past them:
    // the surface has a corner there (it holds the end radius beyond it).
    for (const end of [-xFront, mount.length - xFront]) {
      if (a < end && end < b && !xs.some((x) => Math.abs(x - end) < 1e-12)) xs.push(end);
    }
    xs.sort((p, q) => p - q);
  }
  xs.push(b);
  const root = xs.map((x): [number, number] => [x, mount.radiusAt(xFront + x) - r0]);
  const outline: [number, number][] = [
    root[0]!,
    ...points.slice(1, -1).map(([x, y]): [number, number] => [x, y]),
    root[root.length - 1]!,
    ...root.slice(1, -1).reverse(),
  ];
  return { r0, outline, root };
}
