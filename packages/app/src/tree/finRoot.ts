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
 *  - An interior point that lies inside the body, within the mount's length, is
 *    raised to its surface (`FreeformFinSet.clampInteriorPoint`, which every
 *    `update()` runs).
 *
 * Both views used to root every fin at one radius along the whole chord — the
 * LARGER end radius on a transition — so a fin on a 54 -> 38 mm boat tail was
 * drawn and exported floating off the surface, the gap growing aft (audit
 * 2026-09-30). Freeform is the one fin type a transition accepts, and what both
 * importers convert a boat-tail fin to. On a body tube nothing moves: the
 * radius is the same everywhere and an outline whose corners are on y = 0, and
 * whose other points are above it, comes back point for point.
 *
 * THE CLAMP IS NOT OPTIONAL ONCE THE ROOT FOLLOWS THE BODY. On a RISING mount
 * (a flare, a nose cone) the body climbs under the fin's aft half, and a point
 * the planform keeps low there — the trailing points of an elliptical or
 * trapezoid fin the RockSim importer converts onto a flare — lies inside it.
 * Left there, the outline crossed its own root, and three's ear clipper
 * deleted vertices: open fin meshes in the 3D view and the display-shell STL,
 * OBJ and glTF (measured on a 12.5 -> 25 mm flare: 126 triangles with 6 open
 * edges). Raised onto the body, such a point touches the root, so `lobes`
 * splits the planform there and drops what runs along the body: a triangulator
 * gets closed loops that each enclose area.
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

/** Two stations closer than this (m) are one. */
const SAME_X = 1e-12;

/**
 * An interior point within this (m) of the body's surface is ON it: 1 nm,
 * finOutline's COINCIDENT_M. Snapped onto the surface, it splits the planform
 * cleanly instead of leaving a sliver a triangulator can misjudge.
 */
const ON_BODY = 1e-9;

export interface MountedFin {
  /** The mount's radius at the leading edge — where the outline's y = 0 sits. */
  r0: number;
  /**
   * The closed planform in the fin's own frame (x aft of the leading root
   * corner, y outward from `r0`): the outline with its first and last points
   * on the body and any interior point inside the body raised to its surface,
   * then the body's surface back to the leading corner — the kernel's
   * `getFinPointsWithRoot()`. On a flat mount, an outline whose corners are on
   * y = 0 and whose other points are above it is returned unchanged.
   */
  outline: [number, number][];
  /** The body's surface under the fin, leading corner to trailing, in the same frame. */
  root: [number, number][];
  /**
   * `outline` as closed loops that each enclose area, for a renderer that has
   * to triangulate it: split at every interior point that lies on the body,
   * with the runs between two such points dropped (they lie along the body and
   * enclose nothing), each loop closed along the body's surface under it. One
   * loop, `outline` itself, unless an interior point touches the body; none
   * when the whole planform lies along it.
   */
  lobes: [number, number][][];
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
  /** The body's surface at x in the fin's frame. */
  const bodyY = (x: number): number => mount.radiusAt(xFront + x) - r0;
  const onSurface = (x: number): [number, number] => [x, bodyY(x)];
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const a = first[0];
  const b = last[0];
  // The mount's own ends, in the fin's frame: the surface has a corner at
  // each (it holds the end radius beyond it), and clampInteriorPoint acts
  // only between them.
  const ends = [-xFront, mount.length - xFront];
  // The root's stations in the FIN's frame, so a corner keeps its own x
  // exactly ((xFront + a) - xFront is not always a).
  const xs = [a];
  if (!mount.flat && b > a) {
    const divisions = mount.curved
      ? Math.min(MAX_ROOT_DIVISIONS, Math.max(1, Math.ceil((b - a) / ROOT_STEP)))
      : 1;
    for (let i = 1; i < divisions; i++) xs.push(a + ((b - a) * i) / divisions);
    // getMountPoints adds the mount's own ends when the root runs past them.
    for (const end of ends) {
      if (a < end && end < b && !xs.some((x) => Math.abs(x - end) < SAME_X)) xs.push(end);
    }
    xs.sort((p, q) => p - q);
  }
  xs.push(b);
  const root = xs.map(onSurface);

  // The fin as the kernel flies it: corners on the body, and an interior point
  // inside the body — within the mount's length, as clampInteriorPoint tests
  // it — raised to the surface. `touches` marks the points on the body: those,
  // and a point lying ON the root anywhere, including past the mount's end,
  // where the root holds the end radius and the kernel raises nothing. A flat
  // run along the root of a fin overhanging the tube's aft end is such a point.
  const chain: [number, number][] = [root[0]!];
  const touches = [true];
  for (const [x, y] of points.slice(1, -1)) {
    const yb = bodyY(x);
    const on = Math.abs(y - yb) <= ON_BODY || (ends[0]! <= x && x <= ends[1]! && y < yb);
    chain.push(on ? onSurface(x) : [x, y]);
    touches.push(on);
  }
  chain.push(root[root.length - 1]!);
  touches.push(true);
  const outline: [number, number][] = [...chain, ...root.slice(1, -1).reverse()];

  // The body's surface from `from` back to `to`, both ends excluded: the
  // root's stations between them, and a mount end the stretch spans beyond
  // the root's own (the root already carries those inside it). Across the
  // whole root this is `root` reversed, so a planform that touches the body
  // only at its corners is one lobe, `outline` point for point.
  const corners = mount.flat ? [] : ends;
  const surfaceBack = (from: number, to: number): [number, number][] => {
    const lo = Math.min(from, to) + SAME_X;
    const hi = Math.max(from, to) - SAME_X;
    const at = xs.filter((x) => x > lo && x < hi);
    for (const end of corners) {
      if (lo < end && end < hi && !at.some((x) => Math.abs(x - end) < SAME_X)) at.push(end);
    }
    return at.sort((p, q) => (from > to ? q - p : p - q)).map(onSurface);
  };
  const lobes: [number, number][][] = [];
  let start = 0;
  for (let j = 1; j < chain.length; j++) {
    if (!touches[j]) continue;
    // Two touching points in a row are a run along the body: nothing to close.
    if (j - start >= 2) {
      lobes.push([...chain.slice(start, j + 1), ...surfaceBack(chain[j]![0], chain[start]![0])]);
    }
    start = j;
  }
  return { r0, outline, root, lobes };
}
