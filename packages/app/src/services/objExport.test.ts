import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { rocketToObj } from './objExport.js';

const tree: RocketTree = {
  name: 'ObjTest',
  components: [
    {
      type: 'stage', id: 's0', name: 'Sustainer',
      children: [
        { type: 'nosecone', id: 'n', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
        {
          type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
          children: [
            { type: 'trapezoidfinset', id: 'f', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003, position: { method: 'bottom', offset: 0 } },
          ],
        },
      ],
    },
  ],
};

describe('rocketToObj', () => {
  it('emits a meter-scale OBJ of the visible geometry', () => {
    const obj = rocketToObj(tree, 'ObjTest');
    expect(obj).toContain('# Units: METERS');
    expect(obj).toContain('# Overall length: 370.0 mm');
    // Vertices exist and stay within the rocket's envelope (+X axis, meters).
    const verts = obj.split('\n').filter((l) => l.startsWith('v '));
    expect(verts.length).toBeGreaterThan(100);
    const xs = verts.map((l) => Number(l.split(/\s+/)[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-0.001);
    expect(Math.max(...xs)).toBeLessThanOrEqual(0.371);
    // One object per piece: nose + body + 3 fins.
    expect((obj.match(/^o /gm) ?? []).length).toBe(5);
    expect(obj).toContain('f ');
  });

  it('refuses an empty design', () => {
    expect(() => rocketToObj({ components: [{ type: 'stage', children: [] }] } as RocketTree, 'X'))
      .toThrow(/Nothing to export/);
  });
});

/**
 * The rocket name goes into the `#` header, and a name from an imported file
 * or a share link can carry a raw newline (audit 2026-09-22). Every line after
 * it used to become a live OBJ record: "Goblin\nv 9 9 9\nf 1 2 3" added a
 * vertex and a face, and three's absolute face indices then pointed at the
 * wrong vertices.
 */
describe('rocketToObj — the header stays a header', () => {
  it('folds a line break in the name into the comment instead of injecting records', () => {
    const clean = rocketToObj(tree, 'Goblin');
    for (const br of ['\n', '\r\n', '\u2028', '\u2029']) {
      const obj = rocketToObj(tree, `Goblin${br}v 9 9 9${br}f 1 2 3`);
      expect(obj.split('\n')[0], JSON.stringify(br)).toBe('# MMRocket Sim — Goblin v 9 9 9 f 1 2 3');
      const records = (s: string) => s.split('\n').filter((l) => /^[vf] /.test(l)).length;
      expect(records(obj), JSON.stringify(br)).toBe(records(clean));
      expect(obj).not.toMatch(/[\r\u2028\u2029]/);
    }
  });
});
