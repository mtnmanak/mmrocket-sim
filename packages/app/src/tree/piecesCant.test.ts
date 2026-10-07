// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { rocketToObj } from '../services/objExport.js';
import { rocketToGlb } from '../services/gltfExport.js';
import { piecesToStl, solidToStl } from '../services/stlExport.js';
import { componentDxf } from '../services/dxfExport.js';
import { finTemplateSvg } from '../services/finTemplate.js';
import { componentSolid } from './solidMesh.js';
import { buildPieces } from './pieces.js';

type Point = [number, number, number];
const types = ['trapezoidfinset', 'ellipticalfinset', 'freeformfinset'] as const;
const sections = ['square', 'rounded', 'airfoil'] as const;
const angles = [0, 0.17, -0.17];
// The freeform tip overhangs its 80 mm root: max-x must NOT set the pivot.
const points = [[0, 0], [0.04, 0.04], [0.12, 0.04], [0.08, 0]];
const fin = (type: typeof types[number], cant: number, crossSection = 'airfoil'): ComponentNode => ({
  id: 'f', type, rootChord: 0.08, tipChord: 0.04, sweep: 0.02, height: 0.04,
  points, thickness: 0.004, finCount: 3, rotation: 0.31, cant, crossSection,
  position: { method: 'bottom', offset: -0.03 },
} as ComponentNode);
const treeWith = (f: ComponentNode): RocketTree => ({ components: [{
  id: 'body', type: 'bodytube', length: 0.4, outerRadius: 0.025, children: [f],
}] } as RocketTree);

function vertices(array: ArrayLike<number>): Point[] {
  return Array.from({ length: array.length / 3 }, (_, i) =>
    [array[i * 3]!, array[i * 3 + 1]!, array[i * 3 + 2]!]);
}

// Independent analytical oracle in SI, from FinSet.java:1762-1770 and
// Transformation.java:279-286. Unlike Swing, the app does not flip Z.
function expectedFin(type: typeof types[number], cant: number, clock: number): Point[] {
  const outline = type === 'freeformfinset' ? points : type === 'trapezoidfinset'
    ? [[0, 0], [0.02, 0.04], [0.06, 0.04], [0.08, 0]]
    : Array.from({ length: 65 }, (_, i) =>
      [0.04 * (1 - Math.cos(i * Math.PI / 64)), 0.04 * Math.sin(i * Math.PI / 64)]);
  return outline.flatMap(([x, y]) => [-0.002, 0.002].map((z): Point => {
    // Root leading edge is 0.4 - 0.08 - 0.03 = 0.29 m; pivot is 0.33 m.
    const axial = 0.33 + (x! - 0.04) * Math.cos(cant) + z * Math.sin(cant);
    const radial = 0.025 + y!;
    const tangent = -(x! - 0.04) * Math.sin(cant) + z * Math.cos(cant);
    return [axial, radial * Math.cos(clock) - tangent * Math.sin(clock),
      radial * Math.sin(clock) + tangent * Math.cos(clock)];
  }));
}

function expectVertices(actual: Point[], expected: Point[]) {
  // Float32 geometry (and STL mm conversion): 0.1 micrometre in these <1 m fixtures.
  const has = (list: Point[], p: Point) => list.some((q) =>
    p.every((v, axis) => Math.abs(v - q[axis]!) < 1e-7));
  expect(actual.length).toBeGreaterThan(0);
  expect(expected.every((p) => has(actual, p))).toBe(true);
  expect(actual.every((p) => has(expected, p))).toBe(true);
}

