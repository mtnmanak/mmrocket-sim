import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { splitBodyLoop } from './splitSolid.js';
import { innerTubeSections } from './tubeLayout.js';
import { buildPieces } from './pieces.js';
import { solidContextFor } from './solidContext.js';
import { componentLoop, componentSolid } from './solidMesh.js';
import { componentDxf } from '../services/dxfExport.js';
import { wakeShadowWarnings } from './mountAngle.js';
import { aftLayout } from './aftLayout.js';
import { layoutSchematic, schematicFrame } from './schematicLayout.js';
import { paperRingDimensions } from '../services/paperTemplates.js';
import { protuberanceFrontalArea } from './treeModel.js';

const body = (children: ComponentNode[], extra = {}): RocketTree => ({ components: [
  { type: 'bodytube', length: 0.7, outerRadius: 0.027, thickness: 0.001, children, ...extra },
] });

it.each([
  { direct: 0.009, inner: 0.005, radius: 0.007, offset: 0, unresolved: false },
  { direct: undefined, inner: 0.01, radius: 0.003, offset: 0.002, unresolved: false },
  { direct: 0.009, inner: 0.005, radius: 0.003, offset: 0.007, unresolved: true },
  { direct: undefined, inner: 0.005, radius: 0.007, offset: 0, unresolved: true },
  { direct: 0.009, inner: 0.005, radius: 0.011, offset: 0, unresolved: true },
])('r8 applies coupler envelope containment %j', ({ direct, inner, radius, offset, unresolved }) => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003, innerRadius: inner };
  const tree = body([ring,
    ...(direct === undefined ? [] : [{ type: 'innertube', length: 0.7, outerRadius: direct } as ComponentNode]),
    { type: 'tubecoupler', length: 0.7, children: [
      { type: 'innertube', length: 0.7, outerRadius: radius, radialPosition: offset },
    ] },
  ], { outerRadius: 0.03 });
  const ctx = solidContextFor(tree, ring);
  expect(ctx.mountLayoutUnresolved === true).toBe(unresolved);
  expect(componentLoop(ring, ctx) === null).toBe(unresolved);
  if (!unresolved) expect(paperRingDimensions(ring, ctx)).toBeTruthy();
});

it.each([true, false])('r9 refuses wider centred coupler tubes (direct=%s)', async direct => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003,
    innerRadius: direct ? 0.012 : 0.01 };
  const tree = body([ring,
    ...(direct ? [{ type: 'innertube', length: 0.7, outerRadius: 0.009 } as ComponentNode] : []),
    { type: 'tubecoupler', length: 0.7, children: [
      { type: 'innertube', length: 0.7, outerRadius: direct ? 0.011 : 0.012 },
    ] },
  ], { outerRadius: 0.03 });
  const ctx = solidContextFor(tree, ring);
  expect(ctx.mountLayoutUnresolved).toBe(true);
  expect(componentLoop(ring, ctx)).toBeNull();
  expect(await componentSolid(ring, ctx)).toBeNull();
  expect(componentDxf(ring, ctx, 'Test')).toBeNull();
  expect(() => paperRingDimensions(ring, ctx)).toThrow(direct
    ? "a tube held in a coupler is wider than the ring's direct mount tube"
    : "a tube held in a coupler is wider than this ring's hole");
  if (direct) expect(() => paperRingDimensions(ring, ctx)).not.toThrow(/cannot pass/);
  expect(() => paperRingDimensions(ring, ctx)).not.toThrow(/off-centre|off-axis/);
});

it('r10 allows catalogue fit clearance on a stated hole without a direct tube', async () => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003, innerRadius: 0.0145 };
  const ctx = solidContextFor(body([ring, { type: 'tubecoupler', length: 0.7, children: [
    { type: 'innertube', length: 0.7, outerRadius: 0.01455 },
  ] }], { outerRadius: 0.03 }), ring);
  expect(ctx.mountLayoutUnresolved).not.toBe(true);
  expect(componentLoop(ring, ctx)).not.toBeNull();
  expect(await componentSolid(ring, ctx)).not.toBeNull();
  expect(componentDxf(ring, ctx, 'Test')).not.toBeNull();
  expect(paperRingDimensions(ring, ctx).bore).toBeCloseTo(0.0145, 12);
});

it.each([false, true])('r10 preserves refusal beyond the applicable tolerance (direct=%s)', direct => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003, innerRadius: 0.0145 };
  const ctx = solidContextFor(body([ring,
    ...(direct ? [{ type: 'innertube', length: 0.7, outerRadius: 0.0145 } as ComponentNode] : []),
    { type: 'tubecoupler', length: 0.7, children: [
      { type: 'innertube', length: 0.7, outerRadius: direct ? 0.01455 : 0.0148 },
    ] },
  ]), ring);
  expect(ctx.mountLayoutUnresolved).toBe(true);
  expect(componentLoop(ring, ctx)).toBeNull();
});

