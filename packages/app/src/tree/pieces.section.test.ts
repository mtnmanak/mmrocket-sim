import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { buildPieces, FINISH_MATERIAL, pieceMaterial, type Piece } from './pieces.js';
import { finSectionFlatReason, seatedChordPoints } from './finChords.js';
import { filletMesh, rootRuns, shapedFin, type FinPlacement } from './finSurface.js';
import { enclosesArea } from './polygon.js';
import { solidContextFor } from './solidContext.js';
import { finPrintShape } from './solidMesh.js';
import { profileRadius } from './shapeProfile.js';
import { finOnMount, flatMount, profileMount, type MountSurface } from './finRoot.js';

/**
 * N062 — the display path draws a fin's cross-section, its root fillets and
 * its surface finish (the 3D view, the PNG snapshot, the OBJ, the GLB and the
 * whole-rocket shell STL all draw these pieces). Square stays the flat prism,
 * vertex for vertex.
 */

const R = 0.024;
const T = 0.004;
type V = [number, number, number];

const onTube = (fin: Record<string, unknown>): RocketTree => ({
  name: 'R',
  components: [{ id: 's1', type: 'stage', children: [
    { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: R },
    { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: R, children: [{
      id: 'f', finCount: 1, thickness: T, position: { method: 'bottom', offset: 0 }, ...fin,
    }] },
  ] }],
} as unknown as RocketTree);

/** A transition carrying the fin (12 mm boat tail 27 -> 19 mm, or a 12.5 -> 25 mm flare). */
const onTransition = (shape: string, fore: number, aft: number, fin: Record<string, unknown>): RocketTree => ({
  name: 'R',
  components: [{ id: 's1', type: 'stage', children: [
    { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: fore },
    { id: 't1', type: 'transition', shape, length: 0.08, foreRadius: fore, aftRadius: aft, children: [{
      id: 'f', finCount: 1, thickness: T, position: { method: 'top', offset: 0 }, ...fin,
    }] },
  ] }],
} as unknown as RocketTree);

const TRAP = { type: 'trapezoidfinset', rootChord: 0.08, tipChord: 0.04, sweep: 0.03, height: 0.05 };
const ELLIPSE = { type: 'ellipticalfinset', rootChord: 0.08, height: 0.05 };
const FREE = { type: 'freeformfinset', points: [[0, 0], [0.02, 0.04], [0.05, 0.04], [0.06, 0]] };

const SECTIONS: [string, Record<string, unknown>][] = [
  ['rounded', { crossSection: 'rounded' }],
  ['airfoil (NACA)', { crossSection: 'airfoil' }],
  ['hexagonal', { crossSection: 'airfoil', airfoilSection: 'hexagonal' }],
  ['hexagonal + LE radius', { crossSection: 'airfoil', airfoilSection: 'hexagonal', finLeRadius: 0.0008 }],
  ['naca', { crossSection: 'airfoil', airfoilSection: 'naca' }],
  ['doublewedge', { crossSection: 'airfoil', airfoilSection: 'doublewedge' }],
  ['biconvex', { crossSection: 'airfoil', airfoilSection: 'biconvex' }],
  ['biconvex + LE radius', { crossSection: 'airfoil', airfoilSection: 'biconvex', finLeRadius: 0.0005 }],
  ['hexbluntbase', { crossSection: 'airfoil', airfoilSection: 'hexbluntbase' }],
  ['singlewedge', { crossSection: 'airfoil', airfoilSection: 'singlewedge' }],
];

const finPiece = (tree: RocketTree): Piece => buildPieces(tree).pieces.find((p) => p.key.startsWith('fin'))!;

function corners(g: THREE.BufferGeometry): V[] {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  return Array.from({ length: n }, (_, i): V => {
    const j = idx ? idx.getX(i) : i;
    return [pos.getX(j), pos.getY(j), pos.getZ(j)];
  });
}

