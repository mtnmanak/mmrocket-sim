import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { resolveTransitionRadii } from './transitionRadii.js';
import { solidContextFor } from './solidContext.js';
import { componentLoop } from './solidMesh.js';
import { printOffer } from '../services/printPack.js';

const tree = (...children: ComponentNode[]): RocketTree => ({ name: 'R', components: [{ type: 'stage', children }] });
describe('B6 automatic transition radii', () => {
  it.each(['podset', 'parallelstage'])('leaves flush inline %s sleeve neighbours unresolved on both sides', (type) => {
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
      const resolved = resolveTransitionRadii(t).components[0]!.children!.find((n) => n.id === 't')!;
      expect(resolved[`${side}Radius`]).toBeUndefined();
      const ctx = solidContextFor(t, tr);
      expect(componentLoop(tr, ctx)!.sizeAssumed).toBe(true);
      expect(printOffer(tr, ctx, null).tone).toBe('warn');
      // Off-axis sleeves do not participate in the kernel's neighbour search.
      tube.children![0]!['radiusOffset'] = 0.1;
      const offAxis = resolveTransitionRadii(t).components[0]!.children!.find((n) => n.id === 't')!;
      expect(offAxis[`${side}Radius`]).toBeCloseTo(0.02, 12);
      tube.children![0]!['radiusOffset'] = 0;
    }
  });
  it('leaves the aft end unresolved when the last transition has its own inline sleeve', () => {
    const tr: ComponentNode = { type: 'transition', id: 't', length: 0.2, foreRadius: 0.03, children: [{
      type: 'podset', radiusMethod: 'free', radiusOffset: 0, instanceCount: 1,
      position: { method: 'bottom', offset: 0 },
      children: [{ type: 'bodytube', length: 0.1, outerRadius: 0.05 }],
    }] };
    const t = tree(tr);
    expect(resolveTransitionRadii(t).components[0]!.children![0]!['aftRadius']).toBeUndefined();
    expect(componentLoop(tr, solidContextFor(t, tr))!.sizeAssumed).toBe(true);
    expect(printOffer(tr, solidContextFor(t, tr), null).tone).toBe('warn');
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
