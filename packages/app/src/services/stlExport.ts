/**
 * Binary STL export — the 3D-print boundary. Two producers feed one writer:
 * solidToStl() serializes a watertight per-component SolidMesh, and
 * piecesToStl() serializes the 3D view's display shell as a whole-rocket
 * REFERENCE model.
 *
 * Constraints the code can't show:
 * - Everything upstream is pure SI (meters); STL is written in MILLIMETERS
 *   because printers and slicers assume mm. The x1000 lives here and only
 *   here.
 * - The 80-byte header must NOT begin with the ASCII bytes 'solid' — several
 *   parsers sniff that prefix and mis-read the file as text STL. Our fixed
 *   'MMRocket Sim ...' prefix guarantees it.
 * - Facet normals are recomputed from the winding (right-hand rule, unit
 *   length); a degenerate facet gets the zero vector, which the format
 *   permits (readers then derive the normal themselves).
 */
import * as THREE from 'three';
import type { SolidMesh } from '../tree/solidMesh.js';
import type { Piece } from '../components/Rocket3D.js';

export const STL_MIME = 'model/stl';

const M_TO_MM = 1000;
const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

/** Serialize a flat triangle soup (9 numbers per triangle, METERS) to binary STL. */
function writeStl(soup: number[], name: string): Uint8Array {
  const count = soup.length / 9;
  const bytes = new Uint8Array(HEADER_BYTES + 4 + TRIANGLE_BYTES * count);
  const dv = new DataView(bytes.buffer);

  const header = `MMRocket Sim ${name} (units: mm)`;
  for (let i = 0; i < HEADER_BYTES && i < header.length; i++) {
    const c = header.charCodeAt(i);
    bytes[i] = c >= 0x20 && c < 0x7f ? c : 0x3f; // printable ASCII, else '?'
  }

  dv.setUint32(HEADER_BYTES, count, true);
  let off = HEADER_BYTES + 4;
  for (let t = 0; t < count; t++) {
    const b = t * 9;
    const ax = soup[b]!, ay = soup[b + 1]!, az = soup[b + 2]!;
    const bx = soup[b + 3]!, by = soup[b + 4]!, bz = soup[b + 5]!;
    const cx = soup[b + 6]!, cy = soup[b + 7]!, cz = soup[b + 8]!;

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len; ny /= len; nz /= len;
    } else {
      nx = 0; ny = 0; nz = 0;
    }

    dv.setFloat32(off, nx, true);
    dv.setFloat32(off + 4, ny, true);
    dv.setFloat32(off + 8, nz, true);
    dv.setFloat32(off + 12, ax * M_TO_MM, true);
    dv.setFloat32(off + 16, ay * M_TO_MM, true);
    dv.setFloat32(off + 20, az * M_TO_MM, true);
    dv.setFloat32(off + 24, bx * M_TO_MM, true);
    dv.setFloat32(off + 28, by * M_TO_MM, true);
    dv.setFloat32(off + 32, bz * M_TO_MM, true);
    dv.setFloat32(off + 36, cx * M_TO_MM, true);
    dv.setFloat32(off + 40, cy * M_TO_MM, true);
    dv.setFloat32(off + 44, cz * M_TO_MM, true);
    dv.setUint16(off + 48, 0, true);
    off += TRIANGLE_BYTES;
  }
  return bytes;
}

/** One watertight component solid (indices dereferenced, triangle order kept). */
export function solidToStl(mesh: SolidMesh, name: string): Uint8Array {
  const soup: number[] = [];
  for (let i = 0; i < mesh.triangles.length; i++) {
    const v = mesh.triangles[i]! * 3;
    soup.push(mesh.positions[v]!, mesh.positions[v + 1]!, mesh.positions[v + 2]!);
  }
  return writeStl(soup, name);
}

/**
 * Whole-rocket display shell as one STL. Each piece's position/rotation is
 * baked into a cloned geometry, so the file matches what the 3D view shows.
 * NOT watertight by nature — overlapping open surfaces, not a fused solid.
 * It is a reference/print-preview model; per-component printable parts come
 * from solidToStl().
 */
export function piecesToStl(pieces: Piece[], name: string): Uint8Array {
  const soup: number[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const eul = new THREE.Euler();
  const unit = new THREE.Vector3(1, 1, 1);
  for (const p of pieces) {
    pos.set(...(p.position ?? [0, 0, 0]));
    eul.set(...(p.rotation ?? [0, 0, 0]));
    q.setFromEuler(eul);
    m.compose(pos, q, unit);
    let g = p.geometry.clone();
    g.applyMatrix4(m);
    if (g.index) g = g.toNonIndexed();
    const a = g.getAttribute('position');
    for (let i = 0; i < a.count; i++) {
      soup.push(a.getX(i), a.getY(i), a.getZ(i));
    }
  }
  return writeStl(soup, name);
}
