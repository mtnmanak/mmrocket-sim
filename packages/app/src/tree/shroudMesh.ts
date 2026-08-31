import * as THREE from 'three';
import { type EndShape, shroudHalfAngle } from './shroud.js';

/**
 * The camera shroud's 3D shell (v0.088), replacing the `BoxGeometry` that had
 * stood in for it since the component existed.
 *
 * A box could express neither of the two things Eric asked for on 2026-08-31 —
 * independent fore and aft end shapes, and an underside cut to the tube — so
 * both arrive on the same mesh rather than in two rewrites of the same code.
 *
 * **This geometry is also the STL export.** `Rocket3D.buildPieces` is the single
 * source of the app's 3D, and `App.tsx` feeds it straight to `piecesToStl`,
 * which derives every facet normal from the winding. So the surface has to be
 * CLOSED and consistently wound, or the export looks right on screen and fails
 * in a slicer. It matters on screen too: an opaque piece renders with
 * `THREE.FrontSide`, so an inside-out face is culled and you see through the
 * part.
 *
 * It is built as six patches — outer, underside, two ends, two sides — sharing
 * one grid, and `shroudMesh.test.ts` checks that every edge is traversed once
 * in each DIRECTION (consistently oriented, not merely closed) and that the
 * enclosed volume comes out positive (oriented OUTWARD, not merely
 * consistently). Both halves of that are load-bearing: the first version of the
 * test compared undirected edges and passed a mesh with four inverted patches.
 *
 * Frame: +x along the body toward the tail, and the shroud straddles the +y
 * axis. `Rocket3D` then rotates it to the mounting angle exactly as it rotated
 * the box, so the placement code above it is unchanged.
 */

/**
 * The end wall a tapered or domed end keeps, as a fraction of the height.
 *
 * A profile that runs to exactly zero is a knife edge, and a knife edge is
 * neither printable nor meshable: the end cap collapses to a line, its two
 * triangles have zero area and no normal, and the surface stops being closed —
 * 52 inconsistently-wound edges, in the mesh this replaced. A real 3D-printed
 * shroud ends in a wall; 8 % of the height is 1.6 mm on a 20 mm shroud, which
 * is about what one is. The 2D side view still draws the true point, and at
 * that size the two agree on screen.
 */
const END_WALL = 0.08;

/** Height above the tube surface at fraction `u` (0 = fore end, 1 = aft). */
function heightProfile(u: number, height: number, fore: EndShape, aft: EndShape): number {
  return Math.max(height * END_WALL, rawHeightProfile(u, height, fore, aft));
}

function rawHeightProfile(u: number, height: number, fore: EndShape, aft: EndShape): number {
  // Each end owns at most half the length, so two shaped ends on a short
  // shroud meet in the middle rather than crossing over.
  const run = (s: EndShape) => (s === 'box' ? 0 : s === 'streamlined' ? 0.3 : 0.25);
  const rf = Math.min(run(fore), 0.5);
  const ra = Math.min(run(aft), 0.5);
  if (u < rf && rf > 0) {
    const t = u / rf;
    // Streamlined is a straight taper; a dome is the quarter-ellipse that
    // reads as "half-round" in the side view.
    return height * (fore === 'streamlined' ? t : Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))));
  }
  if (u > 1 - ra && ra > 0) {
    const t = (1 - u) / ra;
    return height * (aft === 'streamlined' ? t : Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))));
  }
  return height;
}

export interface ShroudMeshSpec {
  length: number;
  width: number;
  height: number;
  bodyRadius: number;
  conformal: boolean;
  fore: EndShape;
  aft: EndShape;
}

/**
 * @param axialSteps  stations along the body (>= 2)
 * @param arcSteps    samples across the width (>= 2)
 */
