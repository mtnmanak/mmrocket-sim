import { describe, expect, it } from 'vitest';
import { CLUSTER_OPTIONS, CLUSTER_POINTS, clusterCount, clusterOffsets } from './cluster.js';

/**
 * `tree/cluster.ts` had NO test file at all until 2026-09-21 — recorded as an
 * open gap in `docs/AUDIT.md`, and the reason a prototype-pollution-shaped
 * lookup survived in it while thirteen other file-keyed maps were hardened.
 * The pattern name comes straight out of an `.ork`'s
 * `<clusterconfiguration>`, so it is untrusted input.
 */
describe('cluster patterns', () => {
  it('counts the patterns the kernel knows', () => {
    expect(clusterCount('single')).toBe(1);
    expect(clusterCount('double')).toBe(2);
    expect(clusterCount('3-ring')).toBe(3);
    expect(clusterCount('9-grid')).toBe(9);
    expect(clusterCount(undefined)).toBe(1);
  });

  it('offsets a 3-ring onto a circle of the right separation', () => {
    const offs = clusterOffsets('3-ring', 0.01);
    expect(offs).toHaveLength(3);
    // Unit points are 1 apart at their closest; separation is 2*r*scale.
    for (const o of offs) expect(Math.hypot(o.y, o.z)).toBeCloseTo(0.02 / Math.sqrt(3), 12);
  });

  it('lists every pattern in the dropdown with its motor count', () => {
    expect(CLUSTER_OPTIONS).toHaveLength(Object.keys(CLUSTER_POINTS).length);
    expect(CLUSTER_OPTIONS[0]).toEqual(['single', 'Single']);
    expect(CLUSTER_OPTIONS.find(([n]) => n === '4-ring')![1]).toBe('4-ring (4 motors)');
  });

  /**
   * The bug this file was written for. On a plain object literal every one of
   * these names resolves to an inherited `Object.prototype` member, which is
   * NOT undefined, so both the `?? 'single'` and the `?? [0, 0]` fallbacks are
   * skipped: measured before the fix, `constructor` gave 0.5 motors and NaN
   * offsets, `toString` gave 0 motors and no offsets, `__proto__` gave NaN.
   */
  describe('a malformed name from a file falls back to a single mount', () => {
    const NAMES = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty',
      'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'bogus', ''];

    it.each(NAMES)('%j counts as one motor', (name) => {
      expect(clusterCount(name)).toBe(1);
    });

    it.each(NAMES)('%j offsets to the centreline only', (name) => {
      const offs = clusterOffsets(name, 0.012);
      expect(offs).toEqual([{ y: 0, z: 0 }]);
      for (const o of offs) {
        expect(Number.isFinite(o.y)).toBe(true);
        expect(Number.isFinite(o.z)).toBe(true);
      }
    });
  });
});
