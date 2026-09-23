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

  /**
   * The overhang is SIGNED and both signs count. schema.ts gives
   * `motorOverhang` smin −50 mm on both mount types, and a negative one is the
   * ordinary min-diameter build: the motor is recessed so a retainer cap can
   * close over its aft face. The aft datum the search measures forward from is
   * `mountAft + overhang`, so a recess makes the room SMALLER.
   *
   * Until v0.104 the term was `Math.max(0, overhang)`, which threw the negative
   * away silently — a mount at −20 mm reported 20 mm more room than it has, and
   * that number is what the "Max motor length" ⌾ button writes and what gates
   * the motor browser, so a case too long for the airframe was offered as
   * fitting. Written as a PAIR because the asymmetry is the defect: the
   * positive case already passed.
   */
  it('subtracts a NEGATIVE overhang — a recessed motor has less room, not the same', () => {
    const recessed = estimateMotorRoom(treeWith([], { motorOverhang: -0.02 }), 'mt')!;
    expect(recessed.lengthM).toBeCloseTo(0.58, 9);
    const flush = estimateMotorRoom(treeWith([]), 'mt')!;
    expect(recessed.lengthM, 'a recessed motor was given the flush-mount room')
      .toBeLessThan(flush.lengthM);
  });

  it('returns null when the recess is deeper than the room in front of it', () => {
    // A 3 mm engine block 10 mm down the 300 mm mount leaves 287 mm; recess the
    // motor 300 mm and nothing is left. The `room > 0` guard is what catches it.
    expect(estimateMotorRoom(treeWith([
      { id: 'eb', type: 'engineblock', length: 0.003, outerRadius: 0.0145,
        position: { method: 'top', offset: 0.01 } },
    ], { motorOverhang: -0.30 }), 'mt')).toBeNull();
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

/**
 * PODS AND STRAP-ONS (audit 2026-09-22, rows 359 and 360). A pod set or a
 * strap-on ring is its own airframe beside the core: its nose cone and its
 * bulkheads cannot stop a core motor, and the core's cannot stop a pod's. The
 * search used to span every frame in the stage, so a pod's nose cone "limited"
 * the core motor — measured 1.00 m without the pod, 0.30 m with it — and since
 * the minimum over a stage's mounts feeds Room for and Estimate, the motor
 * browser was filtered by a stop no motor in the stage ever meets. And inside a
 * pod the chain did not stack, so a pod mount measured from the wrong place.
 *
 * The stage figure is STILL the minimum over its mounts, pods included: one
 * per-stage limit filters every mount's browser in that stage, so it has to be
 * a length every one of them can take. What changed is that each mount's own
 * figure is now true, so the minimum is a real room, named by a real stop.
 */
describe('a pod set or strap-on is its own airframe', () => {
  /** The dual-deploy core of the tests above, with a ring on the booster tube. */
  const withRing = (type: 'podset' | 'parallelstage', ebayBulkhead = true, podNose = true) => ({
    name: 'Pods',
    components: [{
      id: 's1', type: 'stage',
      children: [
        { id: 'nc', type: 'nosecone', name: 'Nose cone', length: 0.30, aftRadius: 0.05 },
        {
          id: 'eb', type: 'bodytube', name: 'Ebay', length: 0.20, outerRadius: 0.05,
          children: ebayBulkhead ? [{
            id: 'bh', type: 'bulkhead', name: 'Ebay floor', length: 0.006, position: { method: 'bottom', offset: 0 },
          }] : [],
        },
        {
          id: 'bt', type: 'bodytube', name: 'Booster', length: 1.00, outerRadius: 0.05,
          children: [
            {
              id: 'mt', type: 'innertube', name: 'MMT', length: 0.30, outerRadius: 0.0387,
              position: { method: 'bottom', offset: 0 },
            },
            {
              id: 'pods', type, name: type === 'podset' ? 'Pods' : 'Strap-ons', instanceCount: 2,
              position: { method: 'bottom', offset: 0 },
              children: [
                ...(podNose ? [{ id: 'pn', type: 'nosecone', name: 'Pod nose', length: 0.08, aftRadius: 0.02 }] : []),
                { id: 'pt1', type: 'bodytube', name: 'Pod tube 1', length: 0.20, outerRadius: 0.02, children: [
                  { id: 'pbh', type: 'bulkhead', name: 'Pod bulkhead', length: 0.005, position: { method: 'top', offset: 0 } },
                ] },
                { id: 'pt2', type: 'bodytube', name: 'Pod tube 2', length: 0.25, outerRadius: 0.02, children: [
                  { id: 'pm', type: 'innertube', name: 'Pod MMT', length: 0.10, outerRadius: 0.012,
                    position: { method: 'bottom', offset: 0 } },
                ] },
              ],
            },
          ],
        },
      ],
    }],
  } as unknown as RocketTree);

  for (const type of ['podset', 'parallelstage'] as const) {
    it(`a ${type}'s nose cone and bulkhead do not block the core motor`, () => {
      // Without the ring this core has 1.00 m to the ebay floor (above); the
      // pod's nose sits 0.47 m forward of the tail and its bulkhead 0.39 m.
      const r = estimateMotorRoom(withRing(type), 'mt')!;
      expect(r.lengthM).toBeCloseTo(1.00, 9);
      expect(r.limitedBy).toBe('Ebay floor');
    });

    it(`a ${type} mount stops at its own bulkhead, not the core's`, () => {
      // The pod is 0.08 + 0.20 + 0.25 = 0.53 m long, aft-flush with the core's
      // 1.50 m tail: it starts at 0.97. Its first tube starts at 1.05, so the
      // bulkhead at its top has its aft face at 1.055; the mount's aft end is
      // the pod's, 1.50. The core's ebay floor at 0.50 is not in this airframe.
      const r = estimateMotorRoom(withRing(type), 'pm')!;
      expect(r.lengthM).toBeCloseTo(0.445, 9);
      expect(r.limitedBy).toBe('Pod bulkhead');
    });
  }

  it('a pod mount runs to its own nose cone when nothing else is in the way', () => {
    // The chain STACKS inside the pod: the pod nose's aft end is at 0.97 + 0.08
    // = 1.05, not at the pod's start — 0.45 m of room, not 0.53 or less.
    const t = withRing('podset', true);
    const podTube1 = findIn(t, 'pt1');
    podTube1.children = [];
    const r = estimateMotorRoom(t, 'pm')!;
    expect(r.lengthM).toBeCloseTo(0.45, 9);
    expect(r.limitedBy).toBe('Pod nose');
  });

  it('a pod with no nose cone runs to its own front, never the core’s', () => {
    const t = withRing('podset', false, false);
    findIn(t, 'pt1').children = [];
    // The pod is 0.45 m long and aft-flush: it starts at 1.05.
    const r = estimateMotorRoom(t, 'pm')!;
    expect(r.lengthM).toBeCloseTo(0.45, 9);
    expect(r.limitedBy).toBe('the front of the pod');
  });

  it('the stage figure is the tightest mount’s OWN room — never a pod blocking the core', () => {
    // estimateMotorRoomForMounts is the stage figure. Asked for the core alone
    // it is the core's 1.00 m — nothing inside the pod cuts it down…
    const core = estimateMotorRoomForMounts(withRing('podset'), ['mt'])!;
    expect(core.lengthM).toBeCloseTo(1.00, 9);
    expect(core.limitedBy).toBe('Ebay floor');
    // …and asked for the core and the pod, as App asks for a stage holding
    // both, it is the pod's own 0.445 m to its own bulkhead: the one length
    // both mounts take. Before, both figures were wrong — the core stopped at
    // the pod's nose and the pod measured from the pod set's start.
    const both = estimateMotorRoomForMounts(withRing('podset'), ['mt', 'pm'])!;
    expect(both.lengthM).toBeCloseTo(0.445, 9);
    expect(both.limitedBy).toBe('Pod bulkhead');
  });
});

/**
 * AN AUTOMATIC TRANSITION RADIUS (audit 2026-09-22, row 371). A transition's
 * absent radius is AUTOMATIC in the kernel: the fore end takes the previous
 * chain member's aft radius and the aft end the next member's fore radius
 * (`Transition.getAutoForeRadius` / `getAutoAftRadius`). `narrowsForward` read
 * an absent radius as 0, so a reducer whose aft radius follows the wider tube
 * behind it was read as opening forward — measured 1.05 m where 0.60 m is true.
 */
describe('a transition with an automatic radius', () => {
  const reducer = (tr: Record<string, unknown>) => ({
    name: 'Auto',
    components: [{
      id: 's1', type: 'stage',
      children: [
        { id: 'up', type: 'bodytube', name: 'Upper', length: 0.40, outerRadius: 0.02 },
        { id: 'tr', type: 'transition', name: 'Reducer', length: 0.05, ...tr },
        {
          id: 'lo', type: 'bodytube', name: 'Lower', length: 0.60, outerRadius: 0.03,
          children: [{
            id: 'mt', type: 'innertube', name: 'MMT', length: 0.20, outerRadius: 0.02,
            position: { method: 'bottom', offset: 0 },
          }],
        },
      ],
    }],
  } as unknown as RocketTree);

  it('reads an automatic aft radius from the tube behind it — a reducer still stops the motor', () => {
    const r = estimateMotorRoom(reducer({ foreRadius: 0.02 }), 'mt')!;
    expect(r.lengthM).toBeCloseTo(0.60, 9);
    expect(r.limitedBy).toBe('Reducer');
  });

  it('reads an automatic fore radius from the tube in front of it', () => {
    // Fore automatic = the 20 mm upper tube, aft 30 mm: narrows going forward.
    expect(estimateMotorRoom(reducer({ aftRadius: 0.03 }), 'mt')!.limitedBy).toBe('Reducer');
    // Both automatic: 20 mm in front, 30 mm behind — still a reducer.
    expect(estimateMotorRoom(reducer({}), 'mt')!.lengthM).toBeCloseTo(0.60, 9);
  });

  it('does not stop at a transition that really opens forward, radii automatic', () => {
    // Swap the tubes: 30 mm in front, 20 mm behind. The fore radius is
    // automatic (30 mm); read as 0 it looked like a reducer and cut the room.
    const t = reducer({ aftRadius: 0.02 });
    const [up, , lo] = t.components[0]!.children!;
    up!['outerRadius'] = 0.03;
    lo!['outerRadius'] = 0.02;
    const r = estimateMotorRoom(t, 'mt')!;
    expect(r.lengthM).toBeCloseTo(1.05, 9);
    expect(r.limitedBy).toBe('the front of the airframe');
  });
});

/** The node with this id, for editing a fixture in place. */
function findIn(t: RocketTree, id: string): { children?: unknown[] } & Record<string, unknown> {
  const walk = (ns: readonly Record<string, unknown>[]): Record<string, unknown> | null => {
    for (const n of ns) {
      if (n['id'] === id) return n;
      const hit = walk((n['children'] as Record<string, unknown>[] | undefined) ?? []);
      if (hit) return hit;
    }
    return null;
  };
  return walk(t.components as unknown as Record<string, unknown>[])!;
}
