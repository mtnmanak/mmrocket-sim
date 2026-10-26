import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import {
  componentSolid, extrudePolygon, finCutContours, finPlanformPoints, finPrintShape, isWatertight, solidVolume,
  type SolidContext, type SolidMesh,
} from './solidMesh.js';
import { solidContextFor } from './solidContext.js';
import { shapedFin } from './finSurface.js';
import { chordOutline, finSectionFlatReason } from './finChords.js';
import {
  finMacFromOutline, finSectionSpec, PRINT_MIN_EDGE, printableHalf, sectionHalfThickness,
} from './finSection.js';

/**
 * N062 §3 — the per-part 🖨 STL prints a rounded or airfoil fin with its
 * cross-section (tree/finSection.ts), a flat full-thickness tab, sharp edges
 * floored at the printable minimum edge, and square fins unchanged.
 */

const T = 0.003;
/** Vertical extent (m) of the solid over the planform point (x, y): its top less its bottom there. */
const thicknessAt = (mesh: SolidMesh, x: number, y: number): number => {
  const P = mesh.positions;
  const tri = mesh.triangles;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < tri.length; k += 3) {
    const [a, b, c] = [tri[k]! * 3, tri[k + 1]! * 3, tri[k + 2]! * 3];
    const d = (P[b]! - P[a]!) * (P[c + 1]! - P[a + 1]!) - (P[c]! - P[a]!) * (P[b + 1]! - P[a + 1]!);
    if (Math.abs(d) < 1e-16) continue;
    const u = ((x - P[a]!) * (P[c + 1]! - P[a + 1]!) - (P[c]! - P[a]!) * (y - P[a + 1]!)) / d;
    const v = ((P[b]! - P[a]!) * (y - P[a + 1]!) - (x - P[a]!) * (P[b + 1]! - P[a + 1]!)) / d;
    if (u < -1e-12 || v < -1e-12 || u + v > 1 + 1e-12) continue;
    const z = P[a + 2]! + u * (P[b + 2]! - P[a + 2]!) + v * (P[c + 2]! - P[a + 2]!);
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  return hi - lo;
};
const FLOOR = PRINT_MIN_EDGE / 2;

const trap = (extra: Record<string, unknown> = {}): ComponentNode => ({
  id: 'f', type: 'trapezoidfinset', rootChord: 0.1, tipChord: 0.05, sweep: 0.05, height: 0.06, thickness: T, ...extra,
} as ComponentNode);

const ellip = (extra: Record<string, unknown> = {}): ComponentNode => ({
  id: 'e', type: 'ellipticalfinset', rootChord: 0.1, height: 0.06, thickness: T, ...extra,
} as ComponentNode);

/** A freeform fin seated on a 27 -> 19 mm boat tail (conical or ogive), with its context. */
function seated(shape: string, extra: Record<string, unknown> = {}): { fin: ComponentNode; ctx: SolidContext } {
  const fin: ComponentNode = { id: 'ff', type: 'freeformfinset', thickness: T,
    points: [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, 0]],
    position: { method: 'top', offset: 0 }, ...extra } as ComponentNode;
  const tree: RocketTree = { components: [{ id: 'tail', type: 'transition', shape,
    length: 0.1, foreRadius: 0.027, aftRadius: 0.019, children: [fin] }] } as RocketTree;
  return { fin, ctx: solidContextFor(tree, fin) };
}

it.each(['square', 'rounded', 'airfoil'])('%s flush boat-tail strake prints a closed solid', async (crossSection) => {
  const { fin, ctx } = seated('conical', { crossSection, points: [[0, 0], [0.06, 0], [0.1, 0]] });
  const solid = (await componentSolid(fin, ctx))!;
  expect(solid).not.toBeNull();
  expect(isWatertight(solid.mesh)).toBe(true);
  expect(solidVolume(solid.mesh)).toBeGreaterThan(0);
  expect(thicknessAt(solid.mesh, 0.02, -0.0005)).toBeGreaterThan(T / 2);
});

/** Every section law the drawing knows, as node fields. */
const SECTIONS: Array<[string, Record<string, unknown>]> = [
  ['rounded', { crossSection: 'rounded' }],
  ['airfoil (NACA)', { crossSection: 'airfoil' }],
  ['hexagonal', { crossSection: 'airfoil', airfoilSection: 'hexagonal' }],
  ['hexagonal 10/20 mm chamfers', { crossSection: 'airfoil', airfoilSection: 'hexagonal', airfoilLeDiamond: 0.01, airfoilTeDiamond: 0.02 }],
  ['hexagonal + LE radius', { crossSection: 'airfoil', airfoilSection: 'hexagonal', finLeRadius: 0.001 }],
  ['doublewedge', { crossSection: 'airfoil', airfoilSection: 'doublewedge' }],
  ['biconvex', { crossSection: 'airfoil', airfoilSection: 'biconvex' }],
  ['biconvex + LE radius', { crossSection: 'airfoil', airfoilSection: 'biconvex', finLeRadius: 0.0008 }],
  ['hexbluntbase', { crossSection: 'airfoil', airfoilSection: 'hexbluntbase' }],
  ['singlewedge', { crossSection: 'airfoil', airfoilSection: 'singlewedge' }],
  ['naca', { crossSection: 'airfoil', airfoilSection: 'naca' }],
];

