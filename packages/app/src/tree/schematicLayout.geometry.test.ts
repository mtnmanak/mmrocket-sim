import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { layoutSchematic } from './schematicLayout.js';
import { caliperDistances, schematicSnapTargets } from '../services/schematicCaliper.js';

// N044: independent analytic oracles for every type drawn by the schematic.
// Clock angle means rotation for fins, radialDirection for internal offsets,
// and angleOffset for surface parts/assemblies. Circles retain their diameter.
const fixtures: { type: string; kind: string; cluster?: string; conformal?: boolean }[] = [
  ...['bodytube', 'nosecone', 'transition'].map(type => ({ type, kind: 'chain' })),
  ...['innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock',
    'masscomponent', 'parachute', 'streamer', 'shockcord'].map(type => ({ type, kind: 'internal' })),
  { type: 'launchlug', kind: 'lug' }, { type: 'railbutton', kind: 'button' },
  ...['trapezoidfinset', 'freeformfinset', 'ellipticalfinset', 'tubefinset'].map(type => ({ type, kind: 'fin' })),
  ...['podset', 'parallelstage'].map(type => ({ type, kind: 'pod' })),
  { type: 'fairing', kind: 'surface' }, { type: 'protuberance', kind: 'surface' },
  { type: 'fairing', kind: 'surface', conformal: false },
  { type: 'innertube', kind: 'internal', cluster: 'double' },
];
const angles = [0, Math.PI / 3, Math.PI / 2, Math.PI];
const rolls = [0, Math.PI / 6, Math.PI / 2];
const cases = fixtures.flatMap(f => angles.flatMap(angle => rolls.map(roll => ({ ...f, angle, roll }))));