it('r8 still refuses a collapsed cluster wider than the hole', () => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003, innerRadius: 0.005 };
  const ctx = solidContextFor(body([ring, { type: 'tubecoupler', length: 0.7, children: [
    { type: 'innertube', length: 0.7, outerRadius: 0.007, cluster: '3-ring', clusterScale: 0 },
  ] }]), ring);
  expect(ctx.mountLayoutUnresolved).toBe(true);
  expect(componentLoop(ring, ctx)).toBeNull();
});

it('S4b-g1 refuses sockets that consume the next solid cut backing', () => {
  expect(() => splitBodyLoop([[0, 0], [0, 0.025], [0.1, 0.025], [0.1, 0]],
    [0.015, 0.03], { clearance: 0.007 })).toThrow(/backing before the next cut/);
});

it('S4b-g2 ignores coupler radial and cluster fields in sections and meshes', () => {
  const coupler: ComponentNode = { type: 'tubecoupler', length: 0.1, outerRadius: 0.02,
    children: [{ type: 'innertube', length: 0.2, outerRadius: 0.005 }] };
  const offset = { ...coupler, radialPosition: 0.02, cluster: '3-ring' };
  expect(innerTubeSections(offset, 0.7)).toEqual(innerTubeSections(coupler, 0.7));
  const a = buildPieces(body([coupler])), b = buildPieces(body([offset]));
  try {
    expect(b.pieces.map(p => p.position)).toEqual(a.pieces.map(p => p.position));
    expect(b.pieces.map(p => p.geometry.getAttribute('position').array))
      .toEqual(a.pieces.map(p => p.geometry.getAttribute('position').array));
  } finally { [...a.pieces, ...b.pieces].forEach(p => p.geometry.dispose()); }
});

it.each([{ radialPosition: 0.012 }, { cluster: '3-ring', clusterScale: 4 }])(
  'S4b-g3 refuses a stated bore crossed by coupler contents %j', async layout => {
    const ring: ComponentNode = { type: 'centeringring', id: 'ring', innerRadius: 0.01, length: 0.003,
      position: { method: 'top', offset: 0.2 } };
    const t = body([ring, { type: 'tubecoupler', length: 0.1, position: { method: 'top', offset: 0 }, children: [
      { type: 'innertube', length: 0.3, outerRadius: 0.005, position: { method: 'top', offset: 0 }, ...layout },
    ] }]);
    const ctx = solidContextFor(t, ring);
    expect(ctx.mountLayoutUnresolved).toBe(true);
    expect(await componentSolid(ring, ctx)).toBeNull();
    expect(componentDxf(ring, ctx, 'Test')).toBeNull();
    expect(() => paperRingDimensions(ring, ctx)).toThrow(/off-centre/);
  });

it.each(['fairing', 'protuberance'].flatMap(type => ['height', 'width'].map(missing => ({ type, missing }))))(
  'S4b-g4 uses default $type wake $missing', ({ type, missing }) => {
  const source: ComponentNode = { type: type as ComponentNode['type'], id: 'source', length: 0.08, angleOffset: 0,
    ...(missing === 'height' ? { width: 0.025 } : { height: 0.02 }),
    position: { method: 'top', offset: 0.33 } };
  const fins: ComponentNode = { type: 'trapezoidfinset', id: 'fins', rootChord: 0.1, height: 0.055,
    rotation: 20 * Math.PI / 180, position: { method: 'bottom', offset: 0 } };
  expect(wakeShadowWarnings(body([source, fins]))).toHaveLength(1);
});