/** Edges used an odd number of times, vertices welded by position (pieces.test.ts's closure test). */
function oddEdges(g: THREE.BufferGeometry): number {
  const v = corners(g).map((p) => p.map((c) => Math.round(c * 1e7)).join(','));
  const uses = new Map<string, number>();
  for (let i = 0; i < v.length; i += 3) {
    for (const [p, q] of [[v[i]!, v[i + 1]!], [v[i + 1]!, v[i + 2]!], [v[i + 2]!, v[i]!]]) {
      const e = p! < q! ? `${p}|${q}` : `${q}|${p}`;
      uses.set(e, (uses.get(e) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter((u) => u % 2 === 1).length;
}

/** Signed volume: positive when the surface winds outward. */
function volume(g: THREE.BufferGeometry): number {
  const c = corners(g);
  let v = 0;
  for (let i = 0; i < c.length; i += 3) {
    const [a, b, d] = [c[i]!, c[i + 1]!, c[i + 2]!];
    v += (a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
  }
  return v;
}

/** Faces whose stored corner normals point INTO the solid (FrontSide would cull the outside). */
function inwardNormals(g: THREE.BufferGeometry): number {
  const c = corners(g);
  const nor = g.getAttribute('normal');
  let bad = 0;
  for (let i = 0; i < c.length; i += 3) {
    const [a, b, d] = [c[i]!, c[i + 1]!, c[i + 2]!];
    const u = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const w = new THREE.Vector3(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    const n = u.cross(w);
    if (n.length() < 1e-12) continue; // zero-area: draws nothing
    for (let k = 0; k < 3; k++) {
      const m = new THREE.Vector3(nor.getX(i + k), nor.getY(i + k), nor.getZ(i + k));
      if (m.dot(n) <= 0) bad++;
    }
  }
  return bad;
}

const trapArea = (0.08 + 0.04) / 2 * 0.05;

describe('square stays the flat prism, vertex for vertex', () => {
  const prism = (loop: [number, number][]): Float32Array => {
    const shape = new THREE.Shape();
    shape.moveTo(loop[0]![0], loop[0]![1]);
    for (const [x, y] of loop.slice(1)) shape.lineTo(x, y);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry([shape], { depth: T, bevelEnabled: false });
    geo.translate(0, 0, -T / 2);
    // One fin at rotation 0: the root leading edge is 0.1 + 0.3 - 0.08 = 0.32 on the 24 mm tube.
    geo.translate(0.32, R, 0);
    geo.applyMatrix4(new THREE.Matrix4().makeRotationX(0));
    return geo.getAttribute('position').array as Float32Array;
  };

  it('a square trapezoid is exactly three\'s ExtrudeGeometry of its outline', () => {
    const got = finPiece(onTube({ ...TRAP, crossSection: 'square' })).geometry.getAttribute('position').array;
    expect(Array.from(got)).toEqual(Array.from(prism([[0, 0], [0.03, 0.05], [0.07, 0.05], [0.08, 0]])));
  });

  it.each([
    ['absent', {}],
    ['square with an airfoilSection stored', { crossSection: 'square', airfoilSection: 'biconvex', finLeRadius: 0.001 }],
    ['an unknown section name', { crossSection: 'wedge' }],
  ])('%s draws byte-identical to square', (_label, extra) => {
    for (const planform of [TRAP, ELLIPSE, FREE]) {
      const a = finPiece(onTube({ ...planform, crossSection: 'square' })).geometry.getAttribute('position').array;
      const b = finPiece(onTube({ ...planform, ...extra })).geometry.getAttribute('position').array;
      expect(Array.from(b)).toEqual(Array.from(a));
    }
  });
});

describe.each(SECTIONS)('a %s fin is a shaped, closed, outward surface', (_name, section) => {
  it.each([
    ['trapezoid', onTube({ ...TRAP, ...section })],
    ['elliptical', onTube({ ...ELLIPSE, ...section })],
    ['freeform on a body tube', onTube({ ...FREE, ...section })],
    ['freeform seated on a conical boat tail', onTransition('conical', 0.027, 0.019, { ...FREE, ...section })],
    ['freeform seated on an ogive boat tail', onTransition('ogive', 0.027, 0.019, { ...FREE, ...section })],
    ['freeform seated on a conical flare', onTransition('conical', 0.0125, 0.025, { ...FREE, ...section })],
  ])('%s', (_where, tree) => {
    const fin = finPiece(tree);
    expect(fin).toBeDefined();
    const g = fin.geometry;
    expect(oddEdges(g)).toBe(0);
    expect(volume(g)).toBeGreaterThan(0);
    expect(inwardNormals(g)).toBe(0);
    const zs = corners(g).map(([, , z]) => Math.abs(z));
    // Never thicker than the stock; full thickness somewhere (a NACA's
    // cosine samples straddle its 30 % peak: within 0.05 %); thinner somewhere.
    expect(Math.max(...zs)).toBeLessThanOrEqual(T / 2 + 1e-9);
    expect(Math.max(...zs)).toBeGreaterThan(T / 2 * 0.9995);
    expect(zs.some((z) => z < T / 2 - 1e-5)).toBe(true);
  });
});

describe('the drawn section is the section law (volume over planform x stock)', () => {
  // The area ratios of understand-0-xsec.md §4, chamfers at their defaults.
  it.each([
    // Drawn with flat facets: the polygonal laws within 0.3 %, the curved
    // ones within 1.2 % (24 cosine samples cut a NACA's nose, 12 straight
    // ones a biconvex's arc: the trapezoid rule's own 0.7 % there).
    ['naca', { crossSection: 'airfoil', airfoilSection: 'naca' }, 0.685, 0.012],
    ['plain airfoil = NACA', { crossSection: 'airfoil' }, 0.685, 0.012],
    ['hexagonal 1 - (a1 + a2)/2', { crossSection: 'airfoil', airfoilSection: 'hexagonal' }, 2 / 3, 0.003],
    ['doublewedge', { crossSection: 'airfoil', airfoilSection: 'doublewedge' }, 0.5, 0.003],
    ['biconvex', { crossSection: 'airfoil', airfoilSection: 'biconvex' }, 2 / 3, 0.012],
    ['hexbluntbase 1 - a1/2', { crossSection: 'airfoil', airfoilSection: 'hexbluntbase' }, 5 / 6, 0.003],
    ['singlewedge', { crossSection: 'airfoil', airfoilSection: 'singlewedge' }, 0.5, 0.003],
  ] as const)('%s', (_name, section, ratio, tol) => {
    const v = volume(finPiece(onTube({ ...TRAP, ...section })).geometry);
    const got = v / (trapArea * T);
    expect(Math.abs(got - ratio) / ratio).toBeLessThan(tol);
    // Faceting only ever cuts material away from a convex section.
    if (tol > 0.003) expect(got).toBeLessThan(ratio + 1e-4);
  });

  it('rounded: semicircular edges of radius t/2 at every station', () => {
    // Each edge loses t^2 (1/2 - pi/8) from the t x c rectangle, at every
    // station: over the span that is 2 t^2 (1/2 - pi/8) x height.
    const v = volume(finPiece(onTube({ ...TRAP, crossSection: 'rounded' })).geometry);
    const exact = trapArea * T - 2 * T * T * (0.5 - Math.PI / 8) * 0.05;
    expect(Math.abs(v - exact) / exact).toBeLessThan(0.002);
  });

  it('a pointed-tip fin still closes (the tip station has no chord)', () => {
    const g = finPiece(onTube({ ...TRAP, tipChord: 0, crossSection: 'airfoil' })).geometry;
    expect(oddEdges(g)).toBe(0);
    expect(volume(g)).toBeGreaterThan(0);
  });
});

describe('thickness comes from the fin\'s OWN outline, not the seated lobe', () => {
  it('on a flare the rising root cuts the fin at its full thickness, not at a rounded edge', () => {
    // Fore end of the flare at x = 0.1. The body climbs under the fin: its
    // root runs from (0, 0) up to 9.4 mm at 60 mm. At each height below that,
    // the drawn loop ends where the body cuts it — the fin's own trailing edge
    // there is still 60 mm aft, so the cut is mid-chord: full thickness.
    const tree = onTransition('conical', 0.0125, 0.025, {
      type: 'freeformfinset', points: [[0, 0], [0.01, 0.03], [0.05, 0.03], [0.06, 0]], crossSection: 'rounded',
    });
    const g = finPiece(tree).geometry;
    expect(oddEdges(g)).toBe(0);
    const surface = profileRadius('conical', undefined, 0.08, 0.0125, 0.025);
    const root = corners(g).filter(([x, y]) => Math.abs(y - surface(x - 0.1)) < 1e-6);
    // Full thickness on the body from just aft of the leading edge's rounding
    // to just short of the own trailing edge's: the cut face is a wall of
    // height t. Read off the lobe's own chord instead, the root would be a
    // trailing edge — thickness 0 all along it.
    const full = root.filter(([, , z]) => Math.abs(Math.abs(z) - T / 2) < 1e-5);
    expect(Math.min(...full.map(([x]) => x))).toBeLessThan(0.105);
    expect(Math.max(...full.map(([x]) => x))).toBeGreaterThan(0.15);
  });

  it('on a body tube the same fin\'s root has rounded corners (thickness 0 at the LE and TE)', () => {
    const g = finPiece(onTube({ type: 'freeformfinset', points: [[0, 0], [0.01, 0.03], [0.05, 0.03], [0.06, 0]],
      crossSection: 'rounded' })).geometry;
    const atTe = corners(g).filter(([x, y]) => Math.abs(x - 0.4) < 1e-7 && Math.abs(y - R) < 1e-7);
    expect(atTe.length).toBeGreaterThan(0);
    for (const [, , z] of atTe) expect(Math.abs(z)).toBeLessThan(1e-7);
  });
});

describe('an outline with more than one chord at a height falls back to the flat prism, and says so', () => {
  // The W: two lobes meeting at the tube.
  const W = { type: 'freeformfinset', points: [[0, 0], [0.02, 0.03], [0.04, -0.01], [0.06, 0.03], [0.08, 0]] };

  it('draws exactly the square prism', () => {
    const a = finPiece(onTube({ ...W, crossSection: 'square' })).geometry.getAttribute('position').array;
    const b = finPiece(onTube({ ...W, crossSection: 'airfoil' })).geometry.getAttribute('position').array;
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('finSectionFlatReason names it, and only it', () => {
    expect(finSectionFlatReason({ id: 'f', ...W, crossSection: 'airfoil' } as ComponentNode)).toBe('outline');
    expect(finSectionFlatReason({ id: 'f', ...W, crossSection: 'square' } as ComponentNode)).toBe(null);
    expect(finSectionFlatReason({ id: 'f', ...FREE, crossSection: 'rounded' } as ComponentNode)).toBe(null);
    expect(finSectionFlatReason({ id: 'f', ...TRAP, crossSection: 'airfoil' } as ComponentNode)).toBe(null);
  });

  // N062 review: an outline with one chord at every height AS TYPED that the
  // body makes hook-shaped AS SEATED. On a conical 15 -> 27 mm transition the
  // trailing corner rises onto the body at y = 10.7 mm, above the interior
  // point at 9.5 mm. One predicate decides it for the 3D view, the print and
  // the panel's note, on the same seat.
  const hookTree = (crossSection: string): { tree: RocketTree; fin: ComponentNode } => {
    const fin = { id: 'f', type: 'freeformfinset', crossSection, thickness: 0.003, finCount: 3,
      position: { method: 'top', offset: 0.0056 },
      points: [[0, 0], [0.0345, 0.0343], [0.0672, 0.0298], [0.0244, 0.0095], [0.0892, 0]] } as unknown as ComponentNode;
    const tree = { name: 'R', components: [{ id: 's1', type: 'stage', children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.015 },
      { id: 't1', type: 'transition', shape: 'conical', length: 0.1, foreRadius: 0.015, aftRadius: 0.027, children: [fin] },
    ] }] } as unknown as RocketTree;
    return { tree, fin };
  };

  it('a fin the body makes hook-shaped as seated: the view draws the prism, and the one predicate says "seated"', () => {
    const shaped = hookTree('airfoil');
    const square = hookTree('square');
    const a = finPiece(square.tree).geometry.getAttribute('position').array;
    const b = finPiece(shaped.tree).geometry.getAttribute('position').array;
    expect(Array.from(b)).toEqual(Array.from(a));
    const ctx = solidContextFor(shaped.tree, shaped.fin);
    expect(finSectionFlatReason(shaped.fin)).toBe(null); // the outline as typed is fine
    expect(finSectionFlatReason(shaped.fin, ctx.finMount, ctx.finFront)).toBe('seated');
    expect(finPrintShape(shaped.fin, ctx)).toEqual({ kind: 'fallback', law: 'naca', reason: 'seated' });
  });
});

describe('triangle counts stay sane for a set re-meshed on every edit', () => {
  it.each([
    // Per fin; a set is up to 8 of them, re-meshed on every edit.
    ['trapezoid NACA', onTube({ ...TRAP, crossSection: 'airfoil' }), 600],
    ['trapezoid rounded', onTube({ ...TRAP, crossSection: 'rounded' }), 400],
    ['elliptical NACA', onTube({ ...ELLIPSE, crossSection: 'airfoil' }), 6000],
    ['freeform NACA on an ogive boat tail', onTransition('ogive', 0.027, 0.019, { ...FREE, crossSection: 'airfoil' }), 6000],
    ['trapezoid NACA + fillets', onTube({ ...TRAP, crossSection: 'airfoil', filletRadius: 0.005 }), 1600],
  ])('%s', (_name, tree, cap) => {
    const g = finPiece(tree as RocketTree).geometry;
    expect(g.getAttribute('position').count / 3).toBeLessThanOrEqual(cap as number);
  });
});

/**
 * One side's fillet section (m²) in the plane across the root: the rolling
 * ball of radius r touching the fin side (half-thickness h) and a tube of
 * radius Rb. Polygon (axis, body under the fin side D, fin foot A, centre C,
 * body foot B) less the fillet's sector at C and the body's sector at the axis.
 */
function filletArea(Rb: number, h: number, r: number): number {
  const cz = h + r;
  const cy = Math.sqrt((Rb + r) ** 2 - cz * cz);
  const D: [number, number] = [Math.sqrt(Rb * Rb - h * h), h];
  const A: [number, number] = [cy, h];
  const C: [number, number] = [cy, cz];
  const B: [number, number] = [cy * Rb / (Rb + r), cz * Rb / (Rb + r)];
  const poly: [number, number][] = [[0, 0], D, A, C, B];
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    area += (x0 * y1 - x1 * y0) / 2;
  }
  const fillet = Math.acos(((A[0] - C[0]) * (B[0] - C[0]) + (A[1] - C[1]) * (B[1] - C[1])) / (r * r));
  const body = Math.atan2(B[1], B[0]) - Math.atan2(D[1], D[0]);
  return Math.abs(area) - fillet * r * r / 2 - body * Rb * Rb / 2;
}

describe('root fillets', () => {
  const R_F = 0.005;
  const vertsOf = (g: THREE.BufferGeometry): V[] => corners(g);
  const key = (p: V) => p.map((c) => Math.round(c * 1e7)).join(',');
  /** The fillet's own vertices: the fin piece less the same fin drawn without one. */
  const filletVerts = (fin: Record<string, unknown>, tree: (f: Record<string, unknown>) => RocketTree): V[] => {
    const bare = new Set(vertsOf(finPiece(tree(fin)).geometry).map(key));
    return vertsOf(finPiece(tree({ ...fin, filletRadius: R_F })).geometry).filter((p) => !bare.has(key(p)));
  };
  const radial = ([, y, z]: V) => Math.hypot(y, z);

  it('a square fin keeps its prism and gains a closed fillet on each side, no new piece', () => {
    const bare = buildPieces(onTube({ ...TRAP, finCount: 3 })).pieces;
    const withF = buildPieces(onTube({ ...TRAP, finCount: 3, filletRadius: R_F })).pieces;
    expect(withF.map((p) => p.key)).toEqual(bare.map((p) => p.key));
    const fin = withF.find((p) => p.key.startsWith('fin'))!.geometry;
    const prism = new Set(vertsOf(bare.find((p) => p.key.startsWith('fin'))!.geometry).map(key));
    const got = new Set(vertsOf(fin).map(key));
    for (const k of prism) expect(got.has(k)).toBe(true);
    expect(oddEdges(fin)).toBe(0);
    expect(inwardNormals(fin)).toBe(0);
    // Two concave fillets along the 80 mm root, each the rolling-ball section
    // between the fin's side and the tube.
    const added = volume(fin) - volume(bare.find((p) => p.key.startsWith('fin'))!.geometry);
    expect(added / (2 * filletArea(R, T / 2, R_F) * 0.08)).toBeCloseTo(1, 1);
  });

  it("at a vanishing thickness is the kernel's own fillet section (FinSet.java:637-658)", () => {
    // calculateFilletCrossSection ignores the fin's thickness: triangle
    // (axis, fin foot, centre) less the fillet's and the body's sectors.
    const hyp = R_F + R;
    const inner = Math.asin(R_F / hyp);
    const outer = Math.acos(R_F / hyp);
    const kernel = Math.tan(outer) * R_F * R_F / 2 - outer * R_F * R_F / 2 - inner * R * R / 2;
    expect(filletArea(R, 0, R_F) / kernel).toBeCloseTo(1, 9);
    const thin = 1e-5;
    const bare = finPiece(onTube({ ...TRAP, thickness: thin })).geometry;
    const withF = finPiece(onTube({ ...TRAP, thickness: thin, filletRadius: R_F })).geometry;
    expect((volume(withF) - volume(bare)) / (2 * kernel * 0.08)).toBeCloseTo(1, 1);
  });

  it('sits between the fin side and the tube, along the root, on both sides', () => {
    const f = filletVerts({ ...TRAP }, onTube);
    expect(f.length).toBeGreaterThan(0);
    for (const p of f) {
      expect(p[0]).toBeGreaterThanOrEqual(0.32 - 1e-7); // root leading edge
      expect(p[0]).toBeLessThanOrEqual(0.4 + 1e-7); // root trailing edge
      expect(radial(p)).toBeGreaterThanOrEqual(R - 1e-6); // never inside the tube
      expect(Math.abs(p[2])).toBeGreaterThanOrEqual(T / 2 - 1e-7); // never inside the fin
      expect(Math.abs(p[2])).toBeLessThanOrEqual(T / 2 + R_F + 1e-6);
    }
    // Its feet: on the tube, and on the fin's side.
    expect(f.some((p) => Math.abs(radial(p) - R) < 1e-6 && Math.abs(p[2]) > T / 2 + R_F / 2)).toBe(true);
    expect(f.some((p) => Math.abs(Math.abs(p[2]) - T / 2) < 1e-7 && p[1] > R + R_F / 2)).toBe(true);
    expect(f.some((p) => p[2] > 0)).toBe(true);
    expect(f.some((p) => p[2] < 0)).toBe(true);
  });

  it('meets a shaped fin at its own side (rounded: full thickness past the edge rounding)', () => {
    // Unswept, so the fin's side at the fillet's top foot is the root's.
    const RECT = { ...TRAP, tipChord: 0.08, sweep: 0, crossSection: 'rounded' };
    const g = finPiece(onTube({ ...RECT, filletRadius: R_F })).geometry;
    expect(oddEdges(g)).toBe(0);
    expect(inwardNormals(g)).toBe(0);
    const f = filletVerts(RECT, onTube);
    // Where the rounded edge ends, the top foot is on the fin's flat side.
    expect(f.some((p) => p[1] > R + R_F / 2 && Math.abs(Math.abs(p[2]) - T / 2) < 2e-6)).toBe(true);
    // At the root's ends the rounded edge is thin, and the fillet follows it in.
    expect(f.some((p) => Math.abs(p[2]) < T / 2 - 1e-4)).toBe(true);
  });

  it('follows a seated root down a boat tail, its feet on the transition', () => {
    const fin = { ...FREE, crossSection: 'airfoil' };
    const tree = (f: Record<string, unknown>) => onTransition('ogive', 0.027, 0.019, f);
    const g = finPiece(tree({ ...fin, filletRadius: R_F })).geometry;
    expect(oddEdges(g)).toBe(0);
    expect(inwardNormals(g)).toBe(0);
    const surface = profileRadius('ogive', undefined, 0.08, 0.027, 0.019);
    const f = filletVerts(fin, tree);
    expect(f.length).toBeGreaterThan(0);
    for (const p of f) expect(radial(p)).toBeGreaterThanOrEqual(surface(p[0] - 0.1) - 1e-6);
    const feet = f.filter((p) => Math.abs(radial(p) - surface(p[0] - 0.1)) < 1e-6);
    // Feet all along the 60 mm root, on the surface as it falls.
    expect(Math.min(...feet.map((p) => p[0]))).toBeLessThan(0.105);
    expect(Math.max(...feet.map((p) => p[0]))).toBeGreaterThan(0.155);
  });

  it('turns with a canted fin and keeps its feet on the tube', () => {
    for (const cant of [0.17, -0.26]) {
      const g = finPiece(onTube({ ...TRAP, crossSection: 'rounded', cant, filletRadius: R_F })).geometry;
      expect(oddEdges(g)).toBe(0);
      expect(inwardNormals(g)).toBe(0);
      const f = filletVerts({ ...TRAP, crossSection: 'rounded', cant }, onTube);
      for (const p of f) expect(radial(p)).toBeGreaterThanOrEqual(R - 1e-6);
      expect(f.filter((p) => Math.abs(radial(p) - R) < 1e-6).length).toBeGreaterThan(10);
    }
  });

  it('stops at the tube\'s aft end when the fin overhangs it', () => {
    const f = filletVerts({ ...TRAP, position: { method: 'bottom', offset: 0.02 } }, onTube);
    expect(f.length).toBeGreaterThan(0);
    expect(Math.max(...f.map((p) => p[0]))).toBeLessThanOrEqual(0.4 + 1e-7);
  });

  it('draws nothing at radius 0, and leaves the tree alone', () => {
    const tree = onTube({ ...TRAP, crossSection: 'airfoil', filletRadius: 0 });
    const before = structuredClone(tree);
    const a = finPiece(tree).geometry.getAttribute('position').array;
    const b = finPiece(onTube({ ...TRAP, crossSection: 'airfoil' })).geometry.getAttribute('position').array;
    expect(Array.from(a)).toEqual(Array.from(b));
    buildPieces(onTube({ ...TRAP, crossSection: 'airfoil', filletRadius: R_F }));
    expect(tree).toEqual(before);
  });
});

describe('surface finish -> material', () => {
  const ORDER = ['rough', 'roughunfinished', 'unfinished', 'normal', 'smooth', 'optimum', 'polished',
    'finishpolished', 'mirror'];

  it('maps all nine finishes, monotone from rough to mirror', () => {
    expect(Object.keys(FINISH_MATERIAL).sort()).toEqual([...ORDER].sort());
    for (let i = 1; i < ORDER.length; i++) {
      const a = FINISH_MATERIAL[ORDER[i - 1]!]!;
      const b = FINISH_MATERIAL[ORDER[i]!]!;
      expect(b.roughness).toBeLessThan(a.roughness);
      expect(b.metalness).toBeGreaterThanOrEqual(a.metalness);
    }
  });

  it('Regular paint, an absent finish and an unknown one all draw as before (0.6 / 0.05)', () => {
    expect(pieceMaterial({ finish: 'normal' })).toEqual({ roughness: 0.6, metalness: 0.05 });
    expect(pieceMaterial({})).toEqual({ roughness: 0.6, metalness: 0.05 });
    expect(pieceMaterial({ finish: 'chrome' })).toEqual({ roughness: 0.6, metalness: 0.05 });
  });

  it.each(['constructor', '__proto__', 'toString'])('S4b-4 inherited finish %s uses Regular paint', finish => {
    expect(pieceMaterial({ finish })).toEqual({ roughness: 0.6, metalness: 0.05 });
  });

  it.each(['constructor', '__proto__', 'toString'])('S4b-4 inherited node finish %s is not carried into a piece', finish => {
    const tree: RocketTree = { components: [{ type: 'bodytube', id: 'body', length: 0.3, outerRadius: R, finish }] };
    const pieces = buildPieces(tree).pieces;
    expect(pieces.length).toBeGreaterThan(0);
    for (const piece of pieces) {
      expect(piece.finish).toBeUndefined();
      expect(pieceMaterial(piece)).toEqual({ roughness: 0.6, metalness: 0.05 });
      piece.geometry.dispose();
    }
  });

  it('rides on each part\'s piece, not on the node', () => {
    const tree: RocketTree = {
      name: 'R',
      components: [{ id: 's1', type: 'stage', children: [
        { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: R, finish: 'mirror' },
        { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: R, finish: 'rough', children: [
          { id: 'f', ...TRAP, finCount: 3, thickness: T, finish: 'polished', position: { method: 'bottom', offset: 0 } },
          { id: 'tf', type: 'tubefinset', outerRadius: 0.006, length: 0.05, finCount: 3, finish: 'smooth',
            position: { method: 'top', offset: 0 } },
          { id: 'mm', type: 'innertube', length: 0.1, outerRadius: 0.009, position: { method: 'bottom', offset: 0 } },
        ] },
      ] }],
    } as unknown as RocketTree;
    const before = structuredClone(tree);
    const pieces = buildPieces(tree).pieces;
    const finishOf = (prefix: string) => [...new Set(pieces.filter((p) => p.key.startsWith(prefix)).map((p) => p.finish))];
    expect(finishOf('nose')).toEqual(['mirror']);
    expect(finishOf('body')).toEqual(['rough']);
    expect(finishOf('fin')).toEqual(['polished']);
    expect(finishOf('tubefin')).toEqual(['smooth']);
    expect(finishOf('inner')).toEqual([undefined]);
    expect(tree).toEqual(before);
  });
});

it('S4a-2 zero-radius tube fins emit no 3D or shell-export pieces', () => {
  const tree: RocketTree = { components: [{ type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.027,
    children: [{ type: 'tubefinset', id: 'tf', length: 0.05, finCount: 6, outerRadius: 0 }] }] };
  const pieces = buildPieces(tree).pieces;
  expect(pieces.filter(p => p.key.startsWith('tubefin'))).toHaveLength(0);
  for (const p of pieces) p.geometry.dispose();
});
describe('a freeform fin whose last point desktop OR stored on the body (N062 review)', () => {
  // Desktop OR saves a boat-tail or flare fin's last point ON the body
  // (FreeformFinSet.clampLastPoint, written by FreeformFinSetSaver), so its y
  // is not 0 and the closing root edge slopes. That edge is neither the
  // leading nor the trailing edge: the section keeps its full thickness all
  // along the seated root — in the fin, and in a fillet against it.
  const T4 = 0.004;
  const onCone = (length: number, fore: number, aft: number, fin: Record<string, unknown>): RocketTree => ({
    name: 'R',
    components: [{ id: 's1', type: 'stage', children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: fore },
      { id: 't1', type: 'transition', shape: 'conical', length, foreRadius: fore, aftRadius: aft, children: [{
        id: 'f', finCount: 1, thickness: T4, position: { method: 'top', offset: 0 }, ...fin,
      }] },
    ] }],
  } as unknown as RocketTree);
  /** Boat tail 27 -> 19 mm over 100 mm: the last point (100 mm aft) sits on it at y = -8 mm. */
  const BOAT = { length: 0.1, fore: 0.027, aft: 0.019, from: 0.02, to: 0.08,
    points: [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, -0.008]] };
  /** Flare 19 -> 25 mm over 80 mm: the last point (80 mm aft) sits on it at y = +6 mm. */
  const FLARE = { length: 0.08, fore: 0.019, aft: 0.025, from: 0.01, to: 0.07,
    points: [[0, 0], [0.02, 0.04], [0.06, 0.04], [0.08, 0.006]] };
  type Case = typeof BOAT;

  const geometry = (c: Case, fin: Record<string, unknown>): THREE.BufferGeometry => {
    const g = finPiece(onCone(c.length, c.fore, c.aft, { type: 'freeformfinset', points: c.points, ...fin })).geometry;
    expect(oddEdges(g)).toBe(0);
    expect(inwardNormals(g)).toBe(0);
    return g;
  };
  const surfaceOf = (c: Case) => profileRadius('conical', undefined, c.length, c.fore, c.aft);
  /** Vertices on the body under the root in [from, to]: the fin's root on the profile line, or a fillet foot on the surface. */
  const rootOnBody = (c: Case, g: THREE.BufferGeometry): V[] => {
    const surface = surfaceOf(c);
    return corners(g).filter(([x, y, z]) => x >= 0.1 + c.from && x <= 0.1 + c.to
      && (Math.abs(y - surface(x - 0.1)) < 1e-7 || Math.abs(Math.hypot(y, z) - surface(x - 0.1)) < 1e-7));
  };
  /** The top skin's z over the planform point (x, y): the highest triangle covering it. */
  const topZ = (g: THREE.BufferGeometry, x: number, y: number): number => {
    const c = corners(g);
    let best = -Infinity;
    for (let i = 0; i < c.length; i += 3) {
      const [a, b, d] = [c[i]!, c[i + 1]!, c[i + 2]!];
      const det = (b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1]);
      if (Math.abs(det) < 1e-16) continue;
      const u = ((x - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (y - a[1])) / det;
      const v = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / det;
      if (u < -1e-12 || v < -1e-12 || u + v > 1 + 1e-12) continue;
      best = Math.max(best, a[2] + u * (b[2] - a[2]) + v * (d[2] - a[2]));
    }
    return best;
  };

  it.each([['boat tail', BOAT], ['flare', FLARE]])('%s: a rounded fin is full thickness all along its seated root', (_n, c) => {
    const g = geometry(c, { crossSection: 'rounded' });
    const surface = surfaceOf(c);
    for (let k = 0; k <= 6; k++) {
      const x = 0.1 + c.from + (k * (c.to - c.from)) / 6;
      expect(topZ(g, x, surface(x - 0.1) + 1e-5)).toBeCloseTo(T4 / 2, 6);
    }
  });

  it.each([['boat tail', BOAT], ['flare', FLARE]])('%s: a hexagonal fin\'s root reaches full thickness on its plateau', (_n, c) => {
    const root = rootOnBody(c, geometry(c, { crossSection: 'airfoil', airfoilSection: 'hexagonal' }));
    expect(root.length).toBeGreaterThan(0);
    for (const [, , z] of root) expect(Math.abs(z)).toBeCloseTo(T4 / 2, 7);
  });

  // Edges vertical where the fillet stands, so the fin's section (hexagonal:
  // full thickness from 1/3 to 2/3 of the chord) is the same from the root up
  // to the fillet's top. A fillet foot is on the fin's side: full thickness on
  // the plateau, the chamfer's own thickness on a chamfer (the fillet's
  // stations follow its taper into the root corners, so some sit there).
  const BOXY_BOAT = { ...BOAT, points: [[0, 0], [0, 0.02], [0.02, 0.04], [0.08, 0.04], [0.1, 0.02], [0.1, -0.008]] };
  const BOXY_FLARE = { ...FLARE, points: [[0, 0], [0, 0.02], [0.02, 0.04], [0.06, 0.04], [0.08, 0.02], [0.08, 0.006]] };
  it.each([['boat tail', BOXY_BOAT], ['flare', BOXY_FLARE]])('%s: a fillet meets the fin side at full thickness, never inside the fin', (_n, c) => {
    const hex = { crossSection: 'airfoil', airfoilSection: 'hexagonal' };
    const root = rootOnBody(c, geometry(c, { ...hex, filletRadius: 0.005 }));
    const bare = geometry(c, hex);
    const surface = surfaceOf(c);
    const chord = c.points[c.points.length - 1]![0]!;
    expect(root.some(([, , z]) => Math.abs(z) > T4 / 2 + 1e-4)).toBe(true); // the fillet's feet on the body
    const plateau = (x: number) => (x - 0.1) / chord > 1 / 3 - 1e-6 && (x - 0.1) / chord < 2 / 3 + 1e-6;
    expect(root.filter(([x]) => plateau(x)).length).toBeGreaterThan(4);
    for (const [x, , z] of root) {
      if (plateau(x)) expect(Math.abs(z)).toBeGreaterThanOrEqual(T4 / 2 - 1e-7);
      // Never inside the fin: at least the fin's own top skin just above the root.
      expect(Math.abs(z)).toBeGreaterThanOrEqual(topZ(bare, x, surface(x - 0.1) + 1e-5) - 1e-6);
    }
  });

  it('boat tail: a NACA fin reaches full thickness on the root at 30% of the chord', () => {
    const root = rootOnBody(BOAT, geometry(BOAT, { crossSection: 'airfoil' }));
    const near = root.filter(([x]) => Math.abs(x - 0.13) < 0.006);
    expect(near.length).toBeGreaterThan(0);
    expect(Math.max(...near.map(([, , z]) => Math.abs(z)))).toBeGreaterThan(0.98 * T4 / 2);
  });
});

describe('overlapping hexagonal chamfers draw the full stock (N062 review)', () => {
  it('80 mm + 80 mm chamfers on a 78 mm MAC (a1 = a2 = 0.95) draw 4 mm thick', () => {
    const g = finPiece(onTube({ type: 'trapezoidfinset', rootChord: 0.1, tipChord: 0.05, sweep: 0.05, height: 0.06,
      crossSection: 'airfoil', airfoilSection: 'hexagonal', airfoilLeDiamond: 0.08, airfoilTeDiamond: 0.08 })).geometry;
    expect(oddEdges(g)).toBe(0);
    expect(inwardNormals(g)).toBe(0);
    expect(Math.max(...corners(g).map(([, , z]) => Math.abs(z)))).toBeCloseTo(T / 2, 7);
  });
});

describe('root fillets fit the planform: none ahead of a swept leading edge or aft of a forward-swept trailing edge (N062 review)', () => {
  const RB = 0.02;
  const T3 = 0.003;
  const R_F = 0.008;
  const tree = (fin: Record<string, unknown>): RocketTree => ({
    name: 'R',
    components: [{ id: 's1', type: 'stage', children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: RB },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: RB, children: [{
        id: 'f', finCount: 1, thickness: T3, position: { method: 'bottom', offset: 0 }, ...fin,
      }] },
    ] }],
  } as unknown as RocketTree);
  // The reviewer's 50-degree swept trapezoid (its tip runs aft of the root's
  // trailing corner), and a swept freeform with a forward-swept trailing edge.
  const SWEPT = { type: 'trapezoidfinset', rootChord: 0.08, tipChord: 0.03, sweep: 0.0596, height: 0.05 };
  const SWEPT_PLANFORM: [number, number][] = [[0, 0], [0.0596, 0.05], [0.0896, 0.05], [0.08, 0]];
  const SWEPT_FREE_POINTS: [number, number][] = [[0, 0], [0.02, 0.02], [0.045, 0.05], [0.065, 0.05], [0.08, 0.025], [0.09, 0]];
  const SWEPT_FREE = { type: 'freeformfinset', points: SWEPT_FREE_POINTS };
  const CASES: [string, Record<string, unknown>, [number, number][], number][] = [
    ['swept trapezoid', SWEPT, SWEPT_PLANFORM, 0.08],
    ['swept freeform', SWEPT_FREE, SWEPT_FREE_POINTS, 0.09],
  ];
  const SECTIONS3: [string, Record<string, unknown>][] = [
    ['square', { crossSection: 'square' }],
    ['rounded', { crossSection: 'rounded' }],
    ['airfoil', { crossSection: 'airfoil' }],
  ];

  /** The planform's chord [lead, trail] at height y (a single-chord loop). */
  const chordAt = (loop: [number, number][], y: number): [number, number] => {
    const xs: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      const [x1, y1] = loop[i]!;
      const [x2, y2] = loop[(i + 1) % loop.length]!;
      if (y1 === y2) { if (y1 === y) xs.push(x1, x2); continue; }
      if ((y - y1) * (y - y2) <= 0) xs.push(x1 + ((x2 - x1) * (y - y1)) / (y2 - y1));
    }
    return [Math.min(...xs), Math.max(...xs)];
  };
  /** The bare fin's top skin z over a planform point: the highest triangle covering it. */
  const topZ = (c: V[], x: number, y: number): number => {
    let best = -Infinity;
    for (let i = 0; i < c.length; i += 3) {
      const [a, b, d] = [c[i]!, c[i + 1]!, c[i + 2]!];
      const det = (b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1]);
      if (Math.abs(det) < 1e-16) continue;
      const u = ((x - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (y - a[1])) / det;
      const v = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / det;
      if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
      best = Math.max(best, a[2] + u * (b[2] - a[2]) + v * (d[2] - a[2]));
    }
    return best;
  };
  const key = (p: V) => p.map((c) => Math.round(c * 1e7)).join(',');

  describe.each(CASES)('%s', (_n, fin, planform, rootChord) => {
    it.each(SECTIONS3)('%s: every fillet vertex lies over the planform at its height, none inside the fin', (_s, section) => {
      const bareG = finPiece(tree({ ...fin, ...section })).geometry;
      const withG = finPiece(tree({ ...fin, ...section, filletRadius: R_F })).geometry;
      expect(oddEdges(withG)).toBe(0);
      expect(inwardNormals(withG)).toBe(0);
      // Fin frame: x aft of the root's leading corner, y out from the tube.
      const start = 0.4 - rootChord;
      const toFin = ([x, y, z]: V): V => [x - start, y - RB, z];
      const bare = corners(bareG).map(toFin);
      const bareKeys = new Set(corners(bareG).map(key));
      const fillet = corners(withG).filter((p) => !bareKeys.has(key(p))).map(toFin);
      expect(fillet.length).toBeGreaterThan(0);
      let ahead = 0;
      let inside = 0;
      for (const [x, y, z] of fillet) {
        // Below the root (a foot on the tube) the root's own chord bounds it.
        const [lead, trail] = chordAt(planform, Math.max(0, y));
        if (x < lead - 1e-6 || x > trail + 1e-6) ahead++;
        if (y > 1e-6) {
          const top = topZ(bare, x, y);
          if (top > -Infinity && Math.abs(z) < top - 1e-5) inside++;
        }
      }
      expect(ahead).toBe(0);
      expect(inside).toBe(0);
      // Still a fillet of its full radius along the middle of the root: its
      // top foot on the fin side as high as the rolling ball puts it, its body
      // foot as far out.
      const cy = Math.sqrt((RB + R_F) ** 2 - (T3 / 2 + R_F) ** 2) - RB;
      const mid = fillet.filter(([x]) => x > 0.03 && x < 0.06);
      expect(Math.max(...mid.map(([, y]) => y))).toBeGreaterThan(cy - 1e-4);
      expect(Math.max(...mid.map(([, , z]) => Math.abs(z)))).toBeGreaterThan((T3 / 2 + R_F) * RB / (RB + R_F) - 1e-4);
      // And it tapers to nothing at both root corners — including the
      // trapezoid's trailing corner, which its tip overhangs.
      // (A rounded or NACA fin's corner point IS the fillet's collapsed end,
      // so the fin's own vertex stands for it there.)
      expect(fillet.some(([x]) => x < 2e-3) && fillet.some(([x]) => x > rootChord - 2e-3)).toBe(true);
      const atCorners = fillet.filter(([x]) => Math.abs(x) < 1e-7 || Math.abs(x - rootChord) < 1e-7);
      for (const [, y, z] of atCorners) {
        expect(y).toBeLessThan(1e-6);
        expect(Math.abs(z)).toBeLessThan(T3 / 2 + 1e-6);
      }
    });
  });
});