describe('N044 true geometry projection for every drawn component', () => {
  it.each(cases)('$type at angle $angle and roll $roll (cluster $cluster, conformal $conformal) retains physical stations', ({ type, kind, angle, roll, cluster, conformal }) => {
    const n = { id: 'subject', type, length: 0.05, packedLength: 0.05,
      outerRadius: 0.0022, radius: 0.0022, packedRadius: 0.0022,
      foreRadius: type === 'nosecone' ? 0 : 0.012, aftRadius: 0.008, shape: 'conical',
      outerDiameter: 0.0044, totalHeight: 0.006, baseHeight: 0.001, flangeHeight: 0.001,
      height: 0.03, width: 0.01, rootChord: 0.05, tipChord: 0.02, sweep: 0.01,
      points: [[0, 0], [0.01, 0.03], [0.03, 0.03], [0.05, 0]],
      finCount: 3, rotation: angle, angleOffset: angle, radialDirection: angle, radialPosition: 0.01,
      instanceCount: 2, instanceSeparation: 0.08, radiusMethod: 'free', radiusOffset: 0.06,
      position: { method: 'top', offset: 0.1 },
      cluster, conformal,
      ...(kind === 'pod' ? { children: [{ id: 'podbody', type: 'bodytube', length: 0.05, outerRadius: 0.0022 }] } : {}),
    } as ComponentNode;
    const tree = { name: 'Geometry', components: kind === 'chain' ? [n] : [{ id: 'body', type: 'bodytube',
      length: 2, outerRadius: 0.02, children: [n] }] } as RocketTree;
    const before = JSON.stringify(tree);
    for (const walls of [false, true]) for (const scale of [126, 1000]) for (const measuring of [false, true]) {
      const layout = layoutSchematic(tree, { scale, x0: 50, cy: 100, roll, walls, measuring, idPrefix: 'geometry' });
      const drawn = layout.shapes.filter(s => s.part?.id === (kind === 'pod' ? 'podbody' : 'subject') && s.snap && !s.part.hit);
      const count = kind === 'fin' ? 3 : cluster || ['lug', 'button', 'pod'].includes(kind) ? 2 : 1;
      for (let instance = 0; instance < count; instance++) {
        const a = angle + roll + (kind === 'fin' ? instance * 2 * Math.PI / 3 : kind === 'pod' ? instance * Math.PI : 0);
        const p = Math.cos(a), near = Math.sin(a) >= 0;
        const start = kind === 'chain' ? 0 : 0.1 + (['lug', 'button'].includes(kind) ? instance * 0.08 : 0);
        let expected: [number, number][];
        let hidden = false;
        if (kind === 'chain') {
          const fore = type === 'nosecone' ? 0 : type === 'bodytube' ? 0.0022 : 0.012;
          const aft = type === 'bodytube' ? 0.0022 : 0.008;
          expected = [[0, fore], [0, -fore], [0.05, aft], [0.05, -aft]];
        } else if (kind === 'internal' || kind === 'pod' || kind === 'lug' || type === 'tubefinset') {
          const centre = kind === 'pod' ? 0.06 * p : kind === 'lug' || type === 'tubefinset' ? 0.0222 * p
            : ['innertube', 'masscomponent', 'parachute', 'streamer', 'shockcord'].includes(type)
              ? (0.01 + (cluster ? (instance === 0 ? -0.0022 : 0.0022) : 0)) * p : 0;
          expected = [[start, centre - 0.0022], [start, centre + 0.0022],
            [start + 0.05, centre - 0.0022], [start + 0.05, centre + 0.0022]];
          hidden = kind === 'lug' ? !near : type === 'tubefinset' && roll === 0 && !near;
        } else if (kind === 'button') {
          // Axis radial: end disks project as ellipses. Tangential radius contributes |sin(a)|.
          const ys = [0.02 * p - 0.0022 * Math.abs(Math.sin(a)), 0.02 * p + 0.0022 * Math.abs(Math.sin(a)),
            0.026 * p - 0.0022 * Math.abs(Math.sin(a)), 0.026 * p + 0.0022 * Math.abs(Math.sin(a))];
          expected = [[start, Math.min(...ys)], [start, Math.max(...ys)],
            [start - 0.0022, 0.02 * p], [start + 0.0022, 0.02 * p]];
          hidden = !near;
        } else if (kind === 'fin') {
          expected = type === 'ellipticalfinset' ? [[start, 0.02 * p], [start + 0.025, 0.05 * p], [start + 0.05, 0.02 * p]]
            : [[start, 0.02 * p], [start + 0.01, 0.05 * p], [start + 0.03, 0.05 * p], [start + 0.05, 0.02 * p]];
          hidden = roll === 0 && !near;
        } else {
          // A shroud's curved underside and a bump's flat bottom have width
          // in depth. Their corner/arc stations rotate, not just their height.
          const base = type === 'fairing' && conformal !== false ? Math.sqrt(0.02 ** 2 - 0.005 ** 2) : 0.02;
          const widthProjection = 0.005 * Math.sin(a);
          expected = [start, start + 0.05].flatMap(x => [[x, base * p - widthProjection],
            [x, base * p + widthProjection], [x, 0.02 * p]] as [number, number][]);
          expected.push([start + 0.025, 0.05 * p - widthProjection], [start + 0.025, 0.05 * p + widthProjection]);
          if (type === 'protuberance') for (const x of [start, start + 0.05]) {
            expected.push([x, 0.05 * p - widthProjection], [x, 0.05 * p + widthProjection]);
          }
          if (type === 'fairing' && conformal !== false) {
            const reach = Math.asin(0.005 / 0.02);
            for (let k = -2; k <= 3; k++) {
              const phi = k * Math.PI - a;
              if (Math.abs(phi) <= reach) for (const x of [start, start + 0.05]) {
                expected.push([x, 0.02 * Math.cos(a + phi)]);
              }
            }
          }
          hidden = !near;
        }
        const shape = drawn.find(s => kind === 'fin' ? s.key.endsWith(`:${type === 'tubefinset' ? 'tube' : 'fin'}${instance}`)
          : ['lug', 'button'].includes(kind) ? s.key.endsWith(`:${kind}${instance}`)
            : kind === 'pod' ? s.key.includes(`#${instance}/`) : cluster ? s.key.endsWith(`:inner${instance}`) : true);
        const omitted = kind === 'fin' && roll === 0 && (type === 'tubefinset' ? 0.0222 * Math.abs(p) + 0.0022 <= 0.02 : 0.05 * Math.abs(p) <= 0.02);
        if (omitted) { expect(shape).toBeUndefined(); continue; }
        expect(shape, `${type} instance ${instance}`).toBeDefined();
        const raw = shape!.snap!.points.map(([x, y]) => ({ x, y }));
        for (const [x, y] of expected) {
          expect(raw.some(t => Math.hypot(t.x - x, t.y - y) < 1e-12), `${type} ${instance}: ${x},${y}`).toBe(true);
        }
        if (kind === 'surface') for (const point of raw) {
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
