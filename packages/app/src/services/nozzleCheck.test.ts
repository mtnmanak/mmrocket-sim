import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import { nozzleOversize, nozzleOversizeText } from './nozzleCheck.js';

/**
 * The casing-diameter plausibility check Eric ruled in on 2026-09-08, when the
 * nozzle exit diameter started buying thrust as well as trimming base drag.
 * The field takes 1-200 mm and nothing checked it for two months.
 */

/** `d` is the casing diameter in MILLIMETRES; the spec carries SI metres. */
const spec = (d: number): MotorSpec => ({
  designation: `M${d}`, diameter: d / 1000, length: 0.3,
  times: [0, 1, 2], thrusts: [0, 100, 0], masses: [0.5, 0.3, 0.2],
  cgX: 0.15, ejectionDelay: 5,
});

/**
 * A mounted motor. NOTE what is deliberately NOT here: `meta.motorCount`. The
 * check used to read it, and nothing in the app writes it onto a MountMotor —
 * the cluster count comes off the TREE node's `cluster` field
 * (2026-09-08, review), which is what the `clusterMm` argument below drives.
 */
const mm = (d: number): MountMotor => ({
  label: `M${d}`, spec: spec(d), meta: { label: `M${d}` },
  ignition: { event: 'automatic', delay: 0 },
});

/**
 * One stage, `nozzleMm` on it (0 = the key is absent), one mount inside.
 * `cluster` is the kernel pattern name written on the mount node, exactly as
 * the editor writes it — that is the production path for a cluster count.
 */
const design = (nozzleMm: number, cluster?: string, mountId = 'mount'): RocketTree => ({
  name: 'Test',
  components: [{
    type: 'stage', id: 'sus', name: 'Sustainer',
    ...(nozzleMm > 0 ? { nozzleExitDiameter: nozzleMm / 1000 } : {}),
    children: [{
      type: 'bodytube', id: 'bt', length: 0.5,
      children: [{
        type: 'innertube', id: mountId, length: 0.2,
        ...(cluster ? { cluster } : {}),
      } as ComponentNode],
    } as ComponentNode],
  } as ComponentNode],
});

const mmText = (m: number): string => `${Math.round(m * 100000) / 100} mm`;