const TAB = { tabHeight: 0.01, tabLength: 0.06 };

function vertices(mesh: SolidMesh): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < mesh.positions.length; i += 3) out.push([mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]);
  return out;
}

/** The flat prism exactly as componentSolid has always built it: one extrusion per cut contour, concatenated. */
async function flatPrism(node: ComponentNode, ctx: SolidContext): Promise<SolidMesh> {
  const meshes = await Promise.all(finCutContours(node, ctx)!.map((c) => extrudePolygon(c, T)));
  const positions = new Float64Array(meshes.reduce((n, m) => n + m.positions.length, 0));
  const triangles = new Uint32Array(meshes.reduce((n, m) => n + m.triangles.length, 0));
  let p = 0;
  let t = 0;
  for (const m of meshes) {
    positions.set(m.positions, p);
    triangles.set(m.triangles.map((i) => i + p / 3), t);
    p += m.positions.length;
    t += m.triangles.length;
  }
  return { positions, triangles };
}

/** Outward normals: every triangle's normal points away from the solid (ray-parity test from its centroid). */
function outwardFraction(mesh: SolidMesh): number {
  const P = mesh.positions;
  const tri = mesh.triangles;
  const n = tri.length / 3;
  const v = (i: number): [number, number, number] => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
  // Ray–triangle (Möller–Trumbore) hit count along +d from o.
  const hits = (o: number[], d: number[]): number => {
    let count = 0;
    for (let k = 0; k < n; k++) {
      const a = v(tri[k * 3]!), b = v(tri[k * 3 + 1]!), c = v(tri[k * 3 + 2]!);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const p = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!];
      const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!;
      if (Math.abs(det) < 1e-30) continue;
      const s = [o[0]! - a[0], o[1]! - a[1], o[2]! - a[2]];
      const u = (s[0]! * p[0]! + s[1]! * p[1]! + s[2]! * p[2]!) / det;
      if (u < 0 || u > 1) continue;
      const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
      const w = (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!) / det;
      if (w < 0 || u + w > 1) continue;
      if ((e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det > 1e-12) count++;
    }
    return count;
  };
  let outward = 0;
  let sampled = 0;
  const step = Math.max(1, Math.floor(n / 60));
  for (let k = 0; k < n; k += step) {
    const a = v(tri[k * 3]!), b = v(tri[k * 3 + 1]!), c = v(tri[k * 3 + 2]!);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nn = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const len = Math.hypot(nn[0]!, nn[1]!, nn[2]!);
    if (len < 1e-14) continue;
    const d = nn.map((x) => x / len);
    // Start a hair outside the face, along its normal: an even hit count means
    // outside. The hair is at most 1/1000 of the face's smallest altitude: on
    // a seated root the leading root corner fans to the first root station
    // across a band 20 µm tall, so a skin face there stands almost on edge
    // with a planform footprint ~50 nm wide; a fixed 1e-7 m step along its
    // (near-horizontal) normal left that footprint and started the ray under
    // the next face of the fan.
    const longest = Math.max(Math.hypot(...e1), Math.hypot(...e2),
      Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]));
    const hair = Math.min(1e-7, (1e-3 * len) / longest);
    const o = [0, 1, 2].map((i) => (a[i]! + b[i]! + c[i]!) / 3 + d[i]! * hair);
    sampled++;
    if (hits(o, d) % 2 === 0) outward++;
  }
  return outward / sampled;
}

describe('square and unset sections keep the flat prism, vertex for vertex', () => {
  const cases: Array<[string, () => { node: ComponentNode; ctx: SolidContext }]> = [
    ['trapezoid', () => ({ node: trap(TAB), ctx: {} })],
    ['trapezoid, square', () => ({ node: trap({ ...TAB, crossSection: 'square' }), ctx: {} })],
    // airfoilSection is honoured only on an airfoil fin: a square one stays flat.
    ['trapezoid, square with a stored airfoilSection', () => ({ node: trap({ ...TAB, crossSection: 'square', airfoilSection: 'biconvex' }), ctx: {} })],
    ['elliptical', () => ({ node: ellip(TAB), ctx: {} })],
    ['freeform seated on a boat tail', () => { const s = seated('conical', { tabLength: 0.04, tabHeight: 0.005 }); return { node: s.fin, ctx: s.ctx }; }],
  ];
  it.each(cases)('%s', async (_name, make) => {
    const { node, ctx } = make();
    const solid = await componentSolid(node, ctx);
    const flat = await flatPrism(node, ctx);
    expect(solid!.mesh.positions).toEqual(flat.positions);
    expect(solid!.mesh.triangles).toEqual(flat.triangles);
    expect(finPrintShape(node, ctx)).toEqual({ kind: 'flat' });
  });
});

