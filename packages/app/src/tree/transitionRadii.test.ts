import { describe, expect, it } from 'vitest';
import type { ComponentNode, ComponentType, RocketTree } from '@online-openrocket/engine';
import { OrkRocket, resetEngine } from '@online-openrocket/engine';
import { resolveTransitionRadii } from './transitionRadii.js';
import { solidContextFor } from './solidContext.js';
import { componentLoop, componentSolid } from './solidMesh.js';
import { printOffer } from '../services/printPack.js';
import { layoutSchematic, schematicFrame } from './schematicLayout.js';
import { buildPieces } from './pieces.js';
import { findNode, updateNode } from './treeModel.js';

const tree = (...children: ComponentNode[]): RocketTree => ({ name: 'R', components: [{ type: 'stage', children }] });
const FRAME = { cw: 640, chPx: 480, maxHeight: 480, rulers: true, rollW: 26, rollBar: 0, lanes: true, topReserve: 0 };

// Compare every shared geometry consumer against independently stated radii.
async function matchesExplicit(t: RocketTree, side: 'fore' | 'aft', radius: number) {
  const tr = findNode(t, 't')!;
  const explicit = updateNode(t, 't', { [`${side}Radius`]: radius });
  const stated = findNode(explicit, 't')!;
  const source = JSON.stringify(t);
  expect(findNode(resolveTransitionRadii(t), 't')![`${side}Radius`]).toBeCloseTo(radius, 12);
  const frame = schematicFrame(t, FRAME);
  expect(frame).toEqual(schematicFrame(explicit, FRAME));
  const options = { scale: frame.scale, cy: frame.cy, x0: frame.x0, roll: 0, idPrefix: 't' };
  // Layout carries source nodes too; compare the actual drawn coordinates.
  const shapes = (input: RocketTree) => layoutSchematic(input, options).shapes.map(({ key, tag, attrs }) => ({ key, tag, attrs }));
  expect(shapes(t)).toEqual(shapes(explicit));
  const vertices = (input: RocketTree) => {
    const built = buildPieces(input);
    const pieces = built.pieces.map((p) => ({ key: p.key, position: p.position, rotation: p.rotation,
      vertices: Array.from(p.geometry.getAttribute('position').array),
      indices: p.geometry.index ? Array.from(p.geometry.index.array) : null }));
    built.pieces.forEach((p) => p.geometry.dispose());
    return { pieces, totalLen: built.totalLen, maxR: built.maxR };
  };
  expect(vertices(t)).toEqual(vertices(explicit));
  const ctx = solidContextFor(t, tr);
  const explicitCtx = solidContextFor(explicit, stated);
  expect(componentLoop(tr, ctx)!.sizeAssumed).toBeUndefined();
  expect(componentLoop(tr, ctx)).toEqual(componentLoop(stated, explicitCtx));
  expect(await componentSolid(tr, ctx)).toEqual(await componentSolid(stated, explicitCtx));
  expect(printOffer(tr, ctx, null)).toEqual(printOffer(stated, explicitCtx, null));
  expect(JSON.stringify(t)).toBe(source);
}

