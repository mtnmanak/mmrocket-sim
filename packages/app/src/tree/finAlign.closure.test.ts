import { expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { autoAlignFinSets } from './finAlign.js';

it.each(['rounded', 'airfoil'])('budgets overlap work for many non-overlapping %s freeform fins', crossSection => {
  let reads = 0;
  const fins = Array.from({ length: 100 }, (_, i): ComponentNode => ({ type: 'freeformfinset', id: `f${i}`, crossSection,
    position: { method: 'top', offset: i }, get points() { reads++; return [[0, 0], [0.02, 0.03], [0.06, 0]]; } }));
  const result = autoAlignFinSets({ components: [{ type: 'stage', children: [{ type: 'bodytube', length: 100, children: fins }] }] });
  expect(result.changes).toEqual([]);
  expect(reads).toBeLessThan(1000);
});