describe('every section prints watertight, outward, inside the stock and above the printable edge', () => {
  const planforms: Array<[string, (x: Record<string, unknown>) => { node: ComponentNode; ctx: SolidContext; tab: boolean }]> = [
    ['trapezoid with tab', (x) => ({ node: trap({ ...TAB, ...x }), ctx: {}, tab: true })],
    ['trapezoid, no tab', (x) => ({ node: trap(x), ctx: {}, tab: false })],
    ['elliptical with tab', (x) => ({ node: ellip({ tabHeight: 0.01, tabLength: 0.04, ...x }), ctx: {}, tab: true })],
    ['freeform seated on a conical boat tail, tab inside the root', (x) => {
      const s = seated('conical', { tabLength: 0.04, tabHeight: 0.005, ...x });
      return { node: s.fin, ctx: s.ctx, tab: true };
    }],
    ['freeform seated on an ogive boat tail, tab to the trailing edge', (x) => {
      const s = seated('ogive', { tabLength: 0.05, tabHeight: 0.005, tabOffsetMethod: 'bottom', ...x });
      return { node: s.fin, ctx: s.ctx, tab: true };
    }],
  ];
  for (const [pname, make] of planforms) {
    it.each(SECTIONS)(`${pname}: %s`, async (_name, fields) => {
      const { node, ctx, tab } = make(fields);
      // Below the root line (or the seated body surface, to its polyline sagitta) is tab.
      const mount = ctx.finMount;
      const bodyY = (x: number): number => (mount ? mount.radiusAt((ctx.finFront ?? 0) + x) - mount.radiusAt(ctx.finFront ?? 0) : 0);
      const shape = finPrintShape(node, ctx);
      expect(shape.kind).toBe('shaped');
      const solid = await componentSolid(node, ctx);
      expect(solid).not.toBeNull();
      const mesh = solid!.mesh;
      expect(isWatertight(mesh)).toBe(true);
      const square = await componentSolid({ ...node, crossSection: 'square' } as ComponentNode, ctx);
      const vol = solidVolume(mesh);
      expect(vol).toBeGreaterThan(0);
      expect(vol).toBeLessThan(solidVolume(square!.mesh));
      expect(outwardFraction(mesh)).toBe(1);
      let tabVertices = 0;
      for (const [x, y, z] of vertices(mesh)) {
        expect(Math.abs(z)).toBeLessThanOrEqual(T / 2);
        // Nothing is thinner than the printable minimum edge.
        expect(Math.abs(z)).toBeGreaterThanOrEqual(FLOOR - 1e-15);
        // The tab, below the root, is the flat full-thickness prism.
        if (y < bodyY(x) - 1e-5) {
          tabVertices++;
          expect(Math.abs(z)).toBe(T / 2);
        }
      }
      expect(tabVertices > 0).toBe(tab);
    });
  }
});

describe('the printed volume is the section law integrated over the planform', () => {
  // An independent check of the mesher: midpoint quadrature of 2·max(h, floor)
  // over the trapezoid (leading edge x = y·sweep/height, trailing edge at the root chord).
  const quadrature = (node: ComponentNode): number => {
    const spec = finSectionSpec(node, finMacFromOutline(finPlanformPoints(node)!));
    let v = 0;
    const NY = 300;
    const NX = 1500;
    for (let i = 0; i < NY; i++) {
      const y = ((i + 0.5) / NY) * 0.06;
      const c = 0.1 - (y / 0.06) * 0.05;
      for (let j = 0; j < NX; j++) {
        v += 2 * printableHalf(sectionHalfThickness(spec, c, (j + 0.5) / NX), T) * (c / NX) * (0.06 / NY);
      }
    }
    return v;
  };
  it.each(SECTIONS)('%s', async (_name, fields) => {
    const node = trap(fields);
    const solid = await componentSolid(node, {});
    // 16 chordwise intervals across a curved section: the biconvex secant error is 1/16² ≈ 0.4%.
    expect(Math.abs(solidVolume(solid!.mesh) / quadrature(node) - 1)).toBeLessThan(0.005);
  });

  it('matches the area ratios of understand-0-xsec §4 within the printable-edge allowance', async () => {
    // Area 0.0045 m² × t; the floor (0.4 mm) adds at most a sliver along each sharp edge.
    const prism = 0.0045 * T;
    const ratio = async (fields: Record<string, unknown>): Promise<number> =>
      solidVolume((await componentSolid(trap(fields), {}))!.mesh) / prism;
    expect(await ratio({ crossSection: 'airfoil', airfoilSection: 'biconvex' })).toBeCloseTo(2 / 3, 1);
    expect(await ratio({ crossSection: 'airfoil', airfoilSection: 'doublewedge' })).toBeGreaterThan(0.5);
    expect(await ratio({ crossSection: 'airfoil', airfoilSection: 'doublewedge' })).toBeLessThan(0.52);
    expect(await ratio({ crossSection: 'airfoil', airfoilSection: 'singlewedge' })).toBeGreaterThan(0.5);
    expect(await ratio({ crossSection: 'airfoil', airfoilSection: 'singlewedge' })).toBeLessThan(0.51);
    expect(await ratio({ crossSection: 'airfoil', airfoilSection: 'hexagonal' })).toBeGreaterThan(2 / 3);
    expect(await ratio({ crossSection: 'airfoil', airfoilSection: 'hexagonal' })).toBeLessThan(0.68);
    expect(await ratio({ crossSection: 'airfoil', airfoilSection: 'hexbluntbase' })).toBeGreaterThan(5 / 6);
    expect(await ratio({ crossSection: 'airfoil', airfoilSection: 'hexbluntbase' })).toBeLessThan(0.84);
    expect(await ratio({ crossSection: 'airfoil' })).toBeGreaterThan(0.68);
    expect(await ratio({ crossSection: 'airfoil' })).toBeLessThan(0.70);
    // Rounded: t·c less t²(1 − π/4) per unit span.
    expect(await ratio({ crossSection: 'rounded' })).toBeCloseTo(1 - (T * T * (1 - Math.PI / 4) * 0.06) / prism, 3);
  });
});