describe('a canted shaped fin on a curved boat tail extends EVERY seated-root vertex (N062 review)', () => {
  const POINTS: [number, number][] = [[0, 0], [0.03, 0.05], [0.07, 0.05], [0.1, -0.008]];
  const CANT = 0.0873;
  const tree = (shape: string, fin: Record<string, unknown>): RocketTree => ({
    name: 'R',
    components: [{ id: 's1', type: 'stage', children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.027 },
      { id: 't1', type: 'transition', shape, length: 0.1, foreRadius: 0.027, aftRadius: 0.019, children: [{
        id: 'f', type: 'freeformfinset', finCount: 1, thickness: T, points: POINTS,
        position: { method: 'top', offset: 0 }, ...fin,
      }] },
    ] }],
  } as unknown as RocketTree);

  it.each([
    ['ogive', 'rounded'], ['ogive', 'airfoil'], ['parabolic', 'rounded'], ['parabolic', 'airfoil'],
    ['haack', 'rounded'], ['haack', 'airfoil'],
  ])('%s, %s', (shape, crossSection) => {
    const flat = corners(finPiece(tree(shape, { crossSection })).geometry);
    const canted = corners(finPiece(tree(shape, { crossSection, cant: CANT })).geometry);
    expect(canted.length).toBe(flat.length);
    const mount = profileMount(shape, undefined, 0.1, 0.027, 0.019);
    const root = finOnMount(POINTS, 0, mount).root;
    const onRootLine = (x: number, y: number): boolean => root.slice(1).some(([x2, y2], i) => {
      const [x1, y1] = root[i]!;
      if (x < Math.min(x1, x2) - 1e-8 || x > Math.max(x1, x2) + 1e-8) return false;
      // Float32 positions: a root vertex is within ~3e-9 of the line; the
      // nearest vertex OFF it (a row sample in the sliver at the trailing root
      // corner) is 2e-8 away.
      return Math.abs((x - x1) * (y2 - y1) - (y - y1) * (x2 - x1)) / Math.hypot(x2 - x1, y2 - y1) <= 1e-8;
    });
    // FinSet.getFinCantYOffset, as pieces.ts applies it about half the root chord.
    const hc = 0.05;
    const expected = (x: number, y: number): number => {
      const dx = Math.max(0, Math.min(0.1, x)) - hc;
      const rr = mount.radiusAt(hc + dx * Math.cos(CANT));
      const dz = dx * Math.sin(CANT);
      return y - rr + Math.sqrt(rr * rr - dz * dz);
    };
    let rootVerts = 0;
    let missed = 0;
    for (let i = 0; i < flat.length; i++) {
      const x = flat[i]![0] - 0.1;
      const y = flat[i]![1] - 0.027;
      if (!onRootLine(x, y)) continue;
      rootVerts++;
      if (Math.abs(canted[i]![1] - 0.027 - expected(x, y)) > 1e-7) missed++;
    }
    expect(rootVerts).toBeGreaterThan(40);
    expect(missed).toBe(0);
  });
});

