import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { describe, expect, it } from 'vitest';
import { ignitionDefaultFor } from './ignitionDefault.js';

/**
 * THE RULE THIS PINS, and the one it replaced.
 *
 * Until v0.134 an upper-stage motor was given electronics-timed ignition when
 * it was "high power" — over 80 N average thrust or 160 Ns. Eric struck that on
 * 2026-09-18: "It is NOT a high-power vs. low/mid-power question. The
 * differentiation is in the propellant of the motor, not its classification."
 *
 * The cases below are the four he named or implied, plus the two structural
 * ones the old rule also got wrong (a middle stage, and a strap-on).
 */

/** A stage carrying one motor mount, id `mount<n>`. */
const stage = (n: number): ComponentNode => ({
  id: `stage${n}`,
  type: 'stage',
  name: `Stage ${n}`,
  children: [{
    id: `tube${n}`,
    type: 'bodytube',
    name: 'Body',
    children: [{ id: `mount${n}`, type: 'innertube', name: 'Mount', motorMount: true }],
  }],
});

/** Stages are listed TOP FIRST, so the last one is the launch stage. */
const tree = (n: number): RocketTree => ({
  name: 'R',
  components: Array.from({ length: n }, (_, i) => stage(i)),
});

const ign = (t: RocketTree, mountId: string, propellant?: string) =>
  ignitionDefaultFor(t, { mountId, propellant });

describe('the ignition default keys off propellant, not power class', () => {
  it('lights a black powder sustainer off the charge below it', () => {
    // Eric's own counter-example to the old rule, in the small direction.
    expect(ign(tree(2), 'mount0', 'black powder')).toEqual({ event: 'automatic', delay: 0 });
  });

  it('needs an igniter for a composite sustainer, however small the motor', () => {
    // "MANY low and mid power motors that are composites still require
    // electronic ignition" — an AeroTech E is well under the old 80 N line.
    expect(ign(tree(2), 'mount0', 'Blue Thunder')).toEqual({ event: 'burnout', delay: 1 });
  });

  it('takes the igniter side when the propellant is not recorded', () => {
    // 42 catalogue rows and every imported .eng/.rse motor land here. The two
    // wrong answers do not cost the same: a wrongly-automatic composite flies a
    // burn the hardware cannot produce.
    expect(ign(tree(2), 'mount0')).toEqual({ event: 'burnout', delay: 1 });
    expect(ign(tree(2), 'mount0', '')).toEqual({ event: 'burnout', delay: 1 });
  });

  it('is tolerant of how the catalogue spells the propellant', () => {
    expect(ign(tree(2), 'mount0', 'Black Powder')).toEqual({ event: 'automatic', delay: 0 });
    expect(ign(tree(2), 'mount0', '  black powder ')).toEqual({ event: 'automatic', delay: 0 });
    expect(ign(tree(2), 'mount0', 'blackpowder')).toEqual({ event: 'automatic', delay: 0 });
  });
});

describe('which stages the rule applies to', () => {
  it('leaves the launch stage automatic whatever it burns', () => {
    // Index 1 of 2 is the bottom stage; it lights at launch.
    expect(ign(tree(2), 'mount1', 'Blue Thunder')).toEqual({ event: 'automatic', delay: 0 });
  });

  it('applies to a MIDDLE stage too, which the old rule never did', () => {
    // A three-stage rocket's middle stage is lit by the stage below exactly as
    // the sustainer is. The old test was `stIdx === 0` and skipped it.
    expect(ign(tree(3), 'mount1', 'Blue Thunder')).toEqual({ event: 'burnout', delay: 1 });
    expect(ign(tree(3), 'mount1', 'black powder')).toEqual({ event: 'automatic', delay: 0 });
  });

  it('leaves a single-stage rocket automatic', () => {
    expect(ign(tree(1), 'mount0', 'Blue Thunder')).toEqual({ event: 'automatic', delay: 0 });
  });

  /**
   * A strap-on is a LAUNCH stage whatever it hangs off — the kernel makes any
   * active parallel stage one (ParallelStage.isLaunchStage), so its motor
   * resolves to LAUNCH under AUTOMATIC. A burnout-keyed default there was
   * wrong before this change as well as after it.
   */
  it('leaves a motor inside a parallel stage automatic, even on an upper stage', () => {
    const t: RocketTree = {
      name: 'R',
      components: [
        {
          id: 'stage0',
          type: 'stage',
          name: 'Sustainer',
          children: [{
            id: 'tube0',
            type: 'bodytube',
            name: 'Body',
            children: [{
              id: 'para',
              type: 'parallelstage',
              name: 'Strap-on',
              children: [{ id: 'mountP', type: 'innertube', name: 'Mount', motorMount: true }],
            }],
          }],
        },
        stage(1),
      ],
    };
    expect(ign(t, 'mountP', 'Blue Thunder')).toEqual({ event: 'automatic', delay: 0 });
    // …while the sustainer's own mount in the same tree still follows the rule.
    expect(ign(t, 'tube0', 'Blue Thunder')).toEqual({ event: 'burnout', delay: 1 });
  });

  it('is automatic for a mount the tree does not hold', () => {
    expect(ign(tree(2), 'nosuch', 'Blue Thunder')).toEqual({ event: 'automatic', delay: 0 });
  });
});