describe('the section sits where the law puts it', () => {
  const rootRow = async (fields: Record<string, unknown>): Promise<Array<[number, number]>> => {
    const solid = await componentSolid(trap(fields), {});
    return vertices(solid!.mesh).filter(([, y, z]) => y === 0 && z > 0).map(([x, , z]) => [x, z] as [number, number])
      .sort((a, b) => a[0] - b[0]);
  };

  it('plain Airfoil is a NACA 00xx: full stock at 30% chord, floored at both edges', async () => {
    const row = await rootRow({ crossSection: 'airfoil' });
    const peak = row.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(peak[0] / 0.1).toBeGreaterThan(0.27);
    expect(peak[0] / 0.1).toBeLessThan(0.33);
    expect(peak[1]).toBeCloseTo(T / 2, 5);
    expect(row[0]).toEqual([0, FLOOR]);
    expect(row[row.length - 1]![1]).toBe(FLOOR);
  });

  it('singlewedge and hexbluntbase keep a blunt full-thickness trailing edge', async () => {
    for (const s of ['singlewedge', 'hexbluntbase']) {
      const row = await rootRow({ crossSection: 'airfoil', airfoilSection: s });
      expect(row[0]![1]).toBe(FLOOR);
      expect(row[row.length - 1]![1]).toBe(T / 2);
    }
  });

  it('rounded is full stock between round edges', async () => {
    const row = await rootRow({ crossSection: 'rounded' });
    expect(row[0]![1]).toBe(FLOOR);
    expect(row[row.length - 1]![1]).toBe(FLOOR);
    const mid = row.filter(([x]) => x > 0.01 && x < 0.09);
    expect(mid.every(([, z]) => z === T / 2)).toBe(true);
  });

  it('doublewedge ridges at the LE chamfer fraction of the MAC', async () => {
    const pts = finPlanformPoints(trap())!;
    const mac = finMacFromOutline(pts);
    const row = await rootRow({ crossSection: 'airfoil', airfoilSection: 'doublewedge', airfoilLeDiamond: 0.3 * mac });
    const peak = row.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(peak[1]).toBe(T / 2);
    expect(peak[0] / 0.1).toBeCloseTo(0.3, 6);
  });
});

