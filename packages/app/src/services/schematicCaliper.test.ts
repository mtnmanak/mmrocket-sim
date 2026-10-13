import { describe, expect, it } from 'vitest';
import { caliperDistances, caliperReadout, schematicSnapTargets, snapCaliperPoint } from './schematicCaliper.js';
import { layoutSchematic } from '../tree/schematicLayout.js';
import type { RocketTree } from '@online-openrocket/engine';

describe('N044 projected caliper geometry', () => {
  it('reads absolute projected distances in mm and inches, including the diagonal', () => {
    const a = { x: 0.1, y: -0.02 }, b = { x: 0.13, y: 0.02 };
    const d = caliperDistances(a, b);
    expect(d.horizontal).toBeCloseTo(0.03, 12);
    expect(d.vertical).toBeCloseTo(0.04, 12);
    expect(d.straight).toBeCloseTo(0.05, 12);
    expect(caliperReadout(a, b, 'mm')).toBe('Horizontal 30 mm · Vertical 40 mm · Straight 50 mm');
    expect(caliperReadout(a, b, 'in')).toBe('Horizontal 1.181 in · Vertical 1.575 in · Straight 1.969 in');
    expect(caliperDistances(b, a)).toEqual(d);
  });

  it('snaps only within a screen-sized radius and keeps arbitrary points otherwise', () => {
    const target = { x: 0.1, y: 0.02 };
    expect(snapCaliperPoint({ x: 0.103, y: 0.02 }, [target], 0.004)).toEqual(target);
    expect(snapCaliperPoint({ x: 0.103, y: 0.02 }, [target], 0.001)).toEqual({ x: 0.103, y: 0.02 });
    expect(snapCaliperPoint({ x: 0, y: 0 }, [], 1)).toEqual({ x: 0, y: 0 });
  });

  it('takes tube edges and centreline stations from each drawn instance in SI', () => {
    const tree = { name: 'T', components: [{ id: 'b', type: 'bodytube', length: 0.2, outerRadius: 0.01 }] } as RocketTree;
    const ctx = { scale: 1000, x0: 50, cy: 100 };
    const targets = schematicSnapTargets(layoutSchematic(tree, { ...ctx, roll: 0, idPrefix: 't' }), ctx);
    for (const p of [{ x: 0, y: 0.01 }, { x: 0.2, y: -0.01 }, { x: 0.2, y: 0 }]) {
      expect(targets.some(t => Math.hypot(t.x - p.x, t.y - p.y) < 1e-12)).toBe(true);
    }
  });

  it('offers bore edges and rolled cluster vertices, rather than only a union bounding box', () => {
    const tree = { name: 'T', components: [{ id: 'b', type: 'bodytube', length: 0.2, outerRadius: 0.02, thickness: 0.002,
      children: [{ id: 'i', type: 'innertube', length: 0.1, outerRadius: 0.005, thickness: 0.001, cluster: '3-ring' }],
    }] } as RocketTree;
    const ctx = { scale: 1000, x0: 50, cy: 100 };
    const atRoll = (roll: number) => schematicSnapTargets(layoutSchematic(tree, { ...ctx, roll, walls: true, idPrefix: 't' }), ctx);
    expect(atRoll(0).some(p => Math.abs(p.x) < 1e-12 && Math.abs(p.y - 0.018) < 1e-12)).toBe(true);
    expect(atRoll(0.4)).not.toEqual(atRoll(0));
    expect(atRoll(0.4).filter(p => Math.abs(p.x - 0.1) < 1e-12).length).toBeGreaterThan(6);
  });
});