describe('a freeform fin typed with its last point at y = 0 and the same fin stored desktop-style draw ONE mesh (N062 review, round 3)', () => {
  // Desktop OR stores the last point ON the body (FreeformFinSet.clampLastPoint);
  // the app's editor keeps it at y = 0 and finOnMount seats it there. Both are
  // one kernel fin, so the section's chords come from the fin AS SEATED and the
  // two must draw byte for byte the same surface — never a blunt trailing edge
  // where the seated edge runs ahead of the typed one.
  const tree = (length: number, fore: number, aft: number, fin: Record<string, unknown>): RocketTree => ({
    name: 'R',
    components: [{ id: 's1', type: 'stage', children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: fore },
      { id: 't1', type: 'transition', shape: 'conical', length, foreRadius: fore, aftRadius: aft, children: [{
        id: 'f', type: 'freeformfinset', finCount: 1, position: { method: 'top', offset: 0 }, ...fin,
      }] },
    ] }],
  } as unknown as RocketTree);
  // The reviewer's two fixtures: a 27 -> 19 mm boat tail over 100 mm (last
  // point 8 mm down on it), and the app's default freeform points on a
  // 19 -> 27 mm flare over 100 mm (last point 4 mm up on it).
  const CASES: [string, number, number, number, number, number[][], number[][]][] = [
    ['boat tail', 0.1, 0.027, 0.019, 0.004,
      [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, 0]], [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, -0.008]]],
    ['flare, default points', 0.1, 0.019, 0.027, 0.003,
      [[0, 0], [0.025, 0.05], [0.075, 0.05], [0.05, 0]], [[0, 0], [0.025, 0.05], [0.075, 0.05], [0.05, 0.004]]],
  ];
  const LAWS: [string, Record<string, unknown>][] = [
    ['rounded', { crossSection: 'rounded' }],
    ['airfoil (NACA)', { crossSection: 'airfoil' }],
    ['hexagonal', { crossSection: 'airfoil', airfoilSection: 'hexagonal' }],
    ['biconvex', { crossSection: 'airfoil', airfoilSection: 'biconvex' }],
    ['rounded + 5 mm fillets', { crossSection: 'rounded', filletRadius: 0.005 }],
  ];
  describe.each(CASES)('%s', (_n, length, fore, aft, thickness, typed, stored) => {
    it.each(LAWS)('%s: identical display meshes', (_s, section) => {
      const a = finPiece(tree(length, fore, aft, { thickness, points: typed, ...section })).geometry;
      const b = finPiece(tree(length, fore, aft, { thickness, points: stored, ...section })).geometry;
      expect(oddEdges(a)).toBe(0);
      expect(inwardNormals(a)).toBe(0);
      // Shaped, not the flat prism: its edges are thinner than the stock.
      expect(corners(a).some(([, , z]) => Math.abs(z) < thickness / 4)).toBe(true);
      expect(Array.from(a.getAttribute('position').array)).toEqual(Array.from(b.getAttribute('position').array));
      expect(Array.from(a.getAttribute('normal').array)).toEqual(Array.from(b.getAttribute('normal').array));
    });
  });
});

