import { expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { aftLayout } from './aftLayout.js';
import { layoutSchematic } from './schematicLayout.js';
import { buildPieces } from './pieces.js';
import { applyStageNozzles } from './treeModel.js';

it.each(['constructor', 'toString', '__proto__'])('preserves an unowned stage nozzle %s', id => {
  for (const type of ['stage', 'parallelstage'] as const) {
    const tree: RocketTree = { components: [{ type, id, nozzleExitDiameter: 0.02 }] };
    expect(applyStageNozzles(tree, {})).toBe(tree);
    expect(applyStageNozzles(tree, { [id]: 0.015 }).components[0]!.nozzleExitDiameter).toBe(0.015);
  }
});

for (const id of ['constructor', 'toString', 'valueOf', '__proto__']) {
  for (const type of ['bodytube', 'innertube'] as const) {
    const mount = { type, id, length: 0.1, outerRadius: 0.0095, motorMount: true };
    const tree: RocketTree = { components: [{ type: 'stage', children: type === 'bodytube' ? [mount] : [
      { type: 'bodytube', id: 'host', length: 0.3, outerRadius: 0.025, children: [mount] },
    ] }] };
    it.each(['aft', 'side', '3d'])(`does not draw an inherited motor on ${type} ${id}: %s`, view => {
      if (view === 'aft') { expect(aftLayout(tree, 0, {})).toEqual(aftLayout(tree, 0)); return; }
      const options = { scale: 100, cy: 100, x0: 10, roll: 0, idPrefix: 'test' };
      if (view === 'side') { expect(layoutSchematic(tree, { ...options, motors: {} })).toEqual(layoutSchematic(tree, options)); return; }
      const empty = buildPieces(tree);
      const mapped = buildPieces(tree, {});
      try { expect(mapped.pieces).toHaveLength(empty.pieces.length); }
      finally { for (const p of [...empty.pieces, ...mapped.pieces]) p.geometry.dispose(); }
    });
  }
}
