import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { estimateMotorRoom, estimateMotorRoomForMounts, noBoreReason } from './motorRoom.js';

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
    // Both mounts at the TOP of the tube, stated: an inner tube with no
    // position flies flush with the bottom (position.ts positionOf), where
    // either motor could reach the front of the airframe.
    const top = { method: 'top', offset: 0 };
    const tree = {
      name: 'R',
      components: [{
        id: 's1', type: 'stage',
        children: [{
          id: 'b1', type: 'bodytube', length: 0.6, outerRadius: 0.05,
          children: [
            { id: 'm1', type: 'innertube', length: 0.30, outerRadius: 0.0145, position: top },
            { id: 'm2', type: 'innertube', length: 0.18, outerRadius: 0.0145, position: top },
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
 * A STOP HAS TO BE IN THIS MOTOR'S WAY (audit 2026-09-30). The search counted
 * every engine block in the mount's airframe, so a thrust ring inside a SHORTER
 * outboard tube beside the core mount stopped the core motor too: 0.175 m "to
 * engine block" on a 0.6 m airframe whose core has 0.6 m. That figure is the
 * core's Room for, what ⌾ Estimate writes into Max motor length, and what the
 * motor browser's "only motors that fit" filter and Batch read — so it hid
 * motors that fit, on a common high-power layout.
 *
 * A part inside a tube is confined to that tube's bore; a block or bulkhead
 * stops this motor only where its section covers part of the motor's.
 */
describe('a stop counts only where it is in this motor’s way', () => {
  /**
   * A 0.6 m airframe (48 mm bore) with a 0.30 m core mount on the axis and a
   * 0.18 m outboard mount 30 mm off it, both aft-flush. Each mount's bore is
   * 14 mm in radius, and the two tubes do not touch (30 mm apart, 29 mm of
   * tube between their centres).
   */
  const coreAndOutboard = (parts: {
    core?: Record<string, unknown>[];
    outboard?: Record<string, unknown>[];
    airframe?: Record<string, unknown>[];
  } = {}) => ({
    name: 'Core and outboard',
    components: [{
      id: 's1', type: 'stage',
      children: [{
        id: 'af', type: 'bodytube', name: 'Airframe', length: 0.6, outerRadius: 0.05, thickness: 0.002,
        children: [
          {
            id: 'core', type: 'innertube', name: 'Core MMT', length: 0.30, outerRadius: 0.0145, thickness: 0.0005,
            position: { method: 'bottom', offset: 0 }, children: parts.core ?? [],
          },
          {
            id: 'ob', type: 'innertube', name: 'Outboard MMT', length: 0.18, outerRadius: 0.0145, thickness: 0.0005,
            radialPosition: 0.03, radialDirection: 0,
            position: { method: 'bottom', offset: 0 }, children: parts.outboard ?? [],
          },
          ...(parts.airframe ?? []),
        ],
      }],
    }],
  } as unknown as RocketTree);

  /** A 5 mm engine block `offset` down from the front of whatever it sits in. */
  const block = (id: string, name: string, offset: number, thickness = 0.003) => ({
    id, type: 'engineblock', name, length: 0.005, thickness, position: { method: 'top', offset },
  });

  it('an engine block in the OUTBOARD mount does not stop the core motor — the audit case', () => {
    // The outboard block's aft face is at 0.42 + 0.005 = 0.425. The core's
    // motor never enters the outboard tube, so it runs the whole airframe.
    const tree = coreAndOutboard({ outboard: [block('obeb', 'Outboard thrust ring', 0)] });
    const core = estimateMotorRoom(tree, 'core')!;
    expect(core.lengthM, 'the outboard tube’s block stopped the core motor').toBeCloseTo(0.60, 9);
    expect(core.limitedBy).toBe('the front of the airframe');
    // …and the block still stops the motor it belongs to.
    const outboard = estimateMotorRoom(tree, 'ob')!;
    expect(outboard.lengthM).toBeCloseTo(0.175, 9);
    expect(outboard.limitedBy).toBe('Outboard thrust ring');
  });

  it('an engine block in the core mount still stops the core motor, and only that one', () => {
    // Its aft face is at 0.30 + 0.05 + 0.005 = 0.355: 0.245 m of room.
    const tree = coreAndOutboard({ core: [block('ceb', 'Core thrust ring', 0.05)] });
    const core = estimateMotorRoom(tree, 'core')!;
    expect(core.lengthM).toBeCloseTo(0.245, 9);
    expect(core.limitedBy).toBe('Core thrust ring');
    const outboard = estimateMotorRoom(tree, 'ob')!;
    expect(outboard.lengthM, 'the core tube’s block stopped the outboard motor').toBeCloseTo(0.60, 9);
    expect(outboard.limitedBy).toBe('the front of the airframe');
  });

  it('a ring on the airframe stops only the motors its section reaches', () => {
    // Hung on the airframe, the kernel sizes a block to the airframe's 48 mm
    // bore and makes it a ring `thickness` deep — here 12 mm, so its hole is
    // 36 mm in radius. The core motor (14 mm, on the axis) passes through it;
    // the outboard motor reaches 30 + 14 = 44 mm off the axis and hits it.
    // Its aft face is at 0.105.
    const tree = coreAndOutboard({ airframe: [block('ring', 'Forward ring', 0.1, 0.012)] });
    const core = estimateMotorRoom(tree, 'core')!;
    expect(core.lengthM, 'a motor that fits through the ring’s hole was stopped by it').toBeCloseTo(0.60, 9);
    expect(core.limitedBy).toBe('the front of the airframe');
    const outboard = estimateMotorRoom(tree, 'ob')!;
    expect(outboard.lengthM).toBeCloseTo(0.495, 9);
    expect(outboard.limitedBy).toBe('Forward ring');
  });

  it('a block on the airframe deep enough to cover the axis stops the core motor', () => {
    const tree = coreAndOutboard({ airframe: [block('plate', 'Thrust plate', 0.1, 0.048)] });
    const core = estimateMotorRoom(tree, 'core')!;
    expect(core.lengthM).toBeCloseTo(0.495, 9);
    expect(core.limitedBy).toBe('Thrust plate');
  });

  it('a bulkhead on the airframe still stops every motor in it', () => {
    const tree = coreAndOutboard({
      airframe: [{ id: 'bh', type: 'bulkhead', name: 'Ebay floor', length: 0.005, position: { method: 'top', offset: 0.1 } }],
    });
    for (const id of ['core', 'ob']) {
      const r = estimateMotorRoom(tree, id)!;
      expect(r.lengthM, id).toBeCloseTo(0.495, 9);
      expect(r.limitedBy, id).toBe('Ebay floor');
    }
  });

  /**
   * A BULKHEAD WITH A HOLE (format audit row 26). A `.rkt` bulkhead the file
   * gives a hole — an eyebolt's, a baffle's — opens as a centering ring with
   * that bore, so it weighs what RockSim weighs, and carries `holedBulkhead`
   * (rocksimFile.ts). It is still the wall it was: read as a plain ring, LifeProof
   * Rocket Upward.rkt's aft e-bay bulkhead, with a 6.35 mm eyebolt hole, let
   * the estimate run on to the nose cone, 2.397 m of room where 0.994 m is true.
   * Its hole counts as an engine block's does, so one wide enough for a motor
   * does not stop that motor.
   */
  it('a holed bulkhead stops the motors its hole is too small for, and only those', () => {
    const holed = (innerRadius: number, extra: Record<string, unknown> = { holedBulkhead: true }) => ({
      id: 'hb', type: 'centeringring', name: 'Aft e-bay bulkhead', length: 0.005, outerRadius: 0.048, innerRadius,
      position: { method: 'top', offset: 0.1 }, ...extra,
    });
    // An eyebolt's 6.35 mm hole: both 28 mm motors hit the plate.
    const eyebolt = coreAndOutboard({ airframe: [holed(0.003175)] });
    for (const id of ['core', 'ob']) {
      const r = estimateMotorRoom(eyebolt, id)!;
      expect(r.lengthM, `${id}: a bulkhead with an eyebolt hole let the motor through`).toBeCloseTo(0.495, 9);
      expect(r.limitedBy, id).toBe('Aft e-bay bulkhead');
    }
    // A 40 mm hole: the core motor (14 mm, on the axis) passes through it; the
    // outboard one reaches 30 + 14 = 44 mm off the axis and hits the plate.
    const wide = coreAndOutboard({ airframe: [holed(0.02)] });
    const core = estimateMotorRoom(wide, 'core')!;
    expect(core.lengthM, 'a motor that fits through the hole was stopped by it').toBeCloseTo(0.60, 9);
    expect(core.limitedBy).toBe('the front of the airframe');
    expect(estimateMotorRoom(wide, 'ob')!.lengthM).toBeCloseTo(0.495, 9);
    // A centering ring that never was a bulkhead is still not a stop, however
    // small its bore (owner ruling 2026-09-01b; motorRoom.ts).
    const ring = coreAndOutboard({ airframe: [holed(0.003175, {})] });
    for (const id of ['core', 'ob']) expect(estimateMotorRoom(ring, id)!.lengthM, id).toBeCloseTo(0.60, 9);
  });

  it('a block inside a tube IN LINE ahead of the mount still stops it — the section decides, not the parent', () => {
    // A second tube on the axis, ahead of the core mount: the core's motor
    // leaves its own tube at 0.30 and runs on into this one, whose block has
    // its aft face at 0.155 — 0.445 m of room. Counting only the mount's own
    // blocks would have run the motor straight through it.
    const tree = coreAndOutboard({
      airframe: [{
        id: 'ext', type: 'innertube', name: 'Extension', length: 0.10, outerRadius: 0.0145, thickness: 0.0005,
        position: { method: 'top', offset: 0.15 },
        children: [{ id: 'exteb', type: 'engineblock', name: 'Extension block', length: 0.005, position: { method: 'top', offset: 0 } }],
      }],
    });
    const core = estimateMotorRoom(tree, 'core')!;
    expect(core.lengthM).toBeCloseTo(0.445, 9);
    expect(core.limitedBy).toBe('Extension block');
    // The outboard tube is beside both, so neither block is in its way.
    expect(estimateMotorRoom(tree, 'ob')!.lengthM).toBeCloseTo(0.60, 9);
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

/**
 * A SOLID minimum-diameter mount (Solid (filled)) has no bore — the kernel's
 * BodyTube.getMotorMountDiameter is 0 — so no motor goes in it and there is no
 * room to estimate. Measured through the wall it states it had a 28 mm motor
 * section; with no bore at all, a section of radius 0 slipped past a bulkhead
 * on the axis and the estimate ran on to the nose cone.
 */
describe('a solid mount has no room for a motor', () => {
  const rocket = (filled: boolean) => ({
    name: 'Rod',
    components: [{
      id: 's1', type: 'stage',
      children: [
        { id: 'nc', type: 'nosecone', name: 'Nose cone', length: 0.10, aftRadius: 0.015 },
        {
          id: 'fw', type: 'bodytube', name: 'Payload', length: 0.30, outerRadius: 0.015, thickness: 0.001,
          children: [{ id: 'bh', type: 'bulkhead', name: 'Floor', length: 0.005, position: { method: 'bottom', offset: 0 } }],
        },
        {
          id: 'mm', type: 'bodytube', name: 'Mount', length: 0.30, outerRadius: 0.015, thickness: 0.001,
          motorMount: true, ...(filled ? { filled: true } : {}),
        },
      ],
    }],
  } as unknown as RocketTree);

  it('hollow, the motor runs forward to the bulkhead ahead', () => {
    expect(estimateMotorRoom(rocket(false), 'mm')).toMatchObject({ lengthM: expect.closeTo(0.30, 9), limitedBy: 'Floor' });
  });

  it('solid, there is none', () => {
    expect(estimateMotorRoom(rocket(true), 'mm')).toBeNull();
  });

  it('and the field is told why: Solid (filled), or a wall that fills the tube', () => {
    // Both give no room, and the Max motor length field blamed the mount's
    // length, position and overhang for it.
    const mount = (extra: Record<string, unknown>) => ({
      id: 'mm', type: 'bodytube', length: 0.3, outerRadius: 0.015, thickness: 0.001, motorMount: true, ...extra,
    } as ComponentNode);
    expect(noBoreReason(mount({}))).toBeNull();
    expect(noBoreReason(mount({ filled: true }))).toBe('solid');
    expect(noBoreReason(mount({ thickness: 0.015 }))).toBe('wall');
    expect(noBoreReason({ ...mount({ thickness: 0.016 }), type: 'innertube' } as ComponentNode)).toBe('wall');
    // A case airframe's bore is its outside, whatever else it says.
    expect(noBoreReason(mount({ filled: true, caseAirframe: true }))).toBeNull();
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
