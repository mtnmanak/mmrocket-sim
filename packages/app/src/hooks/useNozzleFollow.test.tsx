// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { StageMotors } from '../services/nozzleFollow.js';
import { useNozzleFollow, type NozzleCleared, type NozzleLookup } from './useNozzleFollow.js';

/**
 * The nozzle-follow rule as App runs it (Eric, 2026-09-13): the stage's exit
 * diameter follows the MOTOR, so a loadout change replaces it with the new
 * motors' published figure or clears it — and a stage seen for the first time
 * (an open, a restore) is seeded and left alone. Moved out of App.tsx in the
 * 2026-09-22 audit; the pure decision is nozzleFollow.test.ts's, this is the
 * bookkeeping around it that no test could reach.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tree = (nozzle?: number): RocketTree => ({
  name: 'r',
  components: [{ type: 'stage', id: 's1', name: 'Sustainer',
    ...(nozzle !== undefined ? { nozzleExitDiameter: nozzle } : {}) } as ComponentNode],
});

const loadout = (...motorIds: string[]): StageMotors[] => [{
  stageId: 's1', stageName: 'Sustainer',
  motors: motorIds.map((motorId, i) => ({ mountId: `m${i}`, motorId, count: 1, label: `${motorId}-label` })),
}];

/** Published exits by motor id; anything else has none. */
const PUBLISHED: Record<string, number> = { J1: 0.012, K1: 0.016 };
const lookup: NozzleLookup = async (id) => (id && PUBLISHED[id] ? { exitDiameterM: PUBLISHED[id]! } : null);

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** The hook under a harness whose tree lives in a plain ref, like App's mirror. */
function harness(initial: RocketTree, look: NozzleLookup = lookup) {
  const treeRef = { current: initial };
  const writes: RocketTree[] = [];
  const writeTree = (t: RocketTree) => { treeRef.current = t; writes.push(t); };
  const out = { cleared: {} as Record<string, NozzleCleared> };
  function Probe({ l }: { l: StageMotors[] }) {
    out.cleared = useNozzleFollow({ loadout: l, treeRef, writeTree, lookup: look }).cleared;
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const show = async (l: StageMotors[]) => {
    await act(async () => { root!.render(<Probe l={l} />); });
  };
  return { treeRef, writes, out, show };
}

const exitOf = (t: RocketTree) => t.components[0]!['nozzleExitDiameter'];

describe('useNozzleFollow', () => {
  it('seeds a stage it has not seen — an opened file keeps its own nozzle', async () => {
    const h = harness(tree(0.02));
    await h.show(loadout('J1'));
    expect(h.writes).toHaveLength(0);
    expect(exitOf(h.treeRef.current)).toBe(0.02);
  });

  it('puts the new motor’s published exit on the stage when the loadout changes', async () => {
    const h = harness(tree(0.012));
    await h.show(loadout('J1'));
    await h.show(loadout('K1'));
    expect(exitOf(h.treeRef.current)).toBe(0.016);
  });

  it('clears a nozzle that belonged to the previous motor, and says whose it was', async () => {
    const h = harness(tree(0.012));
    await h.show(loadout('J1'));
    await h.show(loadout('X9'));
    expect(exitOf(h.treeRef.current)).toBeUndefined();
    expect(h.out.cleared['s1']).toEqual({ previousLabel: 'J1-label', previousM: 0.012 });
  });

  it('does nothing when the loadout did not change', async () => {
    const h = harness(tree(0.03));
    await h.show(loadout('J1'));
    await h.show(loadout('J1'));
    expect(h.writes).toHaveLength(0);
  });
});
