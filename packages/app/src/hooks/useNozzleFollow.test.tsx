// @vitest-environment happy-dom
import { act, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import { stageMotors, type StageMotors } from '../services/nozzleFollow.js';
import { applyStageNozzles, motorMounts } from '../tree/treeModel.js';
import { useNozzleFollow, type NozzleCleared, type NozzleLookup } from './useNozzleFollow.js';
import { HISTORY_COALESCE_MS, useTreeHistory, type TreeHistory } from './useTreeHistory.js';

/**
 * The nozzle-follow rule as App runs it (Eric, 2026-09-13): the stage's exit
 * diameter follows the MOTOR, so a loadout change replaces it with the new
 * motors' published figure or clears it — and a stage seen for the first time
 * (an open, a session restored at load) is seeded and left alone. Moved out
 * of App.tsx in the 2026-09-22 audit; the pure decision is
 * nozzleFollow.test.ts's, this is the bookkeeping around it that no test could
 * reach.
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
  const out = {
    cleared: {} as Record<string, NozzleCleared>,
    seed: (() => {}) as (s: readonly StageMotors[]) => void,
  };
  function Probe({ l }: { l: StageMotors[] }) {
    const nf = useNozzleFollow({ loadout: l, treeRef, writeTree, lookup: look });
    out.cleared = nf.cleared;
    out.seed = nf.seed;
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

  /**
   * THE RACE THE 2026-09-22 HANDOFF LEFT UNVERIFIED — real. The record of what
   * was seen is written BEFORE the await (so a second render cannot act on the
   * same change twice), and the old effect dropped its pending decision
   * whenever it re-ran. It re-runs on ANY new loadout array, and the loadout is
   * recomputed from `tree` — so a rename, a keystroke in any field or a motor
   * change on another stage, landing while the first lookup was still loading
   * (the lazy 354 kB nozzles.json chunk on a first visit), re-ran it with
   * nothing left to act on: the new motor flew the PREVIOUS motor's exit, which
   * is the exact outcome the rule exists to prevent.
   */
  it('still acts on a motor change when an unrelated edit lands while its lookup is loading', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow: NozzleLookup = async (id) => { await gate; return lookup(id); };
    const h = harness(tree(0.012), slow);
    await h.show(loadout('J1'));
    await h.show(loadout('K1'));         // the motor change: the lookup is now pending
    h.treeRef.current = { ...h.treeRef.current, name: 'renamed' };
    await h.show(loadout('K1'));         // an unrelated edit: same loadout, new array
    await act(async () => { release(); await gate; });
    expect(exitOf(h.treeRef.current)).toBe(0.016);
    expect(h.treeRef.current.name).toBe('renamed');
  });

  it('leaves a stale decision to the newer loadout when the motors change twice mid-lookup', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow: NozzleLookup = async (id) => { await gate; return lookup(id); };
    const h = harness(tree(0.012), slow);
    await h.show(loadout('J1'));
    await h.show(loadout('K1'));
    await h.show(loadout('X9'));         // no published exit: this one decides
    await act(async () => { release(); await gate; });
    expect(exitOf(h.treeRef.current)).toBeUndefined();
    // Written once, by the newest loadout's decision - K1's never lands.
    expect(h.writes.map(exitOf)).toEqual([undefined]);
  });

  /**
   * The configuration-switch seed (audit 2026-09-22): a loadout recorded
   * before it is written is not a change, so a nozzle the configuration states
   * for it is left where the switch put it.
   */
  it('leaves a seeded loadout alone', async () => {
    const h = harness(tree(0.012));
    await h.show(loadout('J1'));
    h.treeRef.current = tree(0.02);   // the switch writes the configuration's nozzle...
    h.out.seed(loadout('X9'));        // ...having seeded its loadout first
    await h.show(loadout('X9'));
    expect(exitOf(h.treeRef.current)).toBe(0.02);
    expect(h.out.cleared).toEqual({});
  });
});