describe('edges, limits and fallbacks', () => {
  it.each([0.0003, PRINT_MIN_EDGE])('stock no thicker than the printable edge (%s m) prints the flat prism at full stock, and says why', async (t) => {
    // Every point would be floored to the stock: no section survives, so the
    // print path says it is the prism instead of claiming the section.
    const node = trap({ ...TAB, crossSection: 'airfoil', thickness: t });
    expect(finPrintShape(node)).toEqual({ kind: 'fallback', law: 'naca', reason: 'thin' });
    const solid = await componentSolid(node, {});
    expect(isWatertight(solid!.mesh)).toBe(true);
    for (const [, , z] of vertices(solid!.mesh)) expect(Math.abs(z)).toBe(t / 2);
    const flat = await flatPrism({ ...node }, {});
    expect(solid!.mesh.triangles.length).toBe(flat.triangles.length);
    // Just above the floor the section is printed, with its tab.
    expect(finPrintShape(trap({ ...TAB, crossSection: 'airfoil', thickness: 0.0005 })))
      .toEqual({ kind: 'shaped', law: 'naca', minEdge: PRINT_MIN_EDGE, tab: true });
    expect(finPrintShape(trap({ crossSection: 'airfoil', thickness: 0.0005 })))
      .toEqual({ kind: 'shaped', law: 'naca', minEdge: PRINT_MIN_EDGE, tab: false });
  });

  it.each([
    ['a pointed tip', trap({ crossSection: 'airfoil', tipChord: 0, ...TAB })],
    ['a tip overhanging the root', trap({ crossSection: 'rounded', sweep: 0.08, tipChord: 0.05, ...TAB })],
    ['a forward-swept leading edge', trap({ crossSection: 'airfoil', airfoilSection: 'hexagonal', sweep: -0.02, ...TAB })],
    ['a freeform listed trailing edge first', { id: 'r', type: 'freeformfinset', crossSection: 'airfoil', thickness: T,
      points: [[0.1, 0], [0.07, 0.04], [0.02, 0.04], [0, 0]], tabLength: 0.04, tabHeight: 0.005 } as ComponentNode],
    ['a freeform with a point on its root', { id: 'r', type: 'freeformfinset', crossSection: 'airfoil', thickness: T,
      points: [[0, 0], [0.01, 0], [0.03, 0.05], [0.05, 0]], tabLength: 0.04, tabHeight: 0.005, tabOffsetMethod: 'top' } as ComponentNode],
  ])('shapes %s', async (_name, node) => {
    expect(finPrintShape(node).kind).toBe('shaped');
    const solid = await componentSolid(node, {});
    expect(isWatertight(solid!.mesh)).toBe(true);
    expect(solidVolume(solid!.mesh)).toBeGreaterThan(0);
    expect(outwardFraction(solid!.mesh)).toBe(1);
  });

  it('a planform a horizontal line crosses more than twice keeps the flat prism, and says so', async () => {
    const node = { id: 'm', type: 'freeformfinset', crossSection: 'airfoil', thickness: T,
      points: [[0, 0], [0.015, 0.03], [0.03, 0.01], [0.05, 0.03], [0.075, 0]], tabLength: 0.04, tabHeight: 0.005 } as ComponentNode;
    expect(finPrintShape(node)).toEqual({ kind: 'fallback', law: 'naca', reason: 'chords' });
    const solid = await componentSolid(node, {});
    const flat = await flatPrism(node, {});
    expect(solid!.mesh.positions).toEqual(flat.positions);
    expect(solid!.mesh.triangles).toEqual(flat.triangles);
  });

  it('a step in the leading edge at mid-height keeps the flat prism, and says so', () => {
    const node = { id: 's', type: 'freeformfinset', crossSection: 'rounded', thickness: T,
      points: [[0, 0], [0.02, 0.03], [0.04, 0.03], [0.06, 0.05], [0.08, 0.05], [0.08, 0]] } as ComponentNode;
    expect(finPrintShape(node)).toEqual({ kind: 'fallback', law: 'rounded', reason: 'chords' });
  });

  it('an outline that crosses itself is still refused, not shaped', async () => {
    const node = { id: 'x', type: 'freeformfinset', crossSection: 'airfoil', thickness: T,
      points: [[0, 0], [0.05, 0.03], [0, 0.03], [0.05, 0]] } as ComponentNode;
    expect(await componentSolid(node, {})).toBeNull();
  });

  it('cut contours, which the DXF and the paper template use, do not depend on the section', () => {
    for (const [, fields] of SECTIONS) {
      expect(finCutContours(trap({ ...TAB, ...fields }))).toEqual(finCutContours(trap(TAB)));
      const s = seated('conical', { tabLength: 0.04, tabHeight: 0.005, ...fields });
      const q = seated('conical', { tabLength: 0.04, tabHeight: 0.005 });
      expect(finCutContours(s.fin, s.ctx)).toEqual(finCutContours(q.fin, q.ctx));
    }
  });

  it('keeps the print a sane size: triangle counts', async () => {
    const count = async (node: ComponentNode, ctx: SolidContext = {}): Promise<number> =>
      (await componentSolid(node, ctx))!.mesh.triangles.length / 3;
    expect(await count(trap({ ...TAB, crossSection: 'airfoil' }))).toBeLessThan(3000);
    expect(await count(trap({ ...TAB, crossSection: 'rounded' }))).toBeLessThan(2000);
    // 9,088 since N062's fourth review (7,408 before): the rows the view
    // draws where the ellipse's chord collapses to its tip (14 in its top
    // band, finChords.ts's chordRatioStations) now print too, so the print
    // follows the law up to the view's last row. The cap was 8,000.
    expect(await count(ellip({ ...TAB, crossSection: 'airfoil' }))).toBeLessThan(10000);
    const s = seated('ogive', { tabLength: 0.04, tabHeight: 0.005, crossSection: 'airfoil' });
    expect(await count(s.fin, s.ctx)).toBeLessThan(4000);
  });
});