export function shroudGeometry(
  spec: ShroudMeshSpec, axialSteps = 24, arcSteps = 12,
): THREE.BufferGeometry {
  const { length, width, height, bodyRadius, conformal, fore, aft } = spec;
  const th = shroudHalfAngle(bodyRadius, width);
  const NA = Math.max(2, Math.round(axialSteps));
  const NC = Math.max(2, Math.round(arcSteps));

  // TWO shapes, because a conformal shroud and a flat-bottomed one are not the
  // same part with a different floor:
  //
  //   conformal — a SHELL: the underside is the tube's own arc and the outer
  //               face is an arc at the local height above it. It is what
  //               comes off a printer bed cut to the tube.
  //   flat      — a BOX sitting on the TANGENT PLANE, which is what Eric was
  //               describing: *"the bottom is just a square shape tangentially
  //               to the body tube"*. The tangent plane touches the tube only
  //               along the centreline, so the part stands clear at its
  //               corners — 5.3 mm each side for a 25 mm shroud on a BT-50.
  //
  // The tangent plane is ABOVE the arc everywhere except that one line, so the
  // conformal part encloses MORE material: it fills the crescent the flat one
  // leaves as dead air. (Seating the flat bottom on the arc's CHORD instead
  // would bury it inside the tube — that was the first cut of this function,
  // and shroudMesh.test.ts caught it.)
  //
  // The box also keeps the mesh out of a degeneracy: with an arc top over a
  // tangent bottom, a shroud wide enough to wrap the tube has its "top" pass
  // BELOW its own floor at the edges. A box cannot invert.
  const halfW = Math.min(width / 2, bodyRadius * 2);
  const under = (j: number): [number, number] => {
    const f = j / (NC - 1);
    if (conformal) {
      const a = -th + 2 * th * f;
      return [bodyRadius * Math.cos(a), bodyRadius * Math.sin(a)];
    }
    return [bodyRadius, -halfW + 2 * halfW * f];
  };
  const over = (i: number, j: number): [number, number] => {
    const h = heightProfile(i / (NA - 1), height, fore, aft);
    const f = j / (NC - 1);
    if (conformal) {
      const a = -th + 2 * th * f;
      const r = bodyRadius + h;
      return [r * Math.cos(a), r * Math.sin(a)];
    }
    return [bodyRadius + h, -halfW + 2 * halfW * f];
  };

  const pos: number[] = [];
  const idx: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  /**
   * Emit a quad as two triangles, wound so their normals point along `out`.
   *
   * The vertex order is NOT trusted. Reasoning six patches' worth of winding by
   * hand is exactly what went wrong the first time — the outer and underside
   * sheets came out right and the two caps and two sides came out inside-out,
   * which no amount of staring at the code revealed and which the manifold test
   * could not see (it compared UNDIRECTED edges, so an inverted patch still
   * uses every edge twice). Here the outward direction of each patch is stated
   * where it is known analytically, and the winding follows from it.
   */
  const quad = (
    a: number, b: number, c: number, d: number, out: [number, number, number],
  ) => {
    const at = (i: number): [number, number, number] => [pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!];
    const [ax, ay, az] = at(a);
    const [bx, by, bz] = at(b);
    const [cx, cy, cz] = at(c);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) idx.push(a, b, c, a, c, d);
    else idx.push(a, d, c, a, c, b);
  };
  /** Unit radial direction at arc fraction f (the outward normal of the shell). */
  const radialAt = (f: number): [number, number, number] => {
    if (!conformal) return [0, 1, 0];
    const ang = -th + 2 * th * f;
    return [0, Math.cos(ang), Math.sin(ang)];
  };
  const neg = (v: [number, number, number]): [number, number, number] => [-v[0], -v[1], -v[2]];
  /** Unit tangential direction at arc fraction f, pointing towards +theta. */
  const tangentAt = (f: number): [number, number, number] => {
    if (!conformal) return [0, 0, 1];
    const ang = -th + 2 * th * f;
    return [0, -Math.sin(ang), Math.cos(ang)];
  };

  // Two NA x NC grids of DISTINCT vertices. Shared vertices would fuse the
  // outer and inner sheets and make the normals meaningless at the seams; the
  // duplicate corners are what give the ends and sides their own flat faces.
  const O: number[][] = [];
  const U: number[][] = [];
  for (let i = 0; i < NA; i++) {
    const x = (i / (NA - 1)) * length;
    const orow: number[] = [];
    const urow: number[] = [];
    for (let j = 0; j < NC; j++) {
      const [oy, oz] = over(i, j);
      const [uy, uz] = under(j);
      orow.push(push(x, oy, oz));
      urow.push(push(x, uy, uz));
    }
    O.push(orow);
    U.push(urow);
  }

  const mid = (j: number) => (j + 0.5) / (NC - 1);
  for (let i = 0; i < NA - 1; i++) {
    for (let j = 0; j < NC - 1; j++) {
      // The outer shell faces away from the axis; the underside faces into it.
      quad(O[i]![j]!, O[i]![j + 1]!, O[i + 1]![j + 1]!, O[i + 1]![j]!, radialAt(mid(j)));
      quad(U[i]![j]!, U[i + 1]![j]!, U[i + 1]![j + 1]!, U[i]![j + 1]!, neg(radialAt(mid(j))));
    }
  }
  for (let j = 0; j < NC - 1; j++) {
    quad(O[0]![j]!, O[0]![j + 1]!, U[0]![j + 1]!, U[0]![j]!, [-1, 0, 0]);                          // fore cap
    quad(O[NA - 1]![j + 1]!, O[NA - 1]![j]!, U[NA - 1]![j]!, U[NA - 1]![j + 1]!, [1, 0, 0]);       // aft cap
  }
  for (let i = 0; i < NA - 1; i++) {
    quad(O[i]![0]!, U[i]![0]!, U[i + 1]![0]!, O[i + 1]![0]!, neg(tangentAt(0)));                   // side -theta
    quad(O[i + 1]![NC - 1]!, U[i + 1]![NC - 1]!, U[i]![NC - 1]!, O[i]![NC - 1]!, tangentAt(1));    // side +theta
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
