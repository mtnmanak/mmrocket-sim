import { expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { buildPieces } from './pieces.js';

it.each(['rounded', 'airfoil'])('S4b-3 seats %s freeform root corners at both cant signs', (crossSection) => {
  for (const cant of [-Math.PI / 12, Math.PI / 12, 3 * Math.PI / 180]) {
    const tree: RocketTree = { components: [{ type: 'bodytube', length: 0.3, outerRadius: 0.027,
      children: [{ type: 'freeformfinset', points: [[0, 0], [0.02, 0.04], [0.08, 0.04], [0.1, 0]],
        thickness: 0.002, finCount: 1, crossSection, cant, position: { method: 'top', offset: 0.1 } }] }] };
    const built = buildPieces(tree);
    const pos = built.pieces.find(p => p.key.startsWith('fin'))!.geometry.getAttribute('position');
    const ys = Array.from({ length: pos.count }, (_, i) => pos.getY(i));
    const surface = Math.sqrt(0.027 ** 2 - (0.05 * Math.sin(cant)) ** 2);
    expect(Math.min(...ys)).toBeCloseTo(surface, 7); // Float32 metres: <0.1 micrometre.
    expect(Math.max(...ys)).toBeCloseTo(0.067, 7); // The tips are not lowered.
    built.pieces.forEach(p => p.geometry.dispose());
  }
});