describe('a freeform fin whose last point desktop OR stored on the body (N062 review)', () => {
  // Desktop OR saves a boat-tail or flare fin's last point ON the body, so
  // the closing root edge slopes. It is not the leading or trailing edge: the
  // printed root keeps the fin's full thickness, not the printable floor.
  const T4 = 0.004;
  const stored = (length: number, fore: number, aft: number, points: number[][], extra: Record<string, unknown> = {}) => {
    const fin: ComponentNode = { id: 'ff', type: 'freeformfinset', thickness: T4, crossSection: 'rounded', points,
      position: { method: 'top', offset: 0 }, ...extra } as ComponentNode;
    const tree: RocketTree = { components: [{ id: 'tail', type: 'transition', shape: 'conical',
      length, foreRadius: fore, aftRadius: aft, children: [fin] }] } as RocketTree;
    return { fin, ctx: solidContextFor(tree, fin), bodyY: (x: number) => (aft - fore) * x / length };
  };
  it.each([
    ['boat tail 27 -> 19 mm, last point at y = -8 mm', 0.1, 0.027, 0.019, [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, -0.008]], 0.02, 0.08],
    ['flare 19 -> 25 mm, last point at y = +6 mm', 0.08, 0.019, 0.025, [[0, 0], [0.02, 0.04], [0.06, 0.04], [0.08, 0.006]], 0.01, 0.07],
  ])('%s: the root prints at full thickness', async (_name, length, fore, aft, points, from, to) => {
    for (const extra of [{}, { tabLength: 0.04, tabHeight: 0.005 }]) {
      const { fin, ctx, bodyY } = stored(length, fore, aft, points, extra);
      expect(finPrintShape(fin, ctx).kind).toBe('shaped');
      const solid = await componentSolid(fin, ctx);
      expect(isWatertight(solid!.mesh)).toBe(true);
      expect(solidVolume(solid!.mesh)).toBeGreaterThan(0);
      const root = vertices(solid!.mesh).filter(([x, y]) => x >= from && x <= to && Math.abs(y - bodyY(x)) < 1e-9);
      expect(root.length).toBeGreaterThanOrEqual(4);
      for (const [, , z] of root) expect(Math.abs(z)).toBeCloseTo(T4 / 2, 9);
    }
  });
});

describe('overlapping hexagonal chamfers print the full stock (N062 review)', () => {
  it('80 mm + 80 mm chamfers on a 78 mm MAC (a1 = a2 = 0.95) print 3 mm thick, ridge mid-chord', async () => {
    const node = trap({ crossSection: 'airfoil', airfoilSection: 'hexagonal', airfoilLeDiamond: 0.08, airfoilTeDiamond: 0.08 });
    expect(finPrintShape(node).kind).toBe('shaped');
    const solid = await componentSolid(node, {});
    expect(isWatertight(solid!.mesh)).toBe(true);
    const zs = vertices(solid!.mesh).map(([, , z]) => Math.abs(z));
    expect(Math.max(...zs)).toBe(T / 2);
    // At the root (chord 100 mm) full stock stands at mid-chord.
    const root = vertices(solid!.mesh).filter(([, y, z]) => y === 0 && z > 0);
    const ridge = root.reduce((a, b) => (b[2] > a[2] ? b : a));
    expect(ridge[2]).toBe(T / 2);
    expect(ridge[0]).toBeCloseTo(0.05, 9);
  });
});

describe('an outline the STL path refuses says so, never "flat prism" (N062 review)', () => {
  const tubeCtx = (fin: ComponentNode): SolidContext => solidContextFor({ components: [{ id: 'b', type: 'bodytube',
    length: 0.3, outerRadius: 0.01, children: [fin] }] } as unknown as RocketTree, fin);
  const free = (points: number[][], extra: Record<string, unknown> = {}): ComponentNode => ({ id: 'x',
    type: 'freeformfinset', thickness: T, points, position: { method: 'bottom', offset: 0 }, ...extra } as ComponentNode);

  it.each([
    ['crosses itself', [[0, 0], [0.1, 0.04], [0.02, 0.02], [0.08, 0]]],
    ['a bow tie', [[0, 0], [0.05, 0.03], [0, 0.03], [0.05, 0]]],
    ['lies along its root (no area)', [[0, 0], [0.02, 0], [0.05, 0]]],
  ])('%s: refused, for every section, and componentSolid agrees', async (_n, points) => {
    for (const section of ['square', 'rounded', 'airfoil']) {
      for (const ctx of [{}, tubeCtx(free(points))]) {
        const node = free(points, { crossSection: section });
        expect(finPrintShape(node, ctx)).toEqual({ kind: 'refused' });
        expect(await componentSolid(node, ctx)).toBeNull();
      }
    }
  });

  it('zero stock is refused too', async () => {
    const node = trap({ crossSection: 'rounded', thickness: 0 });
    expect(finPrintShape(node)).toEqual({ kind: 'refused' });
    expect(await componentSolid(node, {})).toBeNull();
  });

  it('never refuses a fin the STL path prints (every fixture in this file, both ways round)', async () => {
    const cases: Array<{ node: ComponentNode; ctx: SolidContext }> = [];
    for (const [, fields] of SECTIONS) {
      for (const node of [trap(fields), trap({ ...TAB, ...fields }), ellip({ tabHeight: 0.01, tabLength: 0.04, ...fields })]) {
        cases.push({ node, ctx: {} });
      }
      for (const shape of ['conical', 'ogive']) {
        const s = seated(shape, { tabLength: 0.04, tabHeight: 0.005, ...fields });
        cases.push({ node: s.fin, ctx: s.ctx });
        const b = seated(shape, { tabLength: 0.05, tabHeight: 0.005, tabOffsetMethod: 'bottom', ...fields });
        cases.push({ node: b.fin, ctx: b.ctx });
      }
    }
    for (const { node, ctx } of cases) {
      const printed = await componentSolid(node, ctx);
      expect(finPrintShape(node, ctx).kind === 'refused').toBe(printed === null);
    }
  });
});

