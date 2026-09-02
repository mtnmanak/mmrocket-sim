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

  /**
   * Owner ruling, 2026-09-01, reversing this: *"For motor length estimation,
   * mass components are probably not an obstruction … I modeled the motor
   * retainer near the aft end of the rocket as a mass component in order to
   * ensure my CG was accurate. A motor retainer is designed to keep a motor in
   * place, not block it from being installed."*
   *
   * This test used to assert the opposite, on the reasoning that a mass
   * component is how an altimeter sled gets modelled. A mass component has no
   * bore and no radius, so nothing about it says a motor cannot pass — and
   * guessing that it cannot is what broke a real design.
   */
  it('does NOT count a mass component — a retainer is not an obstruction', () => {
    const r = estimateMotorRoom(treeWith([
      { id: 'ms', type: 'masscomponent', name: 'Retainer', length: 0.04, position: { method: 'bottom', offset: 0 } },
    ]), 'mt')!;
    expect(r.lengthM).toBeCloseTo(0.30, 9);
    expect(r.limitedBy).toBe('the front of the mount tube');
  });

  it('reproduces the 4in Wildman Extreme, the design that exposed this', () => {
    // His own geometry, read out of `4in WM Extreme.rkt`: a 380mm motor mount
    // with a ZERO-LENGTH "Retainer" mass object 15mm up from the aft end. That
    // file is not in the repo (docs/ is gitignored), so the numbers live here.
    //
    // Measured against the old rule: 15.5mm, "limited by Retainer". The app was
    // telling him a 380mm mount had room for a 15mm motor — on a rocket that
    // flies 75mm hardware. Now 380.5mm, the mount's own length plus overhang.
    const mount = {
      id: 'mmt', type: 'bodytube', name: 'MMT', length: 0.380, motorMount: true,
      motorOverhang: 0.0005,
      children: [{
        id: 'ret', type: 'masscomponent', name: 'Retainer', length: 0,
        position: { method: 'bottom', offset: -0.015 },
      }],
    };
    const tree = { name: 'WM', components: [{ id: 's1', type: 'stage', children: [mount] }] };
    const r = estimateMotorRoom(tree as never, 'mmt')!;
    expect(r.lengthM * 1000).toBeCloseTo(380.5, 6);
    expect(r.limitedBy).toBe('the front of MMT');
  });

  it('does not count recovery gear, which moves aside when a motor is loaded', () => {
    // Owner, same ruling: "things like parachutes and shock cords are not
    // obstructions because they move out of the way when you load a motor."
    // They have never blocked; this is here so they cannot quietly start.
    for (const type of ['parachute', 'streamer', 'shockcord']) {
      const r = estimateMotorRoom(treeWith([
        { id: 'r1', type, name: 'Chute', length: 0.05, position: { method: 'top', offset: 0 } },
      ]), 'mt')!;
      expect(r.lengthM, `${type} blocked the motor`).toBeCloseTo(0.30, 9);
    }
  });

  it('still stops at an engine block or a bulkhead, which exist to stop a motor', () => {
    const block = estimateMotorRoom(treeWith([
      { id: 'eb', type: 'engineblock', name: 'Thrust ring', length: 0.01, position: { method: 'top', offset: 0 } },
    ]), 'mt')!;
    expect(block.lengthM).toBeCloseTo(0.29, 9);
    expect(block.limitedBy).toBe('Thrust ring');
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
