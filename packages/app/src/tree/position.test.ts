import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { OrkRocket, resetEngine } from '@online-openrocket/engine';
import { absoluteStations, axialLength, resolveAbsolutePositions } from './position.js';
import { engineTree } from './treeModel.js';

/**
 * `absoluteStations` — where every part sits along the assembled rocket.
 *
 * This walk is what lets the wake check (mountAngle.wakeShadowWarnings) say
 * "220 mm ahead of the fin", so it has to agree with the frame everything else
 * in the app calls a station: the property panel's "starts N mm from nose"
 * and, underneath that, the kernel's own `ComponentInfo.positionX`. The last
 * test here pins it against the kernel directly so the two cannot drift.
 */

const num = (n: ComponentNode, key: string): number => n[key] as number;

describe('absoluteStations', () => {
  it('stacks the chain nose-to-tail and ignores a chain member\'s own position', () => {
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027 },
        { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: 0.027 },
        // A chain member carrying a position field: layout must ignore it, the
        // way resolveAbsolutePositions does (chain members stack).
        { type: 'transition', id: 'tr', length: 0.05, foreRadius: 0.027,
          aftRadius: 0.019, position: { method: 'top', offset: 0.9 } },
      ] }],
    } as unknown as RocketTree;
    const st = absoluteStations(t);
    expect(st.get('nc')!.start).toBeCloseTo(0, 12);
    expect(st.get('nc')!.end).toBeCloseTo(0.15, 12);
    expect(st.get('b1')!.start).toBeCloseTo(0.15, 12);
    expect(st.get('tr')!.start).toBeCloseTo(0.85, 12);
    expect(st.get('tr')!.end).toBeCloseTo(0.90, 12);
    // A chain member is nobody's child in this frame.
    expect(st.get('b1')!.parent).toBeNull();
  });

  it('places a child by its own method, and records what it is mounted on', () => {
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027 },
        { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: 0.027, children: [
          { type: 'fairing', id: 'top', length: 0.08, width: 0.025, height: 0.02,
            position: { method: 'top', offset: 0.30 } },
          { type: 'fairing', id: 'mid', length: 0.08, width: 0.025, height: 0.02,
            position: { method: 'middle', offset: 0 } },
          { type: 'trapezoidfinset', id: 'fins', finCount: 3, rootChord: 0.10,
            position: { method: 'bottom', offset: 0 } },
        ] },
      ] }],
    } as unknown as RocketTree;
    const st = absoluteStations(t);
    expect(st.get('top')!.start).toBeCloseTo(0.45, 12);   // 0.15 + 0.30
    expect(st.get('top')!.end).toBeCloseTo(0.53, 12);
    expect(st.get('mid')!.start).toBeCloseTo(0.46, 12);   // 0.15 + (0.7-0.08)/2
    expect(st.get('fins')!.start).toBeCloseTo(0.75, 12);  // 0.15 + 0.7 - 0.10
    // A fin set's axial extent IS its root chord — the leading edge is what a
    // wake arrives at, so this is the number wakeShadowWarnings measures to.
    expect(st.get('fins')!.end).toBeCloseTo(0.85, 12);
    expect(axialLength(st.get('fins')!.node)).toBeCloseTo(0.10, 12);
    // The mount: what mountRadiusOf is handed to size the airframe underneath.
    expect(st.get('top')!.parent!.id).toBe('b1');
    expect(num(st.get('top')!.parent!, 'outerRadius')).toBeCloseTo(0.027, 12);
  });

  it('nests: a ring inside an inner tube inside a body tube', () => {
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'bodytube', id: 'b1', length: 0.6, outerRadius: 0.027, children: [
          { type: 'innertube', id: 'mmt', length: 0.3, outerRadius: 0.0145,
            position: { method: 'bottom', offset: 0 }, children: [
              { type: 'centeringring', id: 'cr', length: 0.005,
                position: { method: 'top', offset: 0.02 } },
            ] },
        ] },
      ] }],
    } as unknown as RocketTree;
    const st = absoluteStations(t);
    expect(st.get('mmt')!.start).toBeCloseTo(0.30, 12);
    expect(st.get('cr')!.start).toBeCloseTo(0.32, 12);
    expect(st.get('cr')!.parent!.id).toBe('mmt');
  });

  it('carries on across a STAGE boundary — one assembled stack, one zero', () => {
    const t = {
      name: 'T', components: [
        { type: 'stage', id: 'sust', children: [
          { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027 },
          { type: 'bodytube', id: 'pay', length: 0.5, outerRadius: 0.027 },
        ] },
        { type: 'stage', id: 'boost', children: [
          { type: 'bodytube', id: 'bfin', length: 0.3, outerRadius: 0.027, children: [
            { type: 'trapezoidfinset', id: 'bf', finCount: 3, rootChord: 0.10,
              position: { method: 'bottom', offset: 0 } },
          ] },
        ] },
      ],
    } as unknown as RocketTree;
    const st = absoluteStations(t);
    expect(st.get('bfin')!.start).toBeCloseTo(0.65, 12);
    expect(st.get('bf')!.start).toBeCloseTo(0.85, 12);
  });

  /**
   * An `absolute` position is ALREADY in this frame — it is the rocket-origin
   * offset only file importers produce. `resolveAbsolutePositions` rewrites it
   * into a parent-relative `top` at load, and this walk has to land on the same
   * station either way, or a freshly imported design would measure differently
   * from the same design one edit later.
   */
  it('reads an absolute position in the rocket frame, before OR after resolving', () => {
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027 },
        { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: 0.027, children: [
          { type: 'fairing', id: 'cam', length: 0.08, width: 0.025, height: 0.02,
            position: { method: 'absolute', offset: 0.45 } },
        ] },
      ] }],
    } as unknown as RocketTree;
    expect(absoluteStations(t).get('cam')!.start).toBeCloseTo(0.45, 12);
    const resolved = resolveAbsolutePositions(t);
    // Non-vacuous: the rewrite really did happen.
    expect((resolved.components[0]!.children![1]!.children![0]!.position as { method: string }).method)
      .toBe('top');
    expect(absoluteStations(resolved).get('cam')!.start).toBeCloseTo(0.45, 12);
  });

  /**
   * THE PIN THAT STOPS THE TWO DRIFTING. `ComponentInfo.positionX` is "the
   * absolute position of the component's front from the nose tip", computed by
   * the kernel from the tree engineTree() hands it. If this walk and that one
   * ever disagree, the property panel and the wake sentence start quoting
   * different stations for the same part.
   */
  it('agrees with the kernel\'s own positionX', async () => {
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027, shape: 'ogive', thickness: 0.002 },
        { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: 0.027, thickness: 0.001, children: [
          { type: 'innertube', id: 'mmt', length: 0.3, outerRadius: 0.0145, thickness: 0.001,
            position: { method: 'bottom', offset: 0 } },
          { type: 'trapezoidfinset', id: 'fins', finCount: 3, rootChord: 0.10, tipChord: 0.05,
            sweep: 0.05, height: 0.055, thickness: 0.003,
            position: { method: 'bottom', offset: 0 } },
        ] },
      ] }],
    } as unknown as RocketTree;
    const st = absoluteStations(t);
    resetEngine();
    const rocket = OrkRocket.buildTree(engineTree(t));
    for (const id of ['nc', 'b1', 'mmt', 'fins']) {
      expect(rocket.componentInfo(id).positionX, `station of ${id}`)
        .toBeCloseTo(st.get(id)!.start, 9);
    }
  }, 60000);
});
