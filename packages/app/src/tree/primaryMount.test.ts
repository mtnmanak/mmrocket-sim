import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { autoDelayBox, padMassOntoRankedPrimary, primaryMountOf } from './treeModel.js';

/**
 * What the core-first primary ranking (audit 2026-09-22, row 356) has to carry
 * with it, found in review: a weighed pad mass saved on the record that used to
 * win the tie, and an auto-delay flag on a card that no longer shows the box.
 *
 * App's use of both is App.render.test.tsx's (audit 2026-09-22, row 477), with
 * App mounted on a pod design: the restore moving the pad mass in the working
 * set and in a stored configuration, and each card's box. It was string
 * matches over App.tsx at the foot of this file.
 */

/** A core mount, a two-pod set and a two-strap-on ring in one stage; a booster below. */
const tree: RocketTree = {
  name: 'rings',
  components: [
    {
      type: 'stage', id: 's0', name: 'Sustainer',
      children: [{
        type: 'bodytube', id: 'b0', length: 0.3, children: [
          { type: 'innertube', id: 'core', name: 'Core MMT', motorMount: true } as ComponentNode,
          { type: 'innertube', id: 'core2', name: 'Second core MMT', motorMount: true } as ComponentNode,
          {
            type: 'podset', id: 'pods', instanceCount: 2, children: [{
              type: 'bodytube', id: 'pb', length: 0.2,
              children: [{ type: 'innertube', id: 'pod', name: 'Pod MMT', motorMount: true } as ComponentNode],
            } as ComponentNode],
          } as ComponentNode,
          {
            type: 'parallelstage', id: 'straps', instanceCount: 2, children: [{
              type: 'bodytube', id: 'sb', length: 0.2,
              children: [{ type: 'innertube', id: 'strap', name: 'Strap MMT', motorMount: true } as ComponentNode],
            } as ComponentNode],
          } as ComponentNode,
        ],
      } as ComponentNode],
    } as ComponentNode,
    {
      type: 'stage', id: 's1', name: 'Booster',
      children: [{ type: 'bodytube', id: 'b1', length: 0.2, motorMount: true } as ComponentNode],
    } as ComponentNode,
  ],
};

interface Rec { label: string; padMassKg?: number; padMassWeighedWith?: string }

describe('padMassOntoRankedPrimary — a weighing saved under the old tie-break', () => {
  it('moves the pad mass and its set key off a pod picked first, onto the core', () => {
    const motors: Record<string, Rec> = {
      pod: { label: 'C6-5', padMassKg: 0.42, padMassWeighedWith: 'SET' },
      core: { label: 'D12-5' },
    };
    expect(primaryMountOf(tree, Object.keys(motors))).toBe('core');
    const r = padMassOntoRankedPrimary(tree, motors);
    expect(r.from).toBe('pod');
    expect(r.to).toBe('core');
    expect(r.kg).toBe(0.42);
    expect(r.motors['core']).toEqual({ label: 'D12-5', padMassKg: 0.42, padMassWeighedWith: 'SET' });
    // BOTH keys leave the old record — dirtyState hashes keys, so none may linger.
    expect(r.motors['pod']).toEqual({ label: 'C6-5' });
    // Key order kept: it is the tie-break between two core mounts.
    expect(Object.keys(r.motors)).toEqual(['pod', 'core']);
    // The input is not mutated.
    expect(motors['pod']!.padMassKg).toBe(0.42);
  });

  it('moves it off a strap-on picked first, and off a strap-on onto a pod', () => {
    const a = padMassOntoRankedPrimary(tree, {
      strap: { label: 'C6-3', padMassKg: 0.5, padMassWeighedWith: 'K' }, core: { label: 'C6-5' },
    });
    expect([a.from, a.to]).toEqual(['strap', 'core']);
    const b = padMassOntoRankedPrimary(tree, {
      strap: { label: 'C6-3', padMassKg: 0.5, padMassWeighedWith: 'K' }, pod: { label: 'C6-5' },
    });
    expect([b.from, b.to]).toEqual(['strap', 'pod']);
    expect(b.motors['pod']!.padMassKg).toBe(0.5);
  });

  it('returns the set untouched when the rankings agree or there is nothing to move', () => {
    const cases: Record<string, Rec>[] = [
      // The core was picked first: the old tie-break already named it.
      { core: { label: 'A', padMassKg: 0.3, padMassWeighedWith: 'K' }, pod: { label: 'B' } },
      // Two core mounts still tie on order — unchanged, so nothing moves.
      { core2: { label: 'A', padMassKg: 0.3, padMassWeighedWith: 'K' }, core: { label: 'B' } },
      // No weighing on the old primary.
      { pod: { label: 'A' }, core: { label: 'B' } },
      // The new primary carries one of its own: never overwritten.
      { pod: { label: 'A', padMassKg: 0.3, padMassWeighedWith: 'K' }, core: { label: 'B', padMassKg: 0.4, padMassWeighedWith: 'K' } },
      // A stage above still wins on stage alone, as before.
      { b1: { label: 'A', padMassKg: 0.3, padMassWeighedWith: 'K' } },
      {},
    ];
    for (const motors of cases) {
      const r = padMassOntoRankedPrimary(tree, motors);
      expect(r.motors).toBe(motors);
      expect(r.from).toBeUndefined();
    }
  });

  it('ignores a record for a mount the tree no longer has', () => {
    const motors: Record<string, Rec> = { gone: { label: 'A', padMassKg: 0.3, padMassWeighedWith: 'K' }, core: { label: 'B' } };
    expect(padMassOntoRankedPrimary(tree, motors).motors).toBe(motors);
  });
});

describe('autoDelayBox — the auto-delay box each mount card shows', () => {
  it('offers the working box on the primary’s sustainer card, ticked or not', () => {
    expect(autoDelayBox(tree, 'core', 'core', false)).toBe('optimal');
    expect(autoDelayBox(tree, 'core', 'core', true)).toBe('optimal');
  });

  it('shows a box on any other card whose motor carries the flag, so it can be unticked', () => {
    // The pod and the strap-on fly their provisional delay whatever the flag
    // says; only the primary's is honoured (flightRunner).
    expect(autoDelayBox(tree, 'strap', 'core', true)).toBe('top-motor-only');
    expect(autoDelayBox(tree, 'pod', 'core', true)).toBe('top-motor-only');
    expect(autoDelayBox(tree, 'b1', 'core', true)).toBe('top-motor-only');
    // …and none where there is nothing to untick.
    expect(autoDelayBox(tree, 'strap', 'core', false)).toBeNull();
    expect(autoDelayBox(tree, 'pod', null, false)).toBeNull();
  });

  it('a booster that is primary shows the working box once ticked, and none before', () => {
    expect(autoDelayBox(tree, 'b1', 'b1', false)).toBeNull();
    expect(autoDelayBox(tree, 'b1', 'b1', true)).toBe('optimal');
  });
});