describe('a fillet\'s top foot lies ON the fin side (N062 review, round 3)', () => {
  // The fillet's top foot A is where the rolling ball touches the fin: its
  // height is the ball centre's, and the fin's half-thickness there sets how
  // far out the ball sits — h = halfAt(x, cy(h)), solved, not iterated three
  // times. Off the side, A left a ledge standing proud of the fin, or buried
  // the fillet's top edge inside it.
  type Case = { points: [number, number][]; mount: MountSurface; thickness: number; radius: number; fields: Record<string, unknown> };
  const CASES: [string, Case][] = [
    // The reviewer's swept-LE hexagonal freeform on a 21.49 mm tube: A stood 0.504 mm off the side at x = 100.8 mm.
    ['swept-LE hexagonal freeform on a tube', {
      points: [[0, 0], [0.0984, 0.00467], [0.1525, 0.02222], [0.1766, 0.02222], [0.1529, 0.00688], [0.1339, 0]],
      mount: flatMount(0.02149, 0.4), thickness: 0.00587, radius: 0.00931,
      fields: { crossSection: 'airfoil', airfoilSection: 'hexagonal' } }],
    // A realistic swept trapezoid (root 120 mm, 60 mm span, LE at 60 degrees), rounded 4.7 mm, 6 mm fillets.
    ['swept rounded trapezoid on a tube', {
      points: [[0, 0], [0.0346, 0.06], [0.0946, 0.06], [0.12, 0]],
      mount: flatMount(0.025, 0.4), thickness: 0.0047, radius: 0.006, fields: { crossSection: 'rounded' } }],
    // The reviewer's ogive boat tail fin whose fillet top was buried 0.7-1.4 mm in the fin near its TE corner.
    ['rounded fin on an ogive boat tail, near its TE corner', {
      points: [[0, 0], [0.0678, 0.031], [0.0891, 0.0776], [0.1458, 0.0776], [0.1219, 0.0161], [0.1034, 0]],
      mount: profileMount('ogive', undefined, 0.126, 0.01923, 0.01169), thickness: 0.0059, radius: 0.0076,
      fields: { crossSection: 'rounded' } }],
  ];
  it.each(CASES)('%s', (_n, c) => {
    const node = { id: 'f', type: 'freeformfinset', thickness: c.thickness, points: c.points, ...c.fields } as unknown as ComponentNode;
    const mounted = finOnMount(c.points, 0, c.mount);
    const loops = mounted.lobes.filter((l) => enclosesArea(l));
    const shaped = shapedFin(node, seatedChordPoints(c.points, 0, c.mount), loops, c.thickness)!;
    expect(shaped).not.toBeNull();
    const placement: FinPlacement = { front: 0, r0: mounted.r0, mount: c.mount, seated: true, cant: 0,
      halfChord: c.points[c.points.length - 1]![0] / 2, rootLine: mounted.root };
    const fillet = filletMesh(placement, rootRuns(placement, loops, shaped.rootStations), c.radius, shaped.halfAt, shaped.reach)!;
    expect(fillet).not.toBeNull();
    // Uncanted, every point of a fillet ring sits at its station's x; A is the
    // ring's highest point (at the ball centre's height) on each side.
    const tops = new Map<string, V>();
    const lows = new Map<string, number>();
    for (let i = 0; i < fillet.pos.length; i += 3) {
      const p: V = [fillet.pos[i]!, fillet.pos[i + 1]!, fillet.pos[i + 2]!];
      const k = `${p[0].toFixed(9)}|${Math.sign(p[2])}`;
      if (!tops.has(k) || tops.get(k)![1] < p[1]) tops.set(k, p);
      lows.set(k, Math.min(lows.get(k) ?? Infinity, p[1]));
    }
    let checked = 0;
    let worst = 0;
    for (const [k, [x, y, z]] of tops) {
      if (y - lows.get(k)! < 1e-6) continue; // a ring collapsed onto its root foot
      checked++;
      worst = Math.max(worst, Math.abs(Math.abs(z) - shaped.halfAt(x, y)));
    }
    expect(checked).toBeGreaterThan(10);
    expect(worst).toBeLessThanOrEqual(1e-6);
  });
});

