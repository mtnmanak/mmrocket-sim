/**
 * Cluster layouts — an exact mirror of the kernel's ClusterConfiguration
 * (carved info.openrocket.core.rocketcomponent.ClusterConfiguration). Unit
 * points: closest tube centers are distance 1 apart; the physical separation
 * is 2 × tubeOuterRadius × clusterScale. Used for 2D/3D drawing and motor
 * counts — the PHYSICS reads the kernel's own copy, so these only need to
 * match visually.
 */

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

/** Flat [x0,y0, x1,y1, …] unit points per pattern (kernel XML names). */
export const CLUSTER_POINTS: Record<string, number[]> = {
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
};

/** Dropdown options in kernel order, labelled with their motor counts. */
export const CLUSTER_OPTIONS: [string, string][] = Object.entries(CLUSTER_POINTS).map(
  ([name, pts]) => [name, name === 'single' ? 'Single' : `${name} (${pts.length / 2} motors)`],
);

/** Motors in this cluster pattern (1 for single/unknown). */
export function clusterCount(cluster: string | undefined): number {
  const pts = CLUSTER_POINTS[cluster ?? 'single'];
  return pts ? pts.length / 2 : 1;
}

/**
 * Physical tube-center offsets (m) in the cross-section plane, rotation
 * applied — matches InnerTube.getClusterPoints (radialDirection is not
 * modeled app-side).
 */
export function clusterOffsets(
  cluster: string | undefined,
  tubeOuterRadius: number,
  clusterScale = 1,
  clusterRotation = 0,
): { y: number; z: number }[] {
  const pts = CLUSTER_POINTS[cluster ?? 'single'] ?? [0, 0];
  const separation = 2 * tubeOuterRadius * clusterScale;
  const cos = Math.cos(clusterRotation);
  const sin = Math.sin(clusterRotation);
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