/**
 * UNDO AFTER A MOTOR CHANGE (audit 2026-09-22, from review). The undo stack
 * holds the tree alone, and the nozzle is the one field in it that follows the
 * MOTOR. The follow effect writes a motor change's exit without an undo step,
 * so every state recorded before the change still carries the PREVIOUS motor's
 * exit — and Ctrl+Z on any earlier edit (a rename, say) put it back under the
 * motor now loaded, where the effect never corrected it because the loadout had
 * not changed. The review's probe: J1's 12 mm restored under K1. The same state
 * Eric's 2026-09-13 rule exists to prevent, and the same mechanism the audit
 * measured at +2.2 % apogee on the configuration-switch path.
 *
 * Driven here through App's three pieces — the history hook, the motors and
 * the follow hook — with `restoring` wired into `onRestore` the way App wires
 * it (and once without, to show what that wiring is for).
 */
describe('useNozzleFollow under the undo history', () => {
  const MOUNT = 'mmt';
  const withMount = (nozzle?: number, name = 'r'): RocketTree => ({
    name,
    components: [{ type: 'stage', id: 's1', name: 'Sustainer',
      ...(nozzle !== undefined ? { nozzleExitDiameter: nozzle } : {}),
      children: [{ type: 'bodytube', id: 'bt', length: 0.5, outerRadius: 0.03, thickness: 0.001, children: [
        { type: 'innertube', id: MOUNT, length: 0.2, outerRadius: 0.015, thickness: 0.0005, motorMount: true },
      ] }] } as ComponentNode],
  });
  const withoutMount = (t: RocketTree): RocketTree => ({
    ...t,
    components: [{ ...t.components[0]!, children: [{ ...t.components[0]!.children![0]!, children: [] }] }],
  });
  const record = (motorId: string): MountMotor => ({
    label: `${motorId}-label`,
    spec: { designation: motorId, diameter: 0.029, length: 0.2, cgX: 0.1, ejectionDelay: Infinity,
      times: [0, 1], thrusts: [0, 0], masses: [0.2, 0.1] },
    meta: { label: motorId, manufacturer: 'AeroTech', motorId },
    ignition: { event: 'automatic', delay: 0 },
  });

  interface Mini {
    h: TreeHistory;
    setMotor: (id: string) => void;
    cleared: Record<string, NozzleCleared>;
  }
  let miniRoot: Root | null = null;
  let miniHost: HTMLElement | null = null;
  // Only the clock the history's coalescing reads; the lookups' promises run as usual.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterEach(() => {
    if (miniRoot) act(() => miniRoot!.unmount());
    miniHost?.remove();
    miniRoot = null;
    miniHost = null;
    vi.useRealTimers();
  });

  function mountMini(initial: RocketTree, motorId: string, opts: { wire?: boolean; look?: NozzleLookup } = {}) {
    const out = { current: undefined as unknown as Mini };
    const restoring: { current: (t: RocketTree) => void } = { current: () => {} };
    function MiniApp() {
      const h = useTreeHistory(initial, {
        onRestore: (t) => { if (opts.wire !== false) restoring.current(t); return t; },
      });
      const [m, setMotor] = useState(motorId);
      const loadout = useMemo(() => {
        const ids = new Set(motorMounts(h.tree).map((n) => n.id));
        return stageMotors(h.tree, [[MOUNT, record(m)] as const].filter(([id]) => ids.has(id)));
      }, [h.tree, m]);
      const nf = useNozzleFollow({ loadout, treeRef: h.treeRef, writeTree: h.writeTree, lookup: opts.look ?? lookup });
      restoring.current = nf.restoring;
      out.current = { h, setMotor, cleared: nf.cleared };
      return null;
    }
    miniHost = document.createElement('div');
    document.body.appendChild(miniHost);
    miniRoot = createRoot(miniHost);
    act(() => miniRoot!.render(<MiniApp />));
    return out;
  }
  /** Let the follow effect's lookups resolve. */
  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
  /** An edit far enough from the last that it is its own undo step. */
  const edit = async (m: { current: Mini }, next: (t: RocketTree) => RocketTree) => {
    await act(async () => { m.current.h.setTree(next(m.current.h.treeRef.current)); });
    await settle();
    vi.setSystemTime(Date.now() + HISTORY_COALESCE_MS + 1);
  };
  const swap = async (m: { current: Mini }, motorId: string) => {
    await act(async () => { m.current.setMotor(motorId); });
    await settle();
  };
  const undo = async (m: { current: Mini }) => { await act(async () => { m.current.h.undo(); }); await settle(); };
  const redo = async (m: { current: Mini }) => { await act(async () => { m.current.h.redo(); }); await settle(); };

  it('Ctrl+Z on an edit made before a motor change keeps the loaded motor’s exit', async () => {
    const m = mountMini(withMount(0.012), 'J1');
    await settle();
    await edit(m, (t) => ({ ...t, name: 'renamed' }));
    await swap(m, 'K1');
    expect(exitOf(m.current.h.treeRef.current)).toBe(0.016);
    await undo(m);
    expect(m.current.h.treeRef.current.name).toBe('r');     // the rename came off...
    expect(exitOf(m.current.h.treeRef.current)).toBe(0.016); // ...and K1 still flies K1's exit
    await redo(m);
    expect(m.current.h.treeRef.current.name).toBe('renamed');
    expect(exitOf(m.current.h.treeRef.current)).toBe(0.016);
    expect(m.current.cleared).toEqual({});
  });

  it('(the defect, reproduced) without the onRestore wiring J1’s 12 mm comes back under K1', async () => {
    const m = mountMini(withMount(0.012), 'J1', { wire: false });
    await settle();
    await edit(m, (t) => ({ ...t, name: 'renamed' }));
    await swap(m, 'K1');
    await undo(m);
    expect(exitOf(m.current.h.treeRef.current)).toBe(0.012);
  });

  it('clears a restored exit when the motor loaded now has none, and says whose it was', async () => {
    const m = mountMini(withMount(0.012), 'J1');
    await settle();
    await edit(m, (t) => ({ ...t, name: 'renamed' }));
    await swap(m, 'X9');
    expect(exitOf(m.current.h.treeRef.current)).toBeUndefined();
    await undo(m);
    expect(exitOf(m.current.h.treeRef.current)).toBeUndefined();
    expect(m.current.cleared['s1']?.previousLabel).toBe('J1-label');
  });

  it('an edit that landed while the new motor’s lookup was loading is undone to the new motor’s exit', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow: NozzleLookup = async (id) => { await gate; return lookup(id); };
    const m = mountMini(withMount(0.012), 'J1', { look: slow });
    await settle();
    await swap(m, 'K1');                                 // pending: the tree still holds J1's 12 mm
    await edit(m, (t) => ({ ...t, name: 'renamed' }));   // pushes that 12 mm state
    await act(async () => { release(); await gate; });
    await settle();
    expect(exitOf(m.current.h.treeRef.current)).toBe(0.016);
    await undo(m);
    expect(m.current.h.treeRef.current.name).toBe('r');
    expect(exitOf(m.current.h.treeRef.current)).toBe(0.016);
  });

  it('undoing a nozzle typed for the motor still loaded puts back the value before it', async () => {
    const m = mountMini(withMount(0.012), 'J1');
    await settle();
    await edit(m, (t) => applyStageNozzles(t, { s1: 0.013 }));
    await undo(m);
    expect(exitOf(m.current.h.treeRef.current)).toBe(0.012);
    await redo(m);
    expect(exitOf(m.current.h.treeRef.current)).toBe(0.013);
  });

  it('undoing a deleted motor mount brings its motor’s exit back with it', async () => {
    const m = mountMini(withMount(0.016), 'K1');
    await settle();
    await edit(m, withoutMount);          // the stage loses its motor: the follow clears the exit
    expect(exitOf(m.current.h.treeRef.current)).toBeUndefined();
    await undo(m);
    // The mount and K1 are back, and so is the exit that was decided for them.
    expect(exitOf(m.current.h.treeRef.current)).toBe(0.016);
  });
});