describe('the drawn skin follows the section law on a tapered fin (N062 review, round 3)', () => {
  // A skin quad joins sample j of one row to sample j of the next; where the
  // chord changes a lot between the two rows the quad's flat triangles cut
  // across the section (a hexagonal ridge drawn kinked, up to 19 % of the
  // stock thick or thin with at most 4 rows a slab). Rows go in until no step
  // changes the chord by more than the law can absorb.
  const T4 = 0.004;
  const PLANFORMS: [string, [number, number][]][] = [
    ['3:1 trapezoid', [[0, 0], [0.04, 0.05], [0.08, 0.05], [0.12, 0]]],
    ['6:1 trapezoid', [[0, 0], [0.05, 0.05], [0.07, 0.05], [0.12, 0]]],
    ['clipped delta', [[0, 0], [0.06, 0.06], [0.09, 0.06], [0.1, 0]]],
  ];
  const LAWS: [string, Record<string, unknown>][] = [
    ['hexagonal', { crossSection: 'airfoil', airfoilSection: 'hexagonal' }],
    ['biconvex', { crossSection: 'airfoil', airfoilSection: 'biconvex' }],
  ];
  /** The planform's chord [lead, trail] at height y. */
  const chordAt = (loop: [number, number][], y: number): [number, number] => {
    const xs: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      const [x1, y1] = loop[i]!;
      const [x2, y2] = loop[(i + 1) % loop.length]!;
      if (y1 !== y2 && (y - y1) * (y - y2) <= 0) xs.push(x1 + ((x2 - x1) * (y - y1)) / (y2 - y1));
    }
    return [Math.min(...xs), Math.max(...xs)];
  };
  describe.each(PLANFORMS)('%s', (_p, planform) => {
    it.each(LAWS)('%s: within 2 percent of the stock of the law everywhere', (_l, fields) => {
      const node = { id: 'f', type: 'freeformfinset', thickness: T4, points: planform, ...fields } as unknown as ComponentNode;
      const shaped = shapedFin(node, planform, [planform], T4)!;
      expect(shaped).not.toBeNull();
      const { pos, tri } = shaped.mesh;
      const top: [V, V, V][] = [];
      const at = (i: number): V => [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!];
      for (let t = 0; t < tri.length; t += 3) {
        const v: [V, V, V] = [at(tri[t]!), at(tri[t + 1]!), at(tri[t + 2]!)];
        if (v.every((p) => p[2] >= 0) && v.some((p) => p[2] > 0)) top.push(v);
      }
      const skin = (x: number, y: number): number => {
        let best = -Infinity;
        for (const [a, b, d] of top) {
          const det = (b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1]);
          if (Math.abs(det) < 1e-16) continue;
          const u = ((x - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (y - a[1])) / det;
          const w = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / det;
          if (u < -1e-12 || w < -1e-12 || u + w > 1 + 1e-12) continue;
          best = Math.max(best, a[2] + u * (b[2] - a[2]) + w * (d[2] - a[2]));
        }
        return best;
      };
      const span = Math.max(...planform.map((p) => p[1]));
      let worst = 0;
      for (let i = 1; i < 30; i++) {
        const y = (span * i) / 30;
        const [lead, trail] = chordAt(planform, y);
        for (let j = 1; j < 100; j++) {
          const x = lead + ((trail - lead) * j) / 100;
          const z = skin(x, y);
          expect(z).toBeGreaterThan(-Infinity);
          worst = Math.max(worst, Math.abs(z - shaped.halfAt(x, y)));
        }
      }
      expect(worst).toBeLessThanOrEqual(0.02 * T4);
    });
  });
});

