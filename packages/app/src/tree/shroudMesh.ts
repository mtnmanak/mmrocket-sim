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
 * **This geometry is also the OBJ and glTF export.** `Rocket3D.buildPieces` is
 * the single source of the app's 3D, and `objExport`/`gltfExport` consume it
 * directly. So the surface has to be CLOSED and consistently wound, or the
 * export looks right on screen and fails in a slicer. It is built as six
 * patches — outer, underside, two ends, two sides — sharing the same grid, and
 * `shroudMesh.test.ts` checks that every edge is used exactly twice and that
 * the volume comes out positive.
 *
 * Frame: +x along the body toward the tail, and the shroud straddles the +y
 * axis. `Rocket3D` then rotates it to the mounting angle exactly as it rotated
 * the box, so the placement code above it is unchanged.
 */

/** Height above the tube surface at fraction `u` (0 = fore end, 1 = aft). */
function heightProfile(u: number, height: number, fore: EndShape, aft: EndShape): number {
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
  const quad = (a: number, b: number, c: number, d: number) => {
    idx.push(a, b, c, a, c, d);
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

  for (let i = 0; i < NA - 1; i++) {
    for (let j = 0; j < NC - 1; j++) {
      quad(O[i]![j]!, O[i]![j + 1]!, O[i + 1]![j + 1]!, O[i + 1]![j]!);   // outer, outward
      quad(U[i]![j]!, U[i + 1]![j]!, U[i + 1]![j + 1]!, U[i]![j + 1]!);   // underside, inward
    }
  }
  for (let j = 0; j < NC - 1; j++) {
    quad(O[0]![j]!, O[0]![j + 1]!, U[0]![j + 1]!, U[0]![j]!);                       // fore cap
    quad(O[NA - 1]![j + 1]!, O[NA - 1]![j]!, U[NA - 1]![j]!, U[NA - 1]![j + 1]!);   // aft cap
  }
  for (let i = 0; i < NA - 1; i++) {
    quad(O[i]![0]!, U[i]![0]!, U[i + 1]![0]!, O[i + 1]![0]!);                                   // side -theta
    quad(O[i + 1]![NC - 1]!, U[i + 1]![NC - 1]!, U[i]![NC - 1]!, O[i]![NC - 1]!);               // side +theta
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
