import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import {
  angleGap, betweenFinAnglesOn, finAnglesOn, nearestAngle,
  railInterferenceWarnings, reducePi,
} from './mountAngle.js';
import { defaultParams } from './schema.js';

const D = (deg: number) => (deg * Math.PI) / 180;
const asDeg = (rad: number) => Math.round(((reducePi(rad) * 180) / Math.PI) * 1e6) / 1e6;

const body = (kids: Record<string, unknown>[]): ComponentNode => ({
  type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.027, thickness: 0.001,
  children: kids,
} as unknown as ComponentNode);

const tree = (kids: Record<string, unknown>[]): RocketTree => ({
  name: 'T', components: [{ type: 'stage', id: 's1', children: [body(kids)] }],
} as unknown as RocketTree);

const FINS3 = { type: 'trapezoidfinset', id: 'f1', finCount: 3, rootChord: 0.05, height: 0.04 };

describe('where the fins are', () => {
  it('places N fins evenly from the set rotation — the kernel formula', () => {
    expect(finAnglesOn(body([FINS3])).map(asDeg).sort((a, b) => a - b))
      .toEqual([-120, 0, 120]);
    expect(finAnglesOn(body([{ ...FINS3, finCount: 4, rotation: D(45) }])).map(asDeg).sort((a, b) => a - b))
      .toEqual([-135, -45, 45, 135]);
  });

  it('puts "between" exactly midway, which for 3 fins is 60 degrees off each', () => {
    const between = betweenFinAnglesOn(body([FINS3])).map(asDeg).sort((a, b) => a - b);
    expect(between).toEqual([-180, -60, 60]);
    // Every midpoint is the same distance from its two neighbours.
    for (const b of betweenFinAnglesOn(body([FINS3]))) {
      const gaps = finAnglesOn(body([FINS3])).map((f) => angleGap(f, b)).sort((x, y) => x - y);
      expect(gaps[0]).toBeCloseTo(gaps[1]!, 12);
    }
  });

  it('has no answer when the parent carries no fins', () => {
    expect(finAnglesOn(body([{ type: 'railbutton', id: 'r1' }]))).toHaveLength(0);
    expect(nearestAngle([], 0)).toBeNull();
  });

  it('snaps to the NEAREST target, not the first one', () => {
    const fins = finAnglesOn(body([FINS3]));
    expect(asDeg(nearestAngle(fins, D(100))!)).toBe(120);
    expect(asDeg(nearestAngle(fins, D(-100))!)).toBe(-120);
    // From 179 the fin at 120 is 59 away and the one at -120 is 61 — near the
    // boundary, but 120 wins. The point is that it does NOT pick 0 (179 away).
    expect(asDeg(nearestAngle(fins, D(179))!)).toBe(120);
    expect(asDeg(nearestAngle(betweenFinAnglesOn(body([FINS3])), D(50))!)).toBe(60);

    // The real wrap case: a 4-fin set has a fin at 180, and from -175 the
    // short way round is 5 degrees. Comparing raw numbers instead of the
    // reduced difference would make that look like 355 and pick -90.
    const four = finAnglesOn(body([{ ...FINS3, finCount: 4 }]));
    expect(Math.abs(asDeg(nearestAngle(four, D(-175))!))).toBe(180);
  });

  it('reads a tube fin set as 6 fins, its own default', () => {
    expect(finAnglesOn(body([{ type: 'tubefinset', id: 't1' }]))).toHaveLength(6);
  });
});

describe('rail interference', () => {
  const warn = (kids: Record<string, unknown>[]) => railInterferenceWarnings(tree(kids));

  it('flags a rail button sitting on a fin line', () => {
    const w = warn([FINS3, { type: 'railbutton', id: 'r1', name: 'Button', angleOffset: 0 }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('in line with a fin');
    expect(w[0]).toContain('fouls it');
  });

  it('says nothing when the button is between the fins — the correct build', () => {
    expect(warn([FINS3, { type: 'railbutton', id: 'r1', angleOffset: D(60) }])).toHaveLength(0);
  });

  it('flags NEAR misses too, and names the actual separation', () => {
    const w = warn([FINS3, { type: 'railbutton', id: 'r1', angleOffset: D(6) }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('6°');
    // …but not a deliberate offset well clear of the fin.
    expect(warn([FINS3, { type: 'railbutton', id: 'r1', angleOffset: D(25) }])).toHaveLength(0);
  });

  it('flags a camera shroud or lug sharing the rail line', () => {
    const w = warn([
      { type: 'railbutton', id: 'r1', name: 'Button', angleOffset: D(180) },
      { type: 'fairing', id: 'sh', name: 'GoPro', angleOffset: D(180) },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('GoPro');
  });

  it('flags two rail buttons that disagree, and accepts two that agree', () => {
    const disagree = warn([
      { type: 'railbutton', id: 'r1', angleOffset: D(180) },
      { type: 'railbutton', id: 'r2', angleOffset: D(90) },
    ]);
    expect(disagree.some((s) => s.includes('different angles'))).toBe(true);

    expect(warn([
      { type: 'railbutton', id: 'r1', angleOffset: D(180) },
      { type: 'railbutton', id: 'r2', angleOffset: D(180) },
    ])).toHaveLength(0);
  });

  it('says each thing once, however many buttons raise it', () => {
    const w = warn([
      FINS3,
      { type: 'railbutton', id: 'r1', angleOffset: 0 },
      { type: 'railbutton', id: 'r2', angleOffset: 0 },
    ]);
    expect(w).toHaveLength(1);
  });

  it('does not compare across frames: a fin inside a POD is not on the core airframe', () => {
    // The pod rotates its whole sub-chain, so its fins are not measured from
    // the core's zero. Comparing the raw numbers would invent a collision.
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [{
        type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.027, thickness: 0.001,
        children: [
          { type: 'railbutton', id: 'r1', angleOffset: 0 },
          { type: 'podset', id: 'p1', instanceCount: 2, angleOffset: D(90),
            children: [{ type: 'bodytube', id: 'pb', length: 0.1, outerRadius: 0.01,
              children: [FINS3] }] },
        ],
      }] }],
    } as unknown as RocketTree;
    expect(railInterferenceWarnings(t)).toHaveLength(0);
  });
});

describe('a freshly added rail button is not on a fin line', () => {
  it('defaults to the kernel angle (PI), not to 0 = fin 1', () => {
    // Until v0.088 both defaulted to an absent angle, read everywhere as 0 —
    // the top of the side view, and exactly where an unrotated fin set puts
    // its first fin.
    expect(defaultParams('railbutton')['angleOffset']).toBeCloseTo(Math.PI, 12);
    expect(defaultParams('launchlug')['angleOffset']).toBeCloseTo(Math.PI, 12);
    // And the check agrees: adding one to a 3-fin airframe raises nothing.
    const t = tree([FINS3, { type: 'railbutton', id: 'r1', ...defaultParams('railbutton') }]);
    expect(railInterferenceWarnings(t)).toHaveLength(0);
  });
});
