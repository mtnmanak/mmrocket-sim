import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { num, numOpt, numOrNull } from './nodeNum.js';
import { buildPieces } from './pieces.js';

const node = (fields: Record<string, unknown>): ComponentNode =>
  ({ type: 'bodytube', id: 'b', ...fields }) as ComponentNode;

describe('nodeNum — NaN is not a number the geometry layer can use', () => {
  it('falls back on NaN, which typeof calls a number', () => {
    // The whole bug in one line: `typeof NaN === 'number'` is true, so eleven
    // of the twelve local copies of this reader passed NaN straight through.
    expect(typeof NaN).toBe('number');
    expect(num(node({ length: NaN }), 'length', 0.3)).toBe(0.3);
    expect(numOpt(node({ length: NaN }), 'length')).toBeUndefined();
    expect(numOrNull(node({ length: NaN }), 'length')).toBeNull();
  });

  it('falls back on the infinities too', () => {
    expect(num(node({ length: Infinity }), 'length', 0.3)).toBe(0.3);
    expect(num(node({ length: -Infinity }), 'length', 0.3)).toBe(0.3);
  });

  it('passes a real number through, including zero and negatives', () => {
    // Zero must NOT fall back — a zero-length shoulder is a real value, and a
    // `|| fb` implementation would silently replace it.
    expect(num(node({ length: 0 }), 'length', 0.3)).toBe(0);
    expect(num(node({ offset: -0.05 }), 'offset', 0)).toBe(-0.05);
    expect(num(node({ length: 0.42 }), 'length', 0.3)).toBe(0.42);
  });

  it('falls back on a missing key and on a non-number', () => {
    expect(num(node({}), 'length', 0.3)).toBe(0.3);
    expect(num(node({ length: '0.4' }), 'length', 0.3)).toBe(0.3);
    expect(num(node({ length: null }), 'length', 0.3)).toBe(0.3);
  });
});

/**
 * The consequence, at the layer that shipped it. `buildPieces` feeds the 3D
 * view, `piecesToStl`, the OBJ export and the glTF export, so a non-finite
 * vertex here is a broken bounding sphere (no frustum culling, no raycast
 * picking) and an STL full of NaN facets written with no throw and no warning —
 * measured at 3,072 of 3,072 facets before the fix.
 */
describe('buildPieces emits only finite vertices from degenerate input', () => {
  const withNose = (fields: Record<string, unknown>): RocketTree => ({
    name: 't',
    components: [{
      type: 'stage',
      id: 's',
      children: [
        { type: 'nosecone', id: 'n', length: 0.1, aftRadius: 0.024, shape: 'ogive', ...fields } as ComponentNode,
        { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.024 } as ComponentNode,
      ],
    } as ComponentNode],
  });

  const allFinite = (tree: RocketTree): boolean =>
    buildPieces(tree).pieces.every((p) => [...p.geometry.attributes['position']!.array]
      .every((v) => Number.isFinite(v)));

  it('survives a NaN radius — the case that wrote a 153,684-byte NaN STL', () => {
    // Math.max(0.0001, NaN) is NaN, so the radius floor meant to stop this
    // never did; the fix is upstream of the floor.
    expect(allFinite(withNose({ aftRadius: NaN }))).toBe(true);
  });

  it('survives a NaN length', () => {
    expect(allFinite(withNose({ length: NaN }))).toBe(true);
  });

  it('survives an Infinity dimension', () => {
    expect(allFinite(withNose({ aftRadius: Infinity }))).toBe(true);
  });

  it('survives a malformed freeform fin point list', () => {
    // `points` is read through a cast, not through `num`, so it needed its own
    // row check — solidMesh's finCutOutline already had one and returned null
    // for exactly this input while buildPieces produced 156 non-finite
    // vertices from it.
    const tree: RocketTree = {
      name: 't',
      components: [{
        type: 'stage',
        id: 's',
        children: [
          { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.024,
            children: [{
              type: 'freeformfinset', id: 'f', finCount: 3, thickness: 0.003,
              points: [[0, 0], 'oops', [0.05, 0.03], [0.05, 0]],
            } as unknown as ComponentNode],
          } as ComponentNode,
        ],
      } as ComponentNode],
    };
    expect(allFinite(tree)).toBe(true);
  });
});