describe('collapsed drawing geometry', () => {
  const parts: ComponentNode[] = [
    { type: 'trapezoidfinset', thickness: 0, height: 0.04 },
    { type: 'ellipticalfinset', height: 0 },
    { type: 'freeformfinset', thickness: 0, points: [[0, 0], [0.02, 0.04], [0.04, 0]] },
    { type: 'tubefinset', thickness: 0, outerRadius: 0.01, length: 0.05 },
    { type: 'fairing', width: 0 }, { type: 'fairing', length: 0 },
    { type: 'protuberance', height: 0 } as unknown as ComponentNode,
    { type: 'launchlug', outerRadius: 0 }, { type: 'railbutton', totalHeight: 0 },
  ];
  it.each(parts)('S4b-g7 omits collapsed $type from aft shapes and extent', part => {
    const layout = aftLayout(body([{ ...part, id: 'collapsed' }]), 0);
    expect(layout.outer.filter(s => s.key === 'collapsed')).toEqual([]);
    expect(layout.extent).toBeCloseTo(0.027, 12);
  });

it.each(['nosecone', 'transition'] as const)('r2 refuses automatic stock in a filled %s', async type => {
  const ring: ComponentNode = { type: 'bulkhead', id: 'ring', length: 0.002,
    position: { method: 'top', offset: 0.1 } };
  for (const thickness of [undefined, 0.002]) {
    const ctx = solidContextFor({ components: [{ type, filled: true, length: 0.2,
      foreRadius: 0.03, aftRadius: 0.03, thickness, children: [ring] }] }, ring);
    expect(ctx.parentInnerRadius).toBe(0);
    expect(await componentSolid(ring, ctx)).toBeNull();
    expect(componentDxf(ring, ctx, 'Test')).toBeNull();
    expect(() => paperRingDimensions(ring, ctx)).toThrow();
  }
});

it.each([0.062, 0.065])('r2 preserves valid solid sockets before cut %s', next => {
  const result = splitBodyLoop([[0, 0], [0, 0.025], [0.2, 0.025], [0.2, 0]], [0.05, next]);
  // The original viable stub reaches 60.25 mm / 62.5 mm respectively.
  const end = next === 0.062 ? 0.06025 : 0.0625;
  expect(result[0]!.some(([x]) => Math.abs(x - end) < 1e-9)).toBe(true);
});

it('r2 allows contained off-axis coupler contents inside a direct automatic bore', async () => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003 };
  const ctx = solidContextFor(body([ring,
    { type: 'innertube', length: 0.7, outerRadius: 0.0145 },
    { type: 'tubecoupler', length: 0.7, children: [
      { type: 'innertube', length: 0.7, outerRadius: 0.005, radialPosition: 0.006 },
    ] },
  ]), ring);
  expect(ctx.mountLayoutUnresolved).not.toBe(true);
  expect(await componentSolid(ring, ctx)).not.toBeNull();
  expect(componentDxf(ring, ctx, 'Test')).not.toBeNull();
  expect(paperRingDimensions(ring, ctx)).toBeTruthy();
});

it('r2 keeps zero-count bumps consistent with the one-bump 3D consumer', () => {
  const a = body([{ type: 'protuberance', id: 'bump', count: 0 } as unknown as ComponentNode]);
  const b = body([{ type: 'protuberance', id: 'bump', count: 1 } as unknown as ComponentNode]);
  expect(aftLayout(a, 0)).toEqual(aftLayout(b, 0));
  const opts = { scale: 1000, cy: 100, x0: 0, roll: 0.4, idPrefix: 'test' };
  expect(layoutSchematic(a, opts).shapes).toEqual(layoutSchematic(b, opts).shapes);
  expect(layoutSchematic(a, opts).extents).toEqual(layoutSchematic(b, opts).extents);
  expect(protuberanceFrontalArea(a.components[0]!.children![0]!))
    .toBe(protuberanceFrontalArea(b.components[0]!.children![0]!));
  const mesh = buildPieces(a), empty = buildPieces(body([]));
  try { expect(mesh.pieces.length).toBeGreaterThan(empty.pieces.length); }
  finally { [...mesh.pieces, ...empty.pieces].forEach(p => p.geometry.dispose()); }
});
  it.each(parts)('S4b-g8 omits collapsed $type from schematic and hover extents', part => {
    const l = layoutSchematic(body([{ ...part, id: 'collapsed' }]),
      { scale: 1000, cy: 100, x0: 0, roll: 0.4, idPrefix: 'test' });
    expect(l.shapes.filter(s => s.key.startsWith('collapsed:'))).toEqual([]);
    expect(l.extents.has('collapsed')).toBe(false);
  });
  it.each(parts)('S4b-g8 keeps collapsed $type out of the fitted frame', part => {
    const options = { cw: 640, chPx: 480, maxHeight: 480, rulers: true, rollW: 26,
      rollBar: 0, lanes: true, topReserve: 0 };
    expect(schematicFrame(body([part]), options)).toEqual(schematicFrame(body([]), options));
  });
});

it.each(['bulkhead', 'centeringring', 'engineblock', 'tubecoupler'] as const)(
  'S4b-b1 refuses explicit zero %s OD in STL and DXF', async type => {
    const n: ComponentNode = { type, outerRadius: 0, length: 0.002 };
    expect(await componentSolid(n, { parentInnerRadius: 0.012 })).toBeNull();
    expect(componentDxf(n, { parentInnerRadius: 0.012 }, 'Test')).toBeNull();
  });

it.each(['bodytube', 'innertube', 'tubecoupler', 'nosecone', 'transition'] as const)(
  'S4b-b2 preserves a resolved zero %s bore and refuses automatic fabrication', async type => {
    const ring: ComponentNode = { type: 'bulkhead', id: 'ring', length: 0.002 };
    const t: RocketTree = { components: [{ type, length: 0.2, outerRadius: 0.01,
      aftRadius: 0.01, foreRadius: 0.01, thickness: 0.01, children: [ring] }] };
    const ctx = solidContextFor(t, ring);
    expect(ctx.parentInnerRadius).toBe(0);
    expect(await componentSolid(ring, ctx)).toBeNull();
    expect(componentDxf(ring, ctx, 'Test')).toBeNull();
  });