describe('a freeform fin typed with its last point at y = 0 and the same fin stored desktop-style print ONE solid (N062 review, round 3)', () => {
  // One kernel fin, two stored forms: the section's chords come from the fin
  // AS SEATED (first and last points on the body), so the two print byte for
  // byte the same — never a trailing edge cut off by a full-stock wall.
  const solidOf = async (length: number, fore: number, aft: number, thickness: number, points: number[][],
    extra: Record<string, unknown>) => {
    const fin: ComponentNode = { id: 'ff', type: 'freeformfinset', thickness, points,
      position: { method: 'top', offset: 0 }, ...extra } as ComponentNode;
    const tree: RocketTree = { components: [{ id: 'tail', type: 'transition', shape: 'conical',
      length, foreRadius: fore, aftRadius: aft, children: [fin] }] } as RocketTree;
    const ctx = solidContextFor(tree, fin);
    return { shape: finPrintShape(fin, ctx), solid: (await componentSolid(fin, ctx))! };
  };
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
    ['rounded, tab', { crossSection: 'rounded', tabLength: 0.03, tabHeight: 0.004 }],
  ];
  describe.each(CASES)('%s', (_n, length, fore, aft, thickness, typed, stored) => {
    it.each(LAWS)('%s: identical print solids', async (_s, section) => {
      const a = await solidOf(length, fore, aft, thickness, typed, section);
      const b = await solidOf(length, fore, aft, thickness, stored, section);
      expect(a.shape.kind).toBe('shaped');
      expect(b.shape).toEqual(a.shape);
      expect(isWatertight(a.solid.mesh)).toBe(true);
      expect(Array.from(a.solid.mesh.positions)).toEqual(Array.from(b.solid.mesh.positions));
      expect(Array.from(a.solid.mesh.triangles)).toEqual(Array.from(b.solid.mesh.triangles));
    });
  });
});

describe('a pointed tip prints the section law right up to the last row the view draws (N062 review, round 4)', () => {
  // One tip rule for both paths: the print adds spanwise stations where the
  // local chord collapses (finChords.ts's chordRatioStations, as the view's
  // rows do) and its tip vertex carries the law's own value. Until round 4
  // the print's top band ran from full stock to a 0.4 mm tip vertex: a delta
  // printed 1.84 mm where the law (and the view) is 4 mm.
  const TT = 0.004;
  /** Leading and trailing x of a closed outline at height y. */
  const chordOf = (pts: number[][], y: number): [number, number] => {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i]! as [number, number];
      const [x2, y2] = pts[(i + 1) % pts.length]! as [number, number];
      if ((y1 <= y) !== (y2 <= y)) xs.push(x1 + ((x2 - x1) * (y - y1)) / (y2 - y1));
    }
    return [Math.min(...xs), Math.max(...xs)];
  };
  const FINS: Array<[string, number[][]]> = [
    ['delta', [[0, 0], [0.08, 0.06], [0.1, 0]]],
    ['swept curved freeform, one-point tip',
      [[0, 0], [0.03, 0.03], [0.07, 0.06], [0.1, 0.07], [0.12, 0.065], [0.125, 0.04], [0.115, 0]]],
  ];
  const LAWS: Array<[string, Record<string, unknown>]> = [
    ['rounded', { crossSection: 'rounded' }],
    ['airfoil (NACA)', { crossSection: 'airfoil' }],
    ['hexagonal', { crossSection: 'airfoil', airfoilSection: 'hexagonal' }],
  ];
  describe.each(FINS)('%s', (_n, points) => {
    it.each(LAWS)('%s: within 5 percent of the stock of the law below the last display row', async (_s, fields) => {
      const node = { id: 'tip', type: 'freeformfinset', thickness: TT, points, ...fields } as ComponentNode;
      expect(finPrintShape(node).kind).toBe('shaped');
      const solid = (await componentSolid(node, {}))!;
      expect(isWatertight(solid.mesh)).toBe(true);
      const pts = points as Array<[number, number]>;
      const view = shapedFin(node, pts, [pts], TT)!;
      const top = Math.max(...pts.map((p) => p[1]));
      let lastRow = -Infinity;
      for (let i = 1; i < view.mesh.pos.length; i += 3) {
        const y = view.mesh.pos[i]!;
        if (y < top - 1e-9) lastRow = Math.max(lastRow, y);
      }
      // The top tenth of the span, up to the view's last row below the tip.
      const spec = finSectionSpec(node, finMacFromOutline(pts));
      let worst = 0;
      for (let i = 0; i <= 24; i++) {
        const y = top * 0.9 + ((lastRow - top * 0.9) * i) / 24;
        const [lead, trail] = chordOf(points, y);
        const c = trail - lead;
        for (let j = 1; j < 20; j++) {
          const xi = j / 20;
          const law = 2 * printableHalf(sectionHalfThickness(spec, c, xi), TT);
          worst = Math.max(worst, Math.abs(thicknessAt(solid.mesh, lead + xi * c, y) - law));
        }
      }
      expect(worst / TT).toBeLessThan(0.05);
    });
  });
});