describe('B6 automatic transition radii', () => {
  it.each<ComponentType>(['podset', 'parallelstage'])('resolves flush inline %s sleeve neighbours on both sides', async (type) => {
    const tube: ComponentNode = { type: 'bodytube', length: 0.2, outerRadius: 0.02, children: [{
      type, radiusMethod: 'free', radiusOffset: 0, instanceCount: 1,
      position: { method: 'bottom', offset: 0 },
      children: [{ type: 'bodytube', length: 0.1, outerRadius: 0.05 }],
    }] };
    for (const side of ['fore', 'aft'] as const) {
      tube.children![0]!['position'] = { method: side === 'fore' ? 'bottom' : 'top', offset: 0 };
      const tr: ComponentNode = { type: 'transition', id: 't', length: 0.1,
        [side === 'fore' ? 'aftRadius' : 'foreRadius']: 0.03 };
      const t = tree(...(side === 'fore' ? [tube, tr] : [tr, tube]));
      await matchesExplicit(t, side, 0.05);
      // Off-axis sleeves do not participate in the kernel's neighbour search.
      tube.children![0]!['radiusOffset'] = 0.1;
      await matchesExplicit(t, side, 0.02);
      tube.children![0]!['radiusOffset'] = 0;
    }
  });
  it('uses the kernel default when an automatic transition has its own inline sleeve', async () => {
    const tr: ComponentNode = { type: 'transition', id: 't', length: 0.2, foreRadius: 0.03, children: [{
      type: 'podset', radiusMethod: 'free', radiusOffset: 0, instanceCount: 1,
      position: { method: 'bottom', offset: 0 },
      children: [{ type: 'bodytube', length: 0.1, outerRadius: 0.05 }],
    }] };
    const t = tree(tr);
    await matchesExplicit(t, 'aft', 0.025);
  });
  it('uses the kernel default at a missing neighbour and does not freeze the source tree', () => {
    const t = tree({ id: 't', type: 'transition' });
    const resolved = resolveTransitionRadii(t).components[0]!.children![0]!;
    expect(resolved['foreRadius']).toBeCloseTo(0.025, 12);
    expect(resolved['aftRadius']).toBeCloseTo(0.025, 12);
    expect(t.components[0]!.children![0]!['foreRadius']).toBeUndefined();
    const loop = componentLoop(t.components[0]!.children![0]!, solidContextFor(t, t.components[0]!.children![0]!))!;
    expect(loop.sizeAssumed).toBeUndefined();
  });
  it('crosses axial stage boundaries but keeps off-axis pod chains separate', () => {
    const t = tree({ type: 'bodytube', outerRadius: 0.05, children: [{ type: 'podset', children: [{ type: 'transition', id: 'pod' }] }] });
    t.components.push({ type: 'stage', children: [{ type: 'transition', id: 'tail', aftRadius: 0 }] });
    const out = resolveTransitionRadii(t);
    expect(out.components[1]!.children![0]!['foreRadius']).toBeCloseTo(0.05, 12);
    expect(out.components[1]!.children![0]!['aftRadius']).toBe(0);
    expect(out.components[0]!.children![0]!.children![0]!.children![0]!['foreRadius']).toBeCloseTo(0.025, 12);
  });
  it('warns before printing when no context can resolve an end', () => {
    const tr = { type: 'transition', foreRadius: 0.03 } as ComponentNode;
    expect(componentLoop(tr, {})!.sizeAssumed).toBe(true);
    expect(componentLoop(tr, {})!.label).toContain('assumed size');
    const offer = printOffer(tr, {}, null);
    expect(offer.tone).toBe('warn');
    expect(offer.note).toContain('Measure both end diameters');
  });
});

