import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { layoutSchematic } from './schematicLayout.js';
import { caliperDistances, schematicSnapTargets } from '../services/schematicCaliper.js';

// N044 round 8: independent analytic oracles for airframe and fin snap targets.
// Fin rotation and viewer roll turn the radial plane; circles retain their diameter.
const fixtures = [
  ...['bodytube', 'nosecone', 'transition'].map(type => ({ type, kind: 'chain' })),
  ...['trapezoidfinset', 'freeformfinset', 'ellipticalfinset', 'tubefinset'].map(type => ({ type, kind: 'fin' })),
];
const angles = [0, Math.PI / 3, Math.PI / 2, Math.PI];
const rolls = [0, Math.PI / 6, Math.PI / 2];
const cases = fixtures.flatMap(f => angles.flatMap(angle => rolls.map(roll => ({ ...f, angle, roll }))));

describe('N044 outer airframe and fin geometry projection', () => {
  it.each(cases)('$type at angle $angle and roll $roll retains physical stations', ({ type, kind, angle, roll }) => {
    const n = { id: 'subject', type, length: 0.05, outerRadius: 0.0022,
      foreRadius: type === 'nosecone' ? 0 : 0.012, aftRadius: 0.008, shape: 'conical',
      height: 0.03, rootChord: 0.05, tipChord: 0.02, sweep: 0.01,
      points: [[0, 0], [0.01, 0.03], [0.03, 0.03], [0.05, 0]],
      finCount: 3, rotation: angle,
      position: { method: 'top', offset: 0.1 },
    } as ComponentNode;
    const tree = { name: 'Geometry', components: kind === 'chain' ? [n] : [{ id: 'body', type: 'bodytube',
      length: 2, outerRadius: 0.02, children: [n] }] } as RocketTree;
    const before = JSON.stringify(tree);
    for (const walls of [false, true]) for (const scale of [126, 1000]) for (const measuring of [false, true]) {
      const layout = layoutSchematic(tree, { scale, x0: 50, cy: 100, roll, walls, measuring, idPrefix: 'geometry' });
      const drawn = layout.shapes.filter(s => s.part?.id === 'subject' && s.snap && !s.part.hit);
      const count = kind === 'fin' ? 3 : 1;
      for (let instance = 0; instance < count; instance++) {
        const a = angle + roll + (kind === 'fin' ? instance * 2 * Math.PI / 3 : 0);
        const p = Math.cos(a), near = Math.sin(a) >= 0;
        const start = kind === 'chain' ? 0 : 0.1;
        let expected: [number, number][];
        let hidden = false;
        if (kind === 'chain') {
          const fore = type === 'nosecone' ? 0 : type === 'bodytube' ? 0.0022 : 0.012;
          const aft = type === 'bodytube' ? 0.0022 : 0.008;
          expected = [[0, fore], [0, -fore], [0.05, aft], [0.05, -aft]];
        } else if (type === 'tubefinset') {
          const centre = 0.0222 * p;
          expected = [[start, centre - 0.0022], [start, centre + 0.0022],
            [start + 0.05, centre - 0.0022], [start + 0.05, centre + 0.0022]];
          hidden = roll === 0 && !near;
        } else if (kind === 'fin') {
          expected = type === 'ellipticalfinset' ? [[start, 0.02 * p], [start + 0.025, 0.05 * p], [start + 0.05, 0.02 * p]]
            : [[start, 0.02 * p], [start + 0.01, 0.05 * p], [start + 0.03, 0.05 * p], [start + 0.05, 0.02 * p]];
          hidden = roll === 0 && !near;
        } else throw new Error('Missing snap-target oracle');
        const shape = drawn.find(s => kind === 'fin' ? s.key.endsWith(`:${type === 'tubefinset' ? 'tube' : 'fin'}${instance}`) : true);
        const omitted = kind === 'fin' && roll === 0 && (type === 'tubefinset' ? 0.0222 * Math.abs(p) + 0.0022 <= 0.02 : 0.05 * Math.abs(p) <= 0.02);
        if (omitted) { expect(shape).toBeUndefined(); continue; }
        expect(shape, `${type} instance ${instance}`).toBeDefined();
        const raw = shape!.snap!.points.map(([x, y]) => ({ x, y }));
        for (const [x, y] of expected) {
          expect(raw.some(t => Math.hypot(t.x - x, t.y - y) < 1e-12), `${type} ${instance}: ${x},${y}`).toBe(true);
        }
        // No interior/end-centre stations may enter this outer-outline population.
        for (const point of raw) if (type === 'bodytube' || type === 'tubefinset') {
          expect(expected.some(([x, y]) => Math.hypot(point.x - x, point.y - y) < 1e-12)).toBe(true);
        }
        // Check measured extents, not just whether a few expected points exist among spurious targets.
        const span = (points: { x: number; y: number }[]) => caliperDistances(
          { x: Math.min(...points.map(t => t.x)), y: Math.min(...points.map(t => t.y)) },
          { x: Math.max(...points.map(t => t.x)), y: Math.max(...points.map(t => t.y)) });
        const want = span(expected.map(([x, y]) => ({ x, y }))), got = span(raw);
        expect(got.horizontal).toBeCloseTo(want.horizontal, 12);
        expect(got.vertical).toBeCloseTo(want.vertical, 12); // Analytic SI/trig rounding, no kernel baseline.
        const targets = schematicSnapTargets({ ...layout, shapes: [shape!] });
        for (const [x, y] of expected) {
          if (!hidden || Math.abs(y) >= 0.02) expect(targets.some(t => Math.hypot(t.x - x, t.y - y) < 1e-12)).toBe(true);
        }
        if (hidden) expect(targets.every(t => Math.abs(t.y) >= 0.02)).toBe(true);
      }
    }
    expect(JSON.stringify(tree)).toBe(before);
  });
});
