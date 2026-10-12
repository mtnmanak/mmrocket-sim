import { expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { layoutSchematic } from './schematicLayout.js';

it.each([0, 0.4])('S4b-2 opposite pod fins point outward with view roll %s', (roll) => {
  const tree: RocketTree = { components: [{ type: 'bodytube', id: 'core', length: 0.4, outerRadius: 0.025,
    children: [{ type: 'podset', id: 'pod', instanceCount: 2, radiusMethod: 'free', radiusOffset: 0.06,
      children: [{ type: 'bodytube', id: 'tube', length: 0.1, outerRadius: 0.01,
        children: [{ type: 'trapezoidfinset', id: 'fin', finCount: 1, rotation: 0,
          rootChord: 0.05, tipChord: 0.02, sweep: 0.01, height: 0.03 }] }] }] }] };
  const layout = layoutSchematic(tree, { scale: 1000, cy: 200, x0: 0, roll, idPrefix: 't' });
  const fins = layout.shapes.filter(s => s.tag === 'polygon' && s.key.endsWith(':fin0'));
  expect(fins).toHaveLength(2);
  const ys = fins.map(s => String(s.attrs['points']).split(' ').map(p => Number(p.split(',')[1])));
  expect(Math.min(...ys[0]!)).toBeCloseTo(200 - 100 * Math.cos(roll), 8);
  expect(Math.max(...ys[1]!)).toBeCloseTo(200 + 100 * Math.cos(roll), 8);
});
