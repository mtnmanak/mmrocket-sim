import { expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { aftLayout } from './aftLayout.js';

it.each(['3-ring', '4-ring'])('S3b-1 instances the engine block in every %s tube', (cluster) => {
  const tree: RocketTree = { components: [{ id: 'b', type: 'bodytube', length: 0.3, outerRadius: 0.04,
    children: [{ id: 'm', type: 'innertube', outerRadius: 0.0095, length: 0.07, cluster,
      radialPosition: 0.003, radialDirection: 0.4,
      children: [{ id: 'block', name: 'Block', type: 'engineblock', length: 0.005, outerRadius: 0.009 }] }] }] };
  const layout = aftLayout(tree, 0.3);
  const tubes = layout.inner.filter(s => s.key === 'm' || s.key.startsWith('m#'));
  const blocks = layout.inner.filter(s => s.title === 'Block');
  expect(blocks.length).toBe(cluster === '3-ring' ? 3 : 4);
  expect(blocks.map(s => [s.y, s.z])).toEqual(tubes.map(s => [s.y, s.z]));
  expect(new Set(blocks.map(s => s.key)).size).toBe(blocks.length);
});
