import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { estimateMotorRoom, estimateMotorRoomForMounts } from './motorRoom.js';

/**
 * The "how long a motor fits" estimate (owner, 2026-08-30). Measured forward
 * from the mount's AFT end, because that is where a motor seats, and stopped
 * by the things that exist to stop a motor.
 */
const treeWith = (mountChildren: Record<string, unknown>[], mountExtra: Record<string, unknown> = {}) => ({
  name: 'R',
  components: [{
    id: 's1', type: 'stage',
    children: [{
      id: 'b1', type: 'bodytube', length: 0.6, outerRadius: 0.03,
      children: [{
        id: 'mt', type: 'innertube', length: 0.30, outerRadius: 0.0145,
        position: { method: 'bottom', offset: 0 },
        children: mountChildren, ...mountExtra,
      }],
    }],
  }],
} as unknown as RocketTree);

describe('estimateMotorRoom', () => {
  it('an empty mount tube gives its own length', () => {
    const r = estimateMotorRoom(treeWith([]), 'mt')!;
    expect(r.lengthM).toBeCloseTo(0.30, 9);
    expect(r.limitedBy).toBe('the front of the mount tube');
  });

  it('adds the overhang the mount allows', () => {
    const r = estimateMotorRoom(treeWith([], { motorOverhang: 0.006 }), 'mt')!;
    expect(r.lengthM).toBeCloseTo(0.306, 9);
  });

  it('stops at an engine block, measured to its AFT face', () => {
    // A 3 mm block 100 mm down from the tube's fore end: its aft face is at
    // 103 mm, leaving 197 mm of tube behind it.
    const r = estimateMotorRoom(treeWith([
      { id: 'eb', type: 'engineblock', name: 'Thrust ring', length: 0.003, outerRadius: 0.0145,
        position: { method: 'top', offset: 0.1 } },
    ]), 'mt')!;
    expect(r.lengthM).toBeCloseTo(0.197, 9);
    expect(r.limitedBy).toBe('Thrust ring');
  });

  it('takes the aftmost of several blockers', () => {
    const r = estimateMotorRoom(treeWith([
      { id: 'eb', type: 'engineblock', length: 0.003, position: { method: 'top', offset: 0.1 } },
      { id: 'bh', type: 'bulkhead', name: 'Ebay floor', length: 0.005, position: { method: 'top', offset: 0.15 } },
    ]), 'mt')!;
    expect(r.lengthM).toBeCloseTo(0.145, 9); // 0.30 − 0.155
    expect(r.limitedBy).toBe('Ebay floor');
  });

  it('ignores a centering ring — the motor passes through its bore', () => {
    const r = estimateMotorRoom(treeWith([
      { id: 'cr', type: 'centeringring', length: 0.003, position: { method: 'top', offset: 0.05 } },
      { id: 'tc', type: 'tubecoupler', length: 0.02, position: { method: 'top', offset: 0.2 } },
    ]), 'mt')!;
    expect(r.lengthM).toBeCloseTo(0.30, 9);
  });

  it('counts a mass component, which is how a sled in the tube gets modelled', () => {
    const r = estimateMotorRoom(treeWith([
      { id: 'ms', type: 'masscomponent', name: 'Sled', length: 0.04, position: { method: 'top', offset: 0 } },
    ]), 'mt')!;
    expect(r.lengthM).toBeCloseTo(0.26, 9);
    expect(r.limitedBy).toBe('Sled');
  });

  it('returns null for an unknown mount, and for one with no room left', () => {
    expect(estimateMotorRoom(treeWith([]), 'nope')).toBeNull();
    expect(estimateMotorRoom(treeWith([
      { id: 'bh', type: 'bulkhead', length: 0.30, position: { method: 'top', offset: 0 } },
    ]), 'mt')).toBeNull();
  });

  it('takes the tightest mount when a stage has several', () => {
    const tree = {
      name: 'R',
      components: [{
        id: 's1', type: 'stage',
        children: [{
          id: 'b1', type: 'bodytube', length: 0.6, outerRadius: 0.05,
          children: [
            { id: 'm1', type: 'innertube', length: 0.30, outerRadius: 0.0145 },
            { id: 'm2', type: 'innertube', length: 0.18, outerRadius: 0.0145 },
          ],
        }],
      }],
    } as unknown as RocketTree;
    const r = estimateMotorRoomForMounts(tree, ['m1', 'm2'])!;
    expect(r.lengthM).toBeCloseTo(0.18, 9);
    expect(estimateMotorRoomForMounts(tree, ['nope'])).toBeNull();
  });
});
