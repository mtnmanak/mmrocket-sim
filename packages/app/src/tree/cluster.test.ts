import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * THE TRANSCRIPTION, PINNED AGAINST THE KERNEL'S OWN SOURCE (audit 2026-09-22,
 * row 481). `CLUSTER_POINTS` is typed out by hand from
 * `ClusterConfiguration.java`, and nothing compared the two: a slipped sign in
 * one coordinate would draw, export and count a cluster the kernel does not
 * fly. This reads the carved Java file (committed under engine-java/src/carved,
 * so CI has it), evaluates every `new ClusterConfiguration("name", …)` with the
 * file's own SQRT2/SQRT3/R5, and requires the same patterns, in the same
 * (dropdown) order, with the same coordinates.
 */
describe('CLUSTER_POINTS matches ClusterConfiguration.java', () => {
  const javaPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'engine-java', 'src',
    'carved', 'java', 'info', 'openrocket', 'core', 'rocketcomponent', 'ClusterConfiguration.java');
  const java = readFileSync(javaPath, 'utf8');
  const constant = (name: string): string => {
    const m = new RegExp(`static final double ${name} = ([^;]+);`).exec(java);
    if (!m) throw new Error(`no ${name} in ClusterConfiguration.java`);
    return m[1]!;
  };
  /**
   * The Java argument lists are plain arithmetic on numeric literals, the
   * three constants and `Math.sin`/`Math.cos`/`Math.PI` — the same syntax in
   * JavaScript — so they are evaluated as written rather than re-typed.
   */
  const evaluate = (expr: string, scope: Record<string, number>): number[] => {
    if (!/^[\s\d.eE+\-*/(),A-Za-z0-9_]*$/.test(expr)) throw new Error(`unexpected text: ${expr}`);
    const names = Object.keys(scope);
    // The kernel's own numeric literals, read from a committed source file and
    // character-checked above — never user or file input.
    // eslint-disable-next-line no-new-func -- evaluates the carved Java source's own constant expressions, as written; see above
    const fn = new Function(...names, 'Math', `return [${expr}];`) as (...a: unknown[]) => number[];
    return fn(...names.map((n) => scope[n]), Math);
  };
  const SQRT2 = evaluate(constant('SQRT2'), {})[0]!;
  const SQRT3 = evaluate(constant('SQRT3'), {})[0]!;
  const R5 = evaluate(constant('R5'), {})[0]!;
  /** Every `new ClusterConfiguration("name", args…)` in file order, args evaluated. */
  const kernel: [string, number[]][] = [];
  const opener = /new ClusterConfiguration\("([^"]+)",/g;
  for (let m = opener.exec(java); m; m = opener.exec(java)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; depth > 0; i++) {
      if (java[i] === '(') depth++;
      else if (java[i] === ')') depth--;
    }
    kernel.push([m[1]!, evaluate(java.slice(start, i - 1), { SQRT2, SQRT3, R5 })]);
  }
  // SINGLE is declared on its own and then listed first in CONFIGURATIONS.
  const configurations = kernel.slice(1);

  it('finds the kernel patterns it is checking', () => {
    expect(kernel[0]![0]).toBe('single');
    expect(configurations[0]![0]).toBe('double');
    expect(configurations.length).toBe(13);
  });

  it('has the same patterns, in the kernel order the dropdown promises', () => {
    expect(Object.keys(CLUSTER_POINTS)).toEqual(['single', ...configurations.map(([n]) => n)]);
  });

  it('has the same coordinates, point for point', () => {
    for (const [name, pts] of kernel) {
      const mine = CLUSTER_POINTS[name]!;
      expect(mine.length, name).toBe(pts.length);
      pts.forEach((v, i) => expect(mine[i], `${name}[${i}]`).toBeCloseTo(v, 14));
    }
  });

  /**
   * The header used to say "closest tube centers are distance 1 apart" — the
   * kernel's own javadoc says so too — and two patterns disagree. Measured off
   * the kernel's coordinates, not the app's.
   */
  it('has its closest centres 1 apart except the two nine-tube patterns', () => {
    const closest = (pts: number[]): number => {
      let best = Infinity;
      for (let a = 0; a < pts.length; a += 2) {
        for (let b = a + 2; b < pts.length; b += 2) {
          best = Math.min(best, Math.hypot(pts[a]! - pts[b]!, pts[a + 1]! - pts[b + 1]!));
        }
      }
      return best;
    };
    for (const [name, pts] of configurations) {
      const d = closest(pts);
      if (name === '9-grid') expect(d, name).toBeCloseTo(1.4, 12);
      else if (name === '9-star') expect(d, name).toBeCloseTo(2 * 1.4 * Math.sin(Math.PI / 8), 12); // 1.0715
      else expect(d, name).toBeCloseTo(1, 12);
    }
  });
});

