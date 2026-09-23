/**
 * Cluster layouts — an exact mirror of the kernel's ClusterConfiguration
 * (carved info.openrocket.core.rocketcomponent.ClusterConfiguration), pinned
 * coordinate for coordinate against that source file by `cluster.test.ts`.
 * Unit points, scaled by the physical separation 2 × tubeOuterRadius ×
 * clusterScale. In every pattern but two the closest tube centres are 1 unit
 * apart, so at scale 1 the tubes touch; OpenRocket spreads its two nine-tube
 * patterns wider — 9-grid's closest centres are 1.4 apart and 9-star's
 * ≈1.072 (its eight-tube ring on radius 1.4) — whatever its own javadoc says
 * (audit 2026-09-22, row 481). Used for 2D/3D drawing, the .rkt export and
 * motor counts — the PHYSICS reads the kernel's own copy, so a drift here
 * makes the drawings and exports disagree with the flight, not the flight
 * wrong.
 */

import { lookupTable } from '../services/xmlUtil.js';

const SQRT2 = Math.SQRT2;
const SQRT3 = Math.sqrt(3);
const R5 = 1.0 / (2 * Math.sin((2 * Math.PI) / 10));
const ring = (n: number, r: number, centered: boolean): number[] => {
  const pts: number[] = centered ? [0, 0] : [];
  for (let i = 0; i < n; i++) {
    pts.push(r * Math.sin((2 * Math.PI * i) / n), r * Math.cos((2 * Math.PI * i) / n));
  }
  return pts;
};

/**
 * Flat [x0,y0, x1,y1, …] unit points per pattern (kernel XML names).
 *
 * `lookupTable` (a null-prototype object) and not a plain literal: the name
 * comes out of an `.ork` file, so `CLUSTER_POINTS[name]` on a plain object
 * resolves `Object.prototype` members. Measured 2026-09-21 before the wrap:
 * `clusterCount('constructor')` returned 0.5 and its offsets were NaN,
 * `toString` gave 0 motors, `__proto__` gave NaN — each of them defeating BOTH
 * the `?? 'single'` and the `?? [0, 0]` fallbacks, because an inherited value
 * is not undefined. Same hardening, same helper, as the 12 other file-keyed
 * maps (services/xmlUtil.ts `lookupTable`).
 */
export const CLUSTER_POINTS: Record<string, number[]> = lookupTable({
  single: [0, 0],
  double: [-0.5, 0, 0.5, 0],
  '3-row': [-1, 0, 0, 0, 1, 0],
  '4-row': [-1.5, 0, -0.5, 0, 0.5, 0, 1.5, 0],
  '3-ring': [-0.5, -1 / (2 * SQRT3), 0.5, -1 / (2 * SQRT3), 0, 1 / SQRT3],
  '4-ring': [-0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5],
  '5-ring': ring(5, R5, false),
  '6-ring': [0, 1, SQRT3 / 2, 0.5, SQRT3 / 2, -0.5, 0, -1, -SQRT3 / 2, -0.5, -SQRT3 / 2, 0.5],
  '3-star': [0, 0, 0, 1, SQRT3 / 2, -0.5, -SQRT3 / 2, -0.5],
  '4-star': [0, 0, -1 / SQRT2, 1 / SQRT2, 1 / SQRT2, 1 / SQRT2, 1 / SQRT2, -1 / SQRT2, -1 / SQRT2, -1 / SQRT2],
  '5-star': ring(5, 1, true),
  '6-star': [0, 0, 0, 1, SQRT3 / 2, 0.5, SQRT3 / 2, -0.5, 0, -1, -SQRT3 / 2, -0.5, -SQRT3 / 2, 0.5],
  '9-grid': [-1.4, 1.4, 0, 1.4, 1.4, 1.4, -1.4, 0, 0, 0, 1.4, 0, -1.4, -1.4, 0, -1.4, 1.4, -1.4],
  '9-star': [0, 0, 1.4, 0, 1.4 / SQRT2, -1.4 / SQRT2, 0, -1.4, -1.4 / SQRT2, -1.4 / SQRT2, -1.4, 0, -1.4 / SQRT2, 1.4 / SQRT2, 0, 1.4, 1.4 / SQRT2, 1.4 / SQRT2],
});

/** Dropdown options in kernel order, labelled with their motor counts. */
export const CLUSTER_OPTIONS: [string, string][] = Object.entries(CLUSTER_POINTS).map(
  ([name, pts]) => [name, name === 'single' ? 'Single' : `${name} (${pts.length / 2} motors)`],
);

/** Motors in this cluster pattern (1 for single/unknown). */
export function clusterCount(cluster: string | undefined): number {
  const pts = CLUSTER_POINTS[cluster ?? 'single'];
  return pts ? pts.length / 2 : 1;
}

/** The two angles a caller may add on top of the tube's own cluster rotation. */
export interface ClusterAngles {
  /**
   * The tube's own `radialDirection` (rad). The kernel rotates the pattern by
   * it as well as offsetting the tube along it — `getPoints(clusterRotation −
   * getRadialDirection())` — so a split-cluster tube, or any clustered tube
   * set off the axis, turns its pattern with its direction. The OFFSET itself
   * (radialPosition along radialDirection) is still the caller's to add.
   */
  radialDirection?: number;
  /** A drawing's roll about the body axis (rad): turns the result like every other part in that view. */
  viewRoll?: number;
}

/**
 * Physical tube-centre offsets (m) in the cross-section plane (y, z — angle 0
 * is +y, the frame fins and pods use), rotation applied the way the KERNEL
 * applies it: `InnerTube.getClusterPoints` calls
 * `ClusterConfiguration.getPoints(clusterRotation − radialDirection)`, and
 * getPoints turns the pattern by MINUS its argument (`x·cos + y·sin`,
 * `−x·sin + y·cos`).
 *
 * This used to turn it by PLUS the rotation (audit 2026-09-22, row 358). The
 * two agree only where twice the rotation is a symmetry of the pattern — zero
 * always is, which is why it hid — and otherwise put the tubes somewhere else:
 * a 3-ring rotated 30° was drawn at 0°/120°/240° — ON a three-fin set's
 * fin lines, in the aft view, the 3D view and the STL, and written that way
 * into a .rkt — while the kernel and desktop put the tubes at 60°/180°/300°,
 * between them. Mass and flight never moved (the kernel has its own copy);
 * the drawings and exports of such a design disagreed with its flight.
 */
export function clusterOffsets(
  cluster: string | undefined,
  tubeOuterRadius: number,
  clusterScale = 1,
  clusterRotation = 0,
  angles: ClusterAngles = {},
): { y: number; z: number }[] {
  const pts = CLUSTER_POINTS[cluster ?? 'single'] ?? [0, 0];
  const separation = 2 * tubeOuterRadius * clusterScale;
  // One turn: the kernel's −(clusterRotation − radialDirection), then the view's roll.
  const turn = (angles.viewRoll ?? 0) + (angles.radialDirection ?? 0) - clusterRotation;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const out: { y: number; z: number }[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i]!;
    const y = pts[i + 1]!;
    out.push({
      y: (x * cos - y * sin) * separation,
      z: (x * sin + y * cos) * separation,
    });
  }
  return out;
}