describe('a freeform fin typed with a flat run along y = 0 prints shaped when seated on a boat tail (N062 review, round 4)', () => {
  // The chord outline's leading side used to drop below y = 0 from point 0,
  // while above y = 0 the leading edge starts at the end of the run: a step
  // the print rejected ('chords', the flat prism) though the view shaped it
  // and the outline as drawn has none. The drop now starts at the run's end,
  // as seatedChordPoints already cuts a run lying along the body.
  const POINTS = [[0, 0], [0.05, 0], [0.08, 0.04], [0.1, 0.04], [0.12, 0]];
  const on = (parent: Record<string, unknown>, fields: Record<string, unknown>) => {
    const fin: ComponentNode = { id: 'run', type: 'freeformfinset', thickness: 0.004, points: POINTS,
      position: { method: 'top', offset: 0 }, ...fields } as ComponentNode;
    const tree: RocketTree = { components: [{ id: 'mount', ...parent, children: [fin] }] } as RocketTree;
    return { fin, ctx: solidContextFor(tree, fin) };
  };
  const TRANSITION = { type: 'transition', shape: 'conical', length: 0.12, foreRadius: 0.027, aftRadius: 0.019 };
  const TUBE = { type: 'bodytube', length: 0.3, outerRadius: 0.027 };
  const PINNED_TUBE_VOLUME = 7.0598935685981072e-6;

  it('chordOutline drops the leading side from the end of a run on y = 0, and the trailing side likewise', () => {
    expect(chordOutline([[0, 0], [0.05, 0], [0.08, 0.04], [0.1, 0.04], [0.12, -0.008]]))
      .toEqual([[0.05, -0.008], [0.05, 0], [0.08, 0.04], [0.1, 0.04], [0.12, -0.008]]);
    expect(chordOutline([[0, -0.005], [0.03, 0.04], [0.08, 0.04], [0.1, 0], [0.12, 0]]))
      .toEqual([[0, -0.005], [0.03, 0.04], [0.08, 0.04], [0.1, 0], [0.1, -0.005]]);
    // Root corners at one height: unchanged.
    expect(chordOutline(POINTS as Array<[number, number]>)).toEqual(POINTS);
  });

  it.each([
    ['rounded', { crossSection: 'rounded' }, 'rounded'],
    ['airfoil (NACA)', { crossSection: 'airfoil' }, 'naca'],
    ['hexagonal, tab', { crossSection: 'airfoil', airfoilSection: 'hexagonal', tabLength: 0.04, tabHeight: 0.005 }, 'hexagonal'],
  ])('%s: on a conical boat tail it prints shaped, watertight and outward', async (_n, fields, law) => {
    const { fin, ctx } = on(TRANSITION, fields);
    expect(finSectionFlatReason(fin, ctx.finMount, ctx.finFront)).toBe(null);
    expect(finPrintShape(fin, ctx)).toMatchObject({ kind: 'shaped', law });
    const solid = (await componentSolid(fin, ctx))!;
    expect(isWatertight(solid.mesh)).toBe(true);
    expect(outwardFraction(solid.mesh)).toBe(1);
    const flat = (await componentSolid(on(TRANSITION, { ...fields, crossSection: 'square' }).fin, ctx))!;
    expect(solidVolume(solid.mesh)).toBeLessThan(solidVolume(flat.mesh));
  });

  it('on a body tube it prints exactly as before', async () => {
    const { fin, ctx } = on(TUBE, { crossSection: 'rounded' });
    expect(finPrintShape(fin, ctx)).toMatchObject({ kind: 'shaped', law: 'rounded' });
    // 7.060 cm³ (the square prism is 7.200): measured on the code before round 4.
    expect(solidVolume((await componentSolid(fin, ctx))!.mesh)).toBeCloseTo(PINNED_TUBE_VOLUME, 12);
  });
});