describe('nozzleOversize', () => {
  it('fires when the typed exit is wider than the casing of the motor in that stage', () => {
    const out = nozzleOversize(design(60), [['mount', mm(29)]]);
    expect(out.length).toBe(1);
    expect(out[0]!.stageId).toBe('sus');
    expect(out[0]!.stageName).toBe('Sustainer');
    expect(out[0]!.exitDiameterM).toBeCloseTo(0.06, 9);
    expect(out[0]!.casingEquivalentM).toBeCloseTo(0.029, 9);
    expect(out[0]!.motorCount).toBe(1);
  });

  it('says nothing about a plausible exit — the common case must be silent', () => {
    // G record 2023's stored 0.45 in on a 29 mm F10: wrong per Chuck's notes,
    // but not something this check can know, and it must not cry wolf.
    expect(nozzleOversize(design(11.43), [['mount', mm(29)]])).toEqual([]);
    // MESOS's sustainer: 2.15 in out of a 98 mm M787.
    expect(nozzleOversize(design(54.6), [['mount', mm(98)]])).toEqual([]);
  });

  it('does not fire with no motor loaded — a nozzle with no motor is a design in progress', () => {
    expect(nozzleOversize(design(60), [])).toEqual([]);
  });

  it('does not fire with no nozzle typed, however small the motor', () => {
    expect(nozzleOversize(design(0), [['mount', mm(13)]])).toEqual([]);
  });

  it('is quiet at exactly the casing diameter — the two read as the same number on screen', () => {
    expect(nozzleOversize(design(29), [['mount', mm(29)]])).toEqual([]);
    // And half a tenth of a millimetre over is still the same number.
    expect(nozzleOversize(design(29.04), [['mount', mm(29)]])).toEqual([]);
    // A tenth over is not.
    expect(nozzleOversize(design(29.1), [['mount', mm(29)]]).length).toBe(1);
  });

  /**
   * THE CLUSTER CASE, and the reason the bound sums AREAS. The field is the
   * single equivalent nozzle with the exit areas added, so three 29 mm motors
   * each with a 20 mm exit are entered as 20 x sqrt(3) = 34.6 mm — wider than
   * any one casing and entirely correct. A per-casing comparison would fire on
   * every honest cluster the app has.
   */
  it('sums the casing areas of a cluster, so an honest 3-motor equivalent is silent', () => {
    const equivalent = 20 * Math.sqrt(3); // 34.64 mm
    expect(equivalent).toBeGreaterThan(29);
    expect(nozzleOversize(design(equivalent, '3-ring'), [['mount', mm(29)]])).toEqual([]);
    // The bound itself: sqrt(3) x 29 = 50.2 mm.
    const out = nozzleOversize(design(60, '3-ring'), [['mount', mm(29)]]);
    expect(out.length).toBe(1);
    expect(out[0]!.casingEquivalentM).toBeCloseTo(0.029 * Math.sqrt(3), 9);
    expect(out[0]!.motorCount).toBe(3);
  });

  /**
   * The regression this check shipped with and nearly shipped again: the count
   * came from `meta.motorCount`, which no production path writes, so a real
   * cluster fell back to 1 and got a permanent non-dismissible warning against
   * a single casing. Eric's own 4x29 mm on 18 mm exits is the shape.
   */
  it('reads the cluster count off the TREE, not off meta — a 4x29 mm on 18 mm exits is silent', () => {
    const equivalent = 18 * 2; // 4 exits of 18 mm summed by area = 36 mm
    // The bound: 2 x 29 = 58 mm, so the honest equivalent is well inside it…
    expect(nozzleOversize(design(equivalent, '4-ring'), [['mount', mm(29)]])).toEqual([]);
    // …while the same design WITHOUT the cluster field really is over its
    // single 29 mm casing, and still says so.
    expect(nozzleOversize(design(equivalent), [['mount', mm(29)]]).length).toBe(1);
    // And a meta.motorCount is not consulted even when one is present: the
    // tree says single, so the bound is one casing.
    const withStaleMeta: MountMotor = {
      ...mm(29), meta: { label: 'M29', motorCount: 4 },
    };
    expect(nozzleOversize(design(equivalent), [['mount', withStaleMeta]]).length).toBe(1);
  });

  it('adds up two different mounts in the same stage', () => {
    const t: RocketTree = {
      name: 'Two mounts',
      components: [{
        type: 'stage', id: 'sus', name: 'Sustainer', nozzleExitDiameter: 0.05,
        children: [{
          type: 'bodytube', id: 'bt', length: 0.5,
          children: [
            { type: 'innertube', id: 'a', length: 0.2 } as ComponentNode,
            { type: 'innertube', id: 'b', length: 0.2, cluster: 'double' } as ComponentNode,
          ],
        } as ComponentNode],
      } as ComponentNode],
    };
    // Mount b is a 'double', so it counts twice: sqrt(38² + 2x29²) = 55.9 mm,
    // over the typed 50, and the check is silent.
    expect(nozzleOversize(t, [['a', mm(38)], ['b', mm(29)]])).toEqual([]);
    // Drop b and the bound is a's 38 mm alone, under the typed 50, so it
    // fires — the second mount was doing real work.
    expect(nozzleOversize(t, [['a', mm(38)]]).length).toBe(1);
  });

  /** A booster's motor must never satisfy (or accuse) the sustainer's nozzle. */
  it('keeps stages apart', () => {
    const t: RocketTree = {
      name: 'Staged',
      components: [
        {
          type: 'stage', id: 'sus', name: 'Sustainer', nozzleExitDiameter: 0.06,
          children: [{ type: 'innertube', id: 'ms', length: 0.2 } as ComponentNode],
        } as ComponentNode,
        {
          type: 'stage', id: 'boo', name: 'Booster', nozzleExitDiameter: 0.06,
          children: [{ type: 'innertube', id: 'mb', length: 0.4 } as ComponentNode],
        } as ComponentNode,
      ],
    };
    // The booster's 98 mm motor is next door; the sustainer's 29 mm is not
    // excused by it, and the booster itself is fine.
    const out = nozzleOversize(t, [['ms', mm(29)], ['mb', mm(98)]]);
    expect(out.map((w) => w.stageId)).toEqual(['sus']);
  });

  it('one entry per bad stage, so a second cannot hide behind the first', () => {
    const t: RocketTree = {
      name: 'Staged',
      components: [
        {
          type: 'stage', id: 'sus', name: 'Sustainer', nozzleExitDiameter: 0.06,
          children: [{ type: 'innertube', id: 'ms', length: 0.2 } as ComponentNode],
        } as ComponentNode,
        {
          type: 'stage', id: 'boo', name: 'Booster', nozzleExitDiameter: 0.09,
          children: [{ type: 'innertube', id: 'mb', length: 0.4 } as ComponentNode],
        } as ComponentNode,
      ],
    };
    expect(nozzleOversize(t, [['ms', mm(29)], ['mb', mm(54)]]).map((w) => w.stageId))
      .toEqual(['sus', 'boo']);
  });

  it('skips a stale record whose mount the tree no longer has', () => {
    // stageIndexOf returns -1 for it; read as a stage index it would have
    // credited (or accused) whichever stage sorted there.
    expect(nozzleOversize(design(60), [['gone', mm(98)]])).toEqual([]);
  });

  it('ignores a motor with no usable casing diameter rather than reading it as zero', () => {
    const bad = { ...mm(29), spec: { ...spec(29), diameter: 0 } };
    expect(nozzleOversize(design(60), [['mount', bad]])).toEqual([]);
  });
});

describe('nozzleOversizeText', () => {
  it('names both numbers in the user’s own length unit and says what the value now costs', () => {
    const w = nozzleOversize(design(60), [['mount', mm(29)]])[0]!;
    const text = nozzleOversizeText(w, mmText);
    expect(text).toContain('Sustainer: the nozzle exit diameter is 60 mm, wider than the 29 mm casing');
    expect(text).toMatch(/raises thrust as the rocket climbs/);
    expect(text).toMatch(/Design tab/);
    // The formatter is the ONLY place units enter — hand it inches and the
    // sentence is in inches.
    const inches = nozzleOversizeText(w, (m) => `${(m / 0.0254).toFixed(2)} in`);
    expect(inches).toContain('is 2.36 in, wider than the 1.14 in casing');
  });

  it('says a cluster adds up, rather than naming a casing no single motor has', () => {
    const w = nozzleOversize(design(60, '3-ring'), [['mount', mm(29)]])[0]!;
    const text = nozzleOversizeText(w, mmText);
    expect(text).toContain('wider than the 50.23 mm its 3 motors add up to (exit areas summed');
    expect(text).not.toContain('casing of the motor');
  });
});
