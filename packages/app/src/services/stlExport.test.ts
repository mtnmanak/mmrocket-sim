// @vitest-environment happy-dom
/**
 * Binary STL writer tests. The parser below is written independently of the
 * writer (raw DataView reads against the published format) so a shared
 * encoding bug cannot self-verify. The SolidMesh fixture is hand-built here
 * rather than imported from solidMesh.ts, keeping this suite decoupled from
 * the mesh builders.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Piece } from '../components/Rocket3D.js';
import { STL_MIME, piecesToStl, solidToStl } from './stlExport.js';

interface ParsedTri {
  normal: [number, number, number];
  verts: [[number, number, number], [number, number, number], [number, number, number]];
  attr: number;
}

const parseStl = (bytes: Uint8Array): { header: string; count: number; tris: ParsedTri[] } => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header = '';
  for (let i = 0; i < 80; i++) {
    const c = dv.getUint8(i);
    if (c !== 0) header += String.fromCharCode(c);
  }
  const count = dv.getUint32(80, true);
  expect(bytes.byteLength).toBe(84 + 50 * count);
  const tris: ParsedTri[] = [];
  for (let t = 0; t < count; t++) {
    const off = 84 + 50 * t;
    const f = (k: number): number => dv.getFloat32(off + 4 * k, true);
    tris.push({
      normal: [f(0), f(1), f(2)],
      verts: [[f(3), f(4), f(5)], [f(6), f(7), f(8)], [f(9), f(10), f(11)]],
      attr: dv.getUint16(off + 48, true),
    });
  }
  return { header, count, tris };
};

// Unit cube [0,1]^3, outward CCW winding: 8 vertices, 12 triangles.
const cube = {
  positions: new Float64Array([
    0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
    0, 0, 1,  1, 0, 1,  1, 1, 1,  0, 1, 1,
  ]),
  triangles: new Uint32Array([
    0, 3, 2,  0, 2, 1, // bottom (-z)
    4, 5, 6,  4, 6, 7, // top (+z)
    0, 1, 5,  0, 5, 4, // front (-y)
    3, 7, 6,  3, 6, 2, // back (+y)
    0, 4, 7,  0, 7, 3, // left (-x)
    1, 2, 6,  1, 6, 5, // right (+x)
  ]),
};

describe('solidToStl', () => {
  it('round-trips the cube: 12 triangles, vertices scaled m -> mm, attributes zero', () => {
    const { count, tris } = parseStl(solidToStl(cube, 'cube'));
    expect(count).toBe(12);
    for (let t = 0; t < 12; t++) {
      const tri = tris[t]!;
      expect(tri.attr).toBe(0);
      for (let v = 0; v < 3; v++) {
        const idx = cube.triangles[t * 3 + v]! * 3;
        expect(tri.verts[v]![0]).toBe(cube.positions[idx]! * 1000);
        expect(tri.verts[v]![1]).toBe(cube.positions[idx + 1]! * 1000);
        expect(tri.verts[v]![2]).toBe(cube.positions[idx + 2]! * 1000);
      }
    }
  });

  it('normals are unit length and point away from the cube center', () => {
    const { tris } = parseStl(solidToStl(cube, 'cube'));
    for (const tri of tris) {
      const [nx, ny, nz] = tri.normal;
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 6);
      const cx = (tri.verts[0][0] + tri.verts[1][0] + tri.verts[2][0]) / 3 - 500;
      const cy = (tri.verts[0][1] + tri.verts[1][1] + tri.verts[2][1]) / 3 - 500;
      const cz = (tri.verts[0][2] + tri.verts[1][2] + tri.verts[2][2]) / 3 - 500;
      expect(nx * cx + ny * cy + nz * cz).toBeGreaterThan(0);
    }
  });

  it('header does not start with "solid", names the model, and states mm', () => {
    const bytes = solidToStl(cube, 'cube');
    const first5 = String.fromCharCode(...bytes.subarray(0, 5));
    expect(first5).not.toBe('solid');
    const { header } = parseStl(bytes);
    expect(header).toContain('cube');
    expect(header).toContain('mm');
  });

  it('truncates a long name to the 80-byte header without corrupting the body', () => {
    const bytes = solidToStl(cube, 'x'.repeat(200));
    const { header, count } = parseStl(bytes);
    expect(header.length).toBeLessThanOrEqual(80);
    expect(count).toBe(12);
  });

  it('a degenerate triangle gets the zero normal', () => {
    const flat = {
      positions: new Float64Array([0.5, 0.5, 0.5]),
      triangles: new Uint32Array([0, 0, 0]),
    };
    const { tris } = parseStl(solidToStl(flat, 'degenerate'));
    expect(tris[0]!.normal).toEqual([0, 0, 0]);
  });
});

describe('piecesToStl', () => {
  it('bakes a piece translation into the emitted vertices (mm)', () => {
    const pieces: Piece[] = [{
      key: 'box',
      geometry: new THREE.BoxGeometry(0.1, 0.1, 0.2),
      color: '#888888',
      position: [1, 2, 3],
    }];
    const { count, tris } = parseStl(piecesToStl(pieces, 'shell'));
    expect(count).toBe(12);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const tri of tris) {
      for (const v of tri.verts) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, v[k]!);
          max[k] = Math.max(max[k]!, v[k]!);
        }
      }
    }
    expect(min[0]).toBeCloseTo(950, 3);
    expect(max[0]).toBeCloseTo(1050, 3);
    expect(min[1]).toBeCloseTo(1950, 3);
    expect(max[1]).toBeCloseTo(2050, 3);
    expect(min[2]).toBeCloseTo(2900, 3);
    expect(max[2]).toBeCloseTo(3100, 3);
  });

  it('concatenates triangles across pieces', () => {
    const piece = (key: string): Piece => ({
      key,
      geometry: new THREE.BoxGeometry(0.01, 0.01, 0.01),
      color: '#888888',
    });
    const { count } = parseStl(piecesToStl([piece('a'), piece('b')], 'two'));
    expect(count).toBe(24);
  });
});

describe('STL_MIME', () => {
  it('is model/stl', () => {
    expect(STL_MIME).toBe('model/stl');
  });
});
