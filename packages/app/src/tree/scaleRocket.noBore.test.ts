import { expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { previewMounts, scaleRocket } from './scaleRocket.js';

it.each([0.0095, 0.01])('S4a-4 reports no bore for wall %s m without a lost-motor warning', (thickness) => {
  const tree: RocketTree = { components: [{ type: 'bodytube', id: 'b', outerRadius: 0.03, length: 0.4,
    children: [{ type: 'innertube', id: 'm', name: 'Mount', motorMount: true,
      outerRadius: 0.0095, thickness, length: 0.07 }] }] };
  const opts = { assignedMotorDiameters: { m: 0.018 } };
  expect(previewMounts(tree, 2, opts)[0]!.verdict).toBe('solid');
  const result = scaleRocket(tree, 2, opts);
  expect(result.notes.join(' ')).toContain('wall');
  expect(result.notes.join(' ')).toContain('no bore');
  expect(result.notes.join(' ')).not.toMatch(/nearest|no longer fits|Untick Solid/);
});
