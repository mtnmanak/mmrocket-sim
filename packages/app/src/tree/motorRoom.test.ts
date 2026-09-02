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
  it('runs PAST the mount tube when nothing is in the way', () => {
    // Owner ruling 2026-09-01b: "motors are allowed to be longer than the
    // motor mount tube. The motor mount tube merely provides a framework for
    // the motor to sit in." The 300 mm mount sits at the aft end of a 600 mm
    // airframe with nothing modelled in it, so the honest answer is 600 mm --
    // and `limitedBy` says so, which is the cue to model the ebay bulkhead.
    const r = estimateMotorRoom(treeWith([]), 'mt')!;
    expect(r.lengthM).toBeCloseTo(0.60, 9);
    expect(r.limitedBy).toBe('the front of the airframe');
  });

  it('adds the overhang the mount allows', () => {
    const r = estimateMotorRoom(treeWith([], { motorOverhang: 0.006 }), 'mt')!;
    expect(r.lengthM).toBeCloseTo(0.606, 9);
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
    expect(r.lengthM).toBeCloseTo(0.60, 9);
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
    expect(r.lengthM).toBeCloseTo(0.60, 9);
    expect(r.limitedBy).toBe('the front of the airframe');
  });

  it('reproduces the 4in Wildman Extreme, the design that exposed this', () => {
    // His own geometry, read out of `4in WM Extreme.rkt`: a 380mm motor mount
    // with a ZERO-LENGTH "Retainer" mass object 15mm up from the aft end. That
    // file is not in the repo (docs/ is gitignored), so the numbers live here.
    //
    // Measured against the old rule: 15.5mm, "limited by Retainer". The app was
    // telling him a 380mm mount had room for a 15mm motor — on a rocket that
    // flies 75mm hardware. Now 380.5mm, the mount's own length plus overhang.
    //
    // The mount is the whole airframe here, so this fixture also pins the case
    // where nothing forward is modelled: `limitedBy` names the airframe, not a
    // bulkhead, which is what tells the reader nothing was in the way.
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
    expect(r.limitedBy).toBe('the front of the airframe');
  });

  it('does not count recovery gear, which moves aside when a motor is loaded', () => {
    // Owner, same ruling: "things like parachutes and shock cords are not
    // obstructions because they move out of the way when you load a motor."
    // They have never blocked; this is here so they cannot quietly start.
    for (const type of ['parachute', 'streamer', 'shockcord']) {
      const r = estimateMotorRoom(treeWith([
        { id: 'r1', type, name: 'Chute', length: 0.05, position: { method: 'top', offset: 0 } },
      ]), 'mt')!;
      expect(r.lengthM, `${type} blocked the motor`).toBeCloseTo(0.60, 9);
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

  /**
   * Owner ruling, 2026-09-01b: *"motors are allowed to be longer than the motor
   * mount tube. The motor mount tube merely provides a framework for the motor
   * to sit in — motors are frequently longer than the motor mount tube. In most
   * dual deploy rockets, the first real obstruction that stops a motor is the
   * aft bulkhead on the electronics bay."*
   */
  describe('walking forward out of the mount', () => {
    /** Nose cone, ebay tube, booster tube; the mount sits at the booster's tail. */
    const dualDeploy = (ebayChildren: Record<string, unknown>[] = []) => ({
      name: 'DD',
      components: [{
        id: 's1', type: 'stage',
        children: [
          { id: 'nc', type: 'nosecone', name: 'Nose cone', length: 0.30, aftRadius: 0.05 },
          { id: 'eb', type: 'bodytube', name: 'Ebay', length: 0.20, outerRadius: 0.05, children: ebayChildren },
          {
            id: 'bt', type: 'bodytube', name: 'Booster', length: 1.00, outerRadius: 0.05,
            children: [{
              id: 'mt', type: 'innertube', name: 'MMT', length: 0.30, outerRadius: 0.0387,
              position: { method: 'bottom', offset: 0 },
            }],
          },
        ],
      }],
    } as unknown as RocketTree);

    it("stops at the ebay's aft bulkhead, which is the real obstruction", () => {
      // The bulkhead sits at the ebay's aft end: station 0.30 + 0.20 = 0.50.
      // The mount's aft end is at the tail, 1.50. So 1.00 m of motor room —
      // more than three times the 300 mm mount, which is the point.
      const r = estimateMotorRoom(dualDeploy([
        { id: 'bh', type: 'bulkhead', name: 'Ebay floor', length: 0.006,
          position: { method: 'bottom', offset: 0 } },
      ]), 'mt')!;
      expect(r.lengthM).toBeCloseTo(1.00, 9);
      expect(r.limitedBy).toBe('Ebay floor');
    });

    it('a motor may be longer than its own mount tube', () => {
      const r = estimateMotorRoom(dualDeploy([
        { id: 'bh', type: 'bulkhead', name: 'Ebay floor', length: 0.006,
          position: { method: 'bottom', offset: 0 } },
      ]), 'mt')!;
      const mountLength = 0.30;
      expect(r.lengthM, 'the mount tube is still capping the answer')
        .toBeGreaterThan(mountLength);
    });

    it('stops at the nose cone when nothing inside is modelled', () => {
      // No bulkhead anywhere: the motor can reach the back of the nose cone,
      // which it cannot enter. 1.50 − 0.30 = 1.20.
      const r = estimateMotorRoom(dualDeploy(), 'mt')!;
      expect(r.lengthM).toBeCloseTo(1.20, 9);
      expect(r.limitedBy).toBe('Nose cone');
    });

    it('never crosses a stage boundary — a booster cannot load into the sustainer', () => {
      // Sustainer with a bulkhead of its own, then a booster stage. The
      // booster's motor must stop at its own stage's fore end, not run up
      // into the stage above it, because they separate in flight.
      const tree = {
        name: 'Two stage',
        components: [
          {
            id: 'sus', type: 'stage', name: 'Sustainer',
            children: [
              { id: 'nc', type: 'nosecone', name: 'Nose cone', length: 0.20, aftRadius: 0.04 },
              { id: 'st', type: 'bodytube', name: 'Sustainer tube', length: 0.50, outerRadius: 0.04 },
            ],
          },
          {
            id: 'boo', type: 'stage', name: 'Booster',
            children: [{
              id: 'bt', type: 'bodytube', name: 'Booster tube', length: 0.40, outerRadius: 0.04,
              children: [{
                id: 'mt', type: 'innertube', name: 'MMT', length: 0.20, outerRadius: 0.029,
                position: { method: 'bottom', offset: 0 },
              }],
            }],
          },
        ],
      } as unknown as RocketTree;
      const r = estimateMotorRoom(tree, 'mt')!;
      expect(r.lengthM, 'the walk ran up into the sustainer').toBeCloseTo(0.40, 9);
      expect(r.limitedBy).toBe('the front of the airframe');
    });

    it('stops at a transition that narrows going forward', () => {
      const tree = {
        name: 'Reducer',
        components: [{
          id: 's1', type: 'stage',
          children: [
            { id: 'up', type: 'bodytube', name: 'Upper', length: 0.30, outerRadius: 0.03 },
            { id: 'tr', type: 'transition', name: 'Reducer', length: 0.05, foreRadius: 0.03, aftRadius: 0.05 },
            {
              id: 'lo', type: 'bodytube', name: 'Lower', length: 0.50, outerRadius: 0.05,
              children: [{
                id: 'mt', type: 'innertube', name: 'MMT', length: 0.20, outerRadius: 0.0387,
                position: { method: 'bottom', offset: 0 },
              }],
            },
          ],
        }],
      } as unknown as RocketTree;
      const r = estimateMotorRoom(tree, 'mt')!;
      // The transition's aft face is at 0.35; the mount's aft end at 0.85.
      expect(r.lengthM).toBeCloseTo(0.50, 9);
      expect(r.limitedBy).toBe('Reducer');
    });

    it('ignores a transition that OPENS going forward', () => {
      const tree = {
        name: 'Boat tail',
        components: [{
          id: 's1', type: 'stage',
          children: [
            { id: 'up', type: 'bodytube', name: 'Upper', length: 0.30, outerRadius: 0.05 },
            { id: 'tr', type: 'transition', name: 'Boat tail', length: 0.05, foreRadius: 0.05, aftRadius: 0.03 },
            {
              id: 'lo', type: 'bodytube', name: 'Lower', length: 0.50, outerRadius: 0.03,
              children: [{
                id: 'mt', type: 'innertube', name: 'MMT', length: 0.20, outerRadius: 0.029,
                position: { method: 'bottom', offset: 0 },
              }],
            },
          ],
        }],
      } as unknown as RocketTree;
      const r = estimateMotorRoom(tree, 'mt')!;
      expect(r.lengthM).toBeCloseTo(0.85, 9);
      expect(r.limitedBy).toBe('the front of the airframe');
    });

    it('ignores a bulkhead that is AFT of where the motor seats', () => {
      // A bulkhead behind the motor's own aft face cannot be in its way.
      const r = estimateMotorRoom({
        name: 'R',
        components: [{
          id: 's1', type: 'stage',
          children: [{
            id: 'bt', type: 'bodytube', length: 0.60, outerRadius: 0.05,
            children: [
              { id: 'mt', type: 'innertube', length: 0.30, outerRadius: 0.0387,
                position: { method: 'top', offset: 0 } },
              { id: 'bh', type: 'bulkhead', name: 'Tail plate', length: 0.005,
                position: { method: 'bottom', offset: 0 } },
            ],
          }],
        }],
      } as unknown as RocketTree, 'mt')!;
      expect(r.lengthM).toBeCloseTo(0.30, 9);
      expect(r.limitedBy).toBe('the front of the airframe');
    });
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