/**
 * THE ROTATION IS THE KERNEL'S (audit 2026-09-22, row 358):
 * `InnerTube.getClusterPoints` → `ClusterConfiguration.getPoints(rotation −
 * radialDirection)`, which turns the pattern by MINUS its argument. This used
 * to turn it by plus, so a rotated 3-ring was drawn and exported on the fin
 * lines the kernel puts it between.
 */
describe('clusterOffsets — rotation as the kernel applies it', () => {
  const degrees = (offs: { y: number; z: number }[]): number[] => offs
    .map((o) => ((Math.atan2(o.z, o.y) * 180) / Math.PI + 360) % 360)
    .sort((a, b) => a - b);

  it('puts a 3-ring rotated 30° at 60°/180°/300°, between a three-fin set’s fins', () => {
    const got = degrees(clusterOffsets('3-ring', 0.01, 1, Math.PI / 6));
    expect(got[0]).toBeCloseTo(60, 9);
    expect(got[1]).toBeCloseTo(180, 9);
    expect(got[2]).toBeCloseTo(300, 9);
  });

  it('is getPoints(rotation) scaled by 2·r·scale, for every pattern and several rotations', () => {
    for (const name of Object.keys(CLUSTER_POINTS)) {
      const pts = CLUSTER_POINTS[name]!;
      for (const rot of [0, 0.3, -1.1, Math.PI / 6, 2.5]) {
        const sep = 2 * 0.012 * 1.3;
        const offs = clusterOffsets(name, 0.012, 1.3, rot);
        for (let i = 0; i < pts.length / 2; i++) {
          const x = pts[2 * i]!;
          const y = pts[2 * i + 1]!;
          // ClusterConfiguration.getPoints(rotation), verbatim.
          expect(offs[i]!.y).toBeCloseTo((x * Math.cos(rot) + y * Math.sin(rot)) * sep, 14);
          expect(offs[i]!.z).toBeCloseTo((-x * Math.sin(rot) + y * Math.cos(rot)) * sep, 14);
        }
      }
    }
  });

  it('turns the pattern by the tube’s radial direction too, as getClusterPoints does', () => {
    // getPoints(clusterRotation − radialDirection): a direction of 30° with no
    // rotation of its own is the same turn as a rotation of −30°.
    const a = clusterOffsets('3-ring', 0.01, 1, 0, { radialDirection: Math.PI / 6 });
    const b = clusterOffsets('3-ring', 0.01, 1, -Math.PI / 6);
    a.forEach((o, i) => {
      expect(o.y).toBeCloseTo(b[i]!.y, 14);
      expect(o.z).toBeCloseTo(b[i]!.z, 14);
    });
  });

  it('turns WITH a view’s roll, the way every other part in that view turns', () => {
    // A roll of +40° moves a part at θ to θ + 40°; the cluster must follow,
    // where adding the roll to the rotation would have turned it by −40°.
    const still = degrees(clusterOffsets('3-ring', 0.01, 1, Math.PI / 6));
    const rolled = degrees(clusterOffsets('3-ring', 0.01, 1, Math.PI / 6, { viewRoll: (40 * Math.PI) / 180 }));
    const want = still.map((d) => (d + 40) % 360).sort((a, b) => a - b);
    rolled.forEach((d, i) => expect(d).toBeCloseTo(want[i]!, 9));
  });
});
