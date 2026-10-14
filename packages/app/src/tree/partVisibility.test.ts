import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { hiddenPartIds, togglePartVisibility } from './partVisibility.js';

const tree = { components: [{ id: 'stage', type: 'stage', children: [
  { id: 'body', type: 'bodytube', children: [
    { id: 'mount', type: 'innertube', children: [{ id: 'ring', type: 'centeringring' }] },
    { id: 'fins', type: 'freeformfinset' },
  ] },
  { id: 'nose', type: 'nosecone' },
] }] } as unknown as RocketTree;

describe('C-B20 session view state', () => {
  it('expands hidden descendants without changing the original tree or the explicit state', () => {
    const original = JSON.stringify(tree);
    const hidden = new Set(['body', 'removed']);
    expect([...hiddenPartIds(tree, hidden)]).toEqual(['body', 'mount', 'ring', 'fins']);
    expect([...hidden]).toEqual(['body', 'removed']);
    expect(JSON.stringify(tree)).toBe(original);
    expect(hiddenPartIds(tree).size).toBe(0);
  });

  it('shows a child through hidden ancestors while retaining independently hidden siblings', () => {
    const hidden = new Set(['stage', 'body', 'ring', 'fins']);
    const shown = togglePartVisibility(tree, hidden, 'ring');
    expect([...shown]).toEqual(['fins']);
    expect([...hidden]).toEqual(['stage', 'body', 'ring', 'fins']);
    expect([...hiddenPartIds(tree, shown)]).toEqual(['fins']);
  });

  it('toggles a visible part immutably and ignores a removed part', () => {
    const hidden = new Set<string>();
    const next = togglePartVisibility(tree, hidden, 'mount');
    expect([...next]).toEqual(['mount']);
    expect(hidden.size).toBe(0);
    expect(togglePartVisibility(tree, next, 'mount').size).toBe(0);
    expect(togglePartVisibility(tree, next, 'removed')).toBe(next);
  });
});