describe('K3 kernel inline neighbour search', () => {
  const fixture = (side: 'fore' | 'aft', offset = 0) => {
    const sleeve: ComponentNode = { type: 'bodytube', id: 'sleeve', length: 0.1, outerRadius: 0.05 };
    const asm: ComponentNode = { type: 'podset', radiusMethod: 'free', radiusOffset: 0, instanceCount: 1,
      position: { method: side === 'fore' ? 'bottom' : 'top', offset }, children: [sleeve] };
    const host: ComponentNode = { type: 'bodytube', id: 'host', length: 0.2, outerRadius: 0.02, children: [asm] };
    const tr: ComponentNode = { type: 'transition', id: 't', length: 0.1,
      [side === 'fore' ? 'aftRadius' : 'foreRadius']: 0.03 };
    return { t: tree(...(side === 'fore' ? [host, tr] : [tr, host])), host, asm, sleeve, tr };
  };

  for (const side of ['fore', 'aft'] as const) {
    it.each([-0.01, 0.01, 2e-6])(`${side}: ignores a non-flush sleeve at %s m`, async (offset) => {
      await matchesExplicit(fixture(side, offset).t, side, 0.02);
    });
    it(`${side}: accepts roundoff within the kernel flush tolerance`, async () => {
      await matchesExplicit(fixture(side, 4e-9).t, side, 0.05);
    });
    it(`${side}: uses the widest flush sleeve, never a smaller one`, async () => {
      const { t, host, asm, sleeve } = fixture(side);
      sleeve['outerRadius'] = 0.01;
      await matchesExplicit(t, side, 0.02);
      host.children!.push({ ...asm, children: [{ ...sleeve, id: 'wide', outerRadius: 0.06 }] },
        { ...asm, children: [{ ...sleeve, id: 'medium', outerRadius: 0.04 }] });
      await matchesExplicit(t, side, 0.06);
    });
    it(`${side}: checks only the boundary child, not the widest child in the assembly`, async () => {
      const { t, asm, sleeve } = fixture(side);
      const wider: ComponentNode = { type: 'bodytube', length: 0.05, outerRadius: 0.08 };
      asm.children = side === 'fore' ? [wider, sleeve] : [sleeve, wider];
      await matchesExplicit(t, side, 0.05);
      const nonSymmetric: ComponentNode = { type: 'masscomponent' };
      asm.children = side === 'fore' ? [sleeve, nonSymmetric] : [nonSymmetric, sleeve];
      await matchesExplicit(t, side, 0.02);
    });
    it(`${side}: accumulates nested offsets even through narrower non-flush sleeves`, async () => {
      const { t, sleeve, asm } = fixture(side, 0.01);
      sleeve['outerRadius'] = 0.01;
      sleeve.children = [{ ...asm, type: 'parallelstage',
        position: { method: side === 'fore' ? 'bottom' : 'top', offset: -0.01 },
        children: [{ type: 'bodytube', length: 0.05, outerRadius: 0.07 }] }];
      await matchesExplicit(t, side, 0.07);
      sleeve.children[0]!.position!.offset = -0.02;
      await matchesExplicit(t, side, 0.02);
      sleeve.children[0]!.position!.offset = -0.01;
      sleeve.children[0]!['radiusOffset'] = 0.1;
      await matchesExplicit(t, side, 0.02);
    });
    it(`${side}: keeps an automatic boundary end unresolved and rejects cyclic sleeve dependencies`, async () => {
      const { t, host, sleeve } = fixture(side);
      host.type = 'transition';
      host['foreRadius'] = 0.02;
      host['aftRadius'] = 0.02;
      delete host[side === 'fore' ? 'aftRadius' : 'foreRadius'];
      expect(findNode(resolveTransitionRadii(t), 't')![`${side}Radius`]).toBeUndefined();
      expect(printOffer(findNode(t, 't')!, solidContextFor(t, findNode(t, 't')!), null).tone).toBe('warn');
      host['foreRadius'] = 0.02;
      host['aftRadius'] = 0.02;
      sleeve.type = 'transition';
      sleeve[side === 'fore' ? 'foreRadius' : 'aftRadius'] = 0.08;
      // Stating t's end would also unlock the sleeve's mutually automatic end,
      // so only compare the target radius in this deliberately cyclic tree.
      expect(findNode(resolveTransitionRadii(t), 't')![`${side}Radius`]).toBeCloseTo(0.02, 12);
    });
    it(`${side}: honours the kernel inline radius methods`, async () => {
      const { t, asm } = fixture(side);
      for (const [method, offset, radius] of [
        ['relative', 0, 0.02], ['relative', -0.02, 0.05],
        ['coaxial', 0.1, 0.05], ['surface', -0.02, 0.02],
      ] as const) {
        asm['radiusMethod'] = method;
        asm['radiusOffset'] = offset;
        await matchesExplicit(t, side, radius);
      }
    });
    it(`${side}: matches the shipped kernel for flush, non-flush and nested sleeves`, () => {
      resetEngine();
      for (const nested of [false, true]) {
        for (const offset of [0, 6e-9, 5e-7, 2e-6, 0.01]) {
          const { t, sleeve, asm } = fixture(side, offset);
          if (nested) sleeve.children = [{ ...asm, type: 'parallelstage',
            position: { method: side === 'fore' ? 'bottom' : 'top', offset: -offset },
            children: [{ type: 'bodytube', length: 0.04, outerRadius: 0.07 }] }];
          const resolved = resolveTransitionRadii(t);
          const automatic = OrkRocket.buildTree(t).componentInfo('t');
          const explicit = OrkRocket.buildTree(resolved).componentInfo('t');
          // Mass (kg) and local CG (m) are independent kernel geometry oracles.
          expect(automatic.mass).toBeGreaterThan(0);
          expect(automatic.mass, `${side}, nested=${nested}, offset=${offset} m`).toBeCloseTo(explicit.mass, 10);
          expect(automatic.cgX).toBeCloseTo(explicit.cgX, 10);
        }
      }
    }, 60000);
  }

  it.each([6e-9, 5e-7])('aft: snaps a TOP sleeve offset of %s m to zero', async (offset) => {
    await matchesExplicit(fixture('aft', offset).t, 'aft', 0.05);
  });

  it.each<ComponentType>(['podset', 'parallelstage'])('fore: applies the returned-offset snap only to podsets (%s)', async (type) => {
    const { t, asm } = fixture('fore', 6e-9);
    asm.type = type;
    await matchesExplicit(t, 'fore', type === 'podset' ? 0.05 : 0.02);
    resetEngine();
    const automatic = OrkRocket.buildTree(t).componentInfo('t');
    const explicit = OrkRocket.buildTree(resolveTransitionRadii(t)).componentInfo('t');
    expect(automatic.mass).toBeGreaterThan(0);
    expect(automatic.mass).toBeCloseTo(explicit.mass, 10);
    expect(automatic.cgX).toBeCloseTo(explicit.cgX, 10);
  });

  it.each([-0.01, 0, 5e-7, 0.01])('finds the enclosing body or its predecessor for an inline assembly at %s m', async (offset) => {
    const tr: ComponentNode = { type: 'transition', id: 't', length: 0.1, aftRadius: 0.03 };
    const t = tree({ type: 'bodytube', length: 0.1, outerRadius: 0.04 },
      { type: 'bodytube', length: 0.2, outerRadius: 0.02, children: [{ type: 'podset',
        radiusMethod: 'free', radiusOffset: 0, position: { method: 'top', offset }, children: [tr] }] });
    await matchesExplicit(t, 'fore', offset >= 1e-6 ? 0.02 : 0.04);
    resetEngine();
    const automatic = OrkRocket.buildTree(t).componentInfo('t');
    const explicit = OrkRocket.buildTree(resolveTransitionRadii(t)).componentInfo('t');
    expect(automatic.mass).toBeGreaterThan(0);
    expect(automatic.mass).toBeCloseTo(explicit.mass, 10);
    expect(automatic.cgX).toBeCloseTo(explicit.cgX, 10);
  });

  it('searches adjacent inline assemblies but skips off-axis assemblies', async () => {
    const tr: ComponentNode = { type: 'transition', id: 't', length: 0.1 };
    const asm: ComponentNode = { type: 'podset', radiusMethod: 'free', radiusOffset: 0 };
    const t = tree({ type: 'bodytube', length: 0.4, outerRadius: 0.02, children: [
      { ...asm, children: [{ type: 'bodytube', length: 0.1, outerRadius: 0.04 }] },
      { ...asm, radiusOffset: 0.1, children: [{ type: 'bodytube', length: 0.1, outerRadius: 0.09 }] },
      { ...asm, children: [tr] },
      { ...asm, type: 'parallelstage', children: [{ type: 'bodytube', length: 0.1, outerRadius: 0.06 }] },
    ] });
    await matchesExplicit(t, 'fore', 0.04);
    await matchesExplicit(t, 'aft', 0.06);
  });
});