describe('no fillet floats or sinks: an unseated root on a transition draws none (N062 review, round 4)', () => {
  // Trapezoidal and elliptical roots are still drawn straight at the leading
  // edge's radius (only freeform roots are seated — a limit older than N062),
  // so on a boat tail a fillet there hung 8 mm above the body and on a flare
  // it sank inside it. Such a set draws no fillet; the fin is unchanged.
  const pos = (tree: RocketTree): number[] => Array.from(finPiece(tree).geometry.getAttribute('position').array);
  const CASES: [string, Record<string, unknown>, string, number, number][] = [
    ['trapezoid on a conical boat tail', { type: 'trapezoidfinset', rootChord: 0.08, tipChord: 0.04, sweep: 0.03, height: 0.05 }, 'conical', 0.027, 0.019],
    ['ellipse on an ogive boat tail', ELLIPSE, 'ogive', 0.027, 0.019],
    ['trapezoid on a conical flare', { type: 'trapezoidfinset', rootChord: 0.08, tipChord: 0.04, sweep: 0.03, height: 0.05 }, 'conical', 0.0125, 0.025],
  ];
  describe.each(CASES)('%s', (_n, fin, shape, fore, aft) => {
    it.each([['square', { crossSection: 'square' }] as [string, Record<string, unknown>], ...SECTIONS.slice(0, 3)])(
      '%s: the fin piece with a 6 mm fillet is the fin piece without one', (_s, section) => {
        const withFillet = onTransition(shape, fore, aft, { ...fin, ...section, filletRadius: 0.006 });
        const without = onTransition(shape, fore, aft, { ...fin, ...section });
        expect(pos(withFillet)).toEqual(pos(without));
      });
  });

  it('the same sets on a body tube, and a freeform fin seated on the boat tail, still draw their fillets', () => {
    for (const fin of [TRAP, ELLIPSE]) {
      for (const section of [{ crossSection: 'square' }, { crossSection: 'rounded' }]) {
        expect(pos(onTube({ ...fin, ...section, filletRadius: 0.006 })).length)
          .toBeGreaterThan(pos(onTube({ ...fin, ...section })).length);
      }
    }
    for (const section of [{ crossSection: 'square' }, { crossSection: 'rounded' }]) {
      expect(pos(onTransition('conical', 0.027, 0.019, { ...FREE, ...section, filletRadius: 0.006 })).length)
        .toBeGreaterThan(pos(onTransition('conical', 0.027, 0.019, { ...FREE, ...section })).length);
    }
  });
});
