import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { layoutSchematic } from './schematicLayout.js';
import { aftLayout } from './aftLayout.js';
import { buildPieces } from './pieces.js';
import { applyStageNozzles } from './treeModel.js';

it.each(['toString', 'constructor', 'valueOf'])('keeps an unrelated stage nozzle on reserved id %s', id => {
  for (const nozzleExitDiameter of [0, 0.02]) {
    const tree: RocketTree = { components: [{ type: 'stage', id, nozzleExitDiameter }, { type: 'stage', id: 'other' }] };
    const changed = applyStageNozzles(tree, { other: 0.03 });
    expect(changed.components[0]?.nozzleExitDiameter).toBe(nozzleExitDiameter);
    expect(changed.components[1]?.nozzleExitDiameter).toBe(0.03);
  }
});

describe('empty motor maps in every view', () => {
  it.each(['side', 'aft', '3D'].flatMap(view => ['toString', 'constructor', '__proto__'].map(id => [view, id])))('does not draw an inherited motor in %s on %s', (view, id) => {
    for (const minimumDiameter of [true, false]) {
      const mount = { type: minimumDiameter ? 'bodytube' : 'innertube', id, motorMount: true,
        length: 0.15, outerRadius: 0.01 };
      const tree = { components: [{ type: 'stage', id: 's', children: minimumDiameter ? [mount]
        : [{ type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.02, children: [mount] }] }] } as RocketTree;
      if (view === 'side') expect(layoutSchematic(tree, { scale: 100, roll: 0, cy: 0, x0: 0, idPrefix: 'test', motors: {} }).shapes.filter(s => s.key.includes(':motor'))).toEqual([]);
      if (view === 'aft') expect(aftLayout(tree, 0, {}).inner.filter(s => s.title === 'Motor')).toEqual([]);
      if (view === '3D') {
        const built = buildPieces(tree, {});
        try { expect(built.pieces.filter(p => p.key.startsWith('motor'))).toEqual([]); }
        finally { for (const piece of built.pieces) piece.geometry.dispose(); }
      }
    }
  });
});