describe.each(types)('%s assembled cant', (type) => {
  for (const section of sections) {
    it.each(angles)(`${section}: rotates every vertex about the root midpoint at cant %s`, (cant) => {
      const tree = treeWith(fin(type, cant, section));
      const before = structuredClone(tree);
      const built = buildPieces(tree);
      const fins = built.pieces.filter((p) => p.key.startsWith('fin'));
      expect(fins).toHaveLength(3);
      fins.forEach((p, i) => expectVertices(vertices(p.geometry.getAttribute('position').array),
        expectedFin(type, cant, 0.31 + i * 2 * Math.PI / 3)));
      expect(tree).toEqual(before); // Rendering must not change simulation inputs.
      built.pieces.forEach((p) => p.geometry.dispose());
    });
  }

  it('keeps absent cant byte-identical to explicit zero', () => {
    const absent = fin(type, 0);
    delete absent['cant'];
    const a = buildPieces(treeWith(absent)).pieces;
    const b = buildPieces(treeWith(fin(type, 0))).pieces;
    expect(a.map((p) => p.geometry.getAttribute('position').array))
      .toEqual(b.map((p) => p.geometry.getAttribute('position').array));
    [...a, ...b].forEach((p) => p.geometry.dispose());
  });

  it.each([-1, 1])('matches the kernel 15-degree clamp for sign %s', (sign) => {
    const built = buildPieces(treeWith(fin(type, sign * Math.PI / 2)));
    const first = built.pieces.find((p) => p.key.startsWith('fin'))!;
    expectVertices(vertices(first.geometry.getAttribute('position').array),
      expectedFin(type, sign * Math.PI / 12, 0.31));
    built.pieces.forEach((p) => p.geometry.dispose());
  });

  it.each(angles)('applies cant %s before clocking and nested pod transforms', (cant) => {
    const inner: ComponentNode = {
      id: 'inner', type: 'podset', instanceCount: 1, radiusMethod: 'free', radiusOffset: 0.04,
      angleOffset: -0.6, position: { method: 'top', offset: 0.07 },
      children: treeWith(fin(type, cant)).components,
    } as ComponentNode;
    const outer: ComponentNode = {
      id: 'outer', type: 'podset', instanceCount: 2, radiusMethod: 'free', radiusOffset: 0.15,
      angleOffset: 0.4, position: { method: 'top', offset: 0.1 },
      children: [{ id: 'podbody', type: 'bodytube', length: 0.6, outerRadius: 0.03, children: [inner] }],
    } as ComponentNode;
    const built = buildPieces(treeWith(outer));
    const fins = built.pieces.filter((p) => p.key.startsWith('fin'));
    expect(fins).toHaveLength(6);
    const pod = ([x, y, z]: Point, start: number, radius: number, angle: number): Point =>
      [x + start, (y + radius) * Math.cos(angle) - z * Math.sin(angle),
        (y + radius) * Math.sin(angle) + z * Math.cos(angle)];
    fins.forEach((p, i) => {
      const expected = expectedFin(type, cant, 0.31 + (i % 3) * 2 * Math.PI / 3)
        .map((v) => pod(pod(v, 0.07, 0.04, -0.6), 0.1, 0.15, 0.4 + Math.floor(i / 3) * Math.PI));
      expectVertices(vertices(p.geometry.getAttribute('position').array), expected);
    });
    built.pieces.forEach((p) => p.geometry.dispose());
  });
});

function stlVertices(bytes: Uint8Array): Point[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: dv.getUint32(80, true) }, (_, i) =>
    Array.from({ length: 3 }, (_, j): Point => [0, 1, 2].map((axis) =>
      dv.getFloat32(84 + i * 50 + 12 + j * 12 + axis * 4, true) / 1000) as Point)).flat();
}

describe.each(types)('%s cant export boundaries', (type) => {
  it.each([-0.17, 0.17])('writes cant %s into actual OBJ, GLB and assembled STL vertices', async (cant) => {
    const tree = treeWith({ ...fin(type, cant), finCount: 1 });
    const expected = expectedFin(type, cant, 0.31);
    const obj = rocketToObj(tree, 'Cant');
    const finObject = obj.split(/^o /m).find((part) => part.startsWith('fin'))!;
    const objVertices = finObject.split('\n').filter((line) => line.startsWith('v '))
      .map((line) => line.slice(2).split(' ').map(Number) as Point);
    expectVertices(objVertices, expected);

    const glb = await rocketToGlb(tree, 'Cant');
    const view = new DataView(glb);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))) as {
      nodes: { name?: string; mesh: number }[];
      meshes: { primitives: { attributes: { POSITION: number } }[] }[];
      accessors: { bufferView: number; byteOffset?: number; count: number }[];
      bufferViews: { byteOffset?: number; byteStride?: number }[];
    };
    const node = json.nodes.find((n) => n.name?.startsWith('fin'))!;
    const accessor = json.accessors[json.meshes[node.mesh]!.primitives[0]!.attributes.POSITION]!;
    const buffer = json.bufferViews[accessor.bufferView]!;
    const offset = 20 + jsonLength + 8 + (buffer.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const glbVertices = Array.from({ length: accessor.count }, (_, i): Point =>
      [0, 1, 2].map((axis) => view.getFloat32(offset + i * (buffer.byteStride ?? 12) + axis * 4, true)) as Point);
    expectVertices(glbVertices, expected);

    const built = buildPieces(tree);
    const stl = stlVertices(piecesToStl(built.pieces, 'Cant'));
    // Full shell also contains the tube; every expected fin vertex must survive.
    for (const p of expected) expect(stl.some((q) => p.every((v, axis) => Math.abs(v - q[axis]!) < 1e-7))).toBe(true);
    built.pieces.forEach((p) => p.geometry.dispose());
  });

  for (const section of sections) {
    it.each([-0.17, 0.17])(`${section}: cant %s leaves per-part STL, DXF and SVG flat and unchanged`, async (cant) => {
      const zero = fin(type, 0, section), canted = fin(type, cant, section);
      const a = await componentSolid(zero, {}), b = await componentSolid(canted, {});
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(solidToStl(b!.mesh, 'Fin')).toEqual(solidToStl(a!.mesh, 'Fin'));
      expect(componentDxf(canted, {}, 'Cant')).toEqual(componentDxf(zero, {}, 'Cant'));
      expect(finTemplateSvg(canted, 'Cant')).toEqual(finTemplateSvg(zero, 'Cant'));
    });
  }
});
