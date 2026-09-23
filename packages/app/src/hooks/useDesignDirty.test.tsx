// @vitest-environment happy-dom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { MotorSpec, RocketTree } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import type { MountMotor } from '../model/design.js';
import { designFingerprint, type DesignSnapshot } from '../services/dirtyState.js';
import { useDesignDirty, type DesignDirty, type DirtySeed } from './useDesignDirty.js';

/**
 * THE UNSAVED-WORK GUARD (audit 2026-09-22, row 501 — extraction #6 of
 * 8 September). Until it moved out of App.tsx the only test that reached it was
 * a regex counting `markSaved(` in App's text; these drive it the way App does
 * — a snapshot that changes, a starter motor that lands a render later, a save,
 * a flight — and read what the Open prompt and ✕ New would read.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tree = (name: string): RocketTree => ({
  name,
  components: [{ type: 'stage', id: 'st', children: [{ type: 'innertube', id: 'mmt', motorMount: true }] }],
});

const snap = (t: RocketTree, mountMotors: Record<string, MountMotor> = {}): DesignSnapshot => ({
  tree: t, mountMotors, launch: DEFAULT_CONDITIONS, maxMotorLengthByStage: {},
  savedConfigs: [], activeConfigId: null, measured: { massKg: null, cgM: null },
});

const C6: MountMotor = {
  label: 'C6-5',
  spec: {
    designation: 'C6', diameter: 0.018, length: 0.07, cgX: 0.035, ejectionDelay: 5,
    times: [0, 0.2, 1.8], thrusts: [0, 14, 0], masses: [0.024, 0.02, 0.0122],
  } as MotorSpec,
  meta: { label: 'C6-5', manufacturer: 'Estes' },
  ignition: { event: 'automatic', delay: 0 },
};

let roots: Root[] = [];
let hosts: HTMLElement[] = [];

afterEach(() => {
  for (const r of roots) act(() => r.unmount());
  for (const h of hosts) h.remove();
  roots = [];
  hosts = [];
});

interface Harness {
  current: DesignDirty;
  /** Replace the design, as a state change in App does. */
  set: (s: DesignSnapshot) => void;
  /** App's starter-motor ref: what the loader writes as the motor arrives. */
  landing: { current: MountMotor | null };
}

/** App's shape, and nothing else: a snapshot in state, the hook over it. */
function mount(initial: DesignSnapshot, seed: DirtySeed | null): Harness {
  const h = {} as Harness;
  function Probe() {
    const [s, setS] = useState(initial);
    const landing = useRef<MountMotor | null>(null);
    h.current = useDesignDirty(s, seed, { landing, mountId: 'mmt' });
    h.set = setS;
    h.landing = landing;
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Probe />));
  roots.push(root);
  hosts.push(host);
  return h;
}

describe('useDesignDirty — the seeding rule', () => {
  it('a FIRST visit is clean: nobody is asked to save a rocket they have not touched', () => {
    const h = mount(snap(tree('Starter')), null);
    expect(h.current.dirty).toBe(false);
    expect(h.current.savedMark.current).toBe(designFingerprint(snap(tree('Starter'))));
  });

  it('…and an edit after it is work', () => {
    const h = mount(snap(tree('Starter')), null);
    act(() => h.set(snap(tree('Edited'))));
    expect(h.current.dirty).toBe(true);
  });

  it('a restored session reads its stored mark: clean when the design is what was saved', () => {
    const s = snap(tree('Saved'));
    const h = mount(s, { savedMark: designFingerprint(s) });
    expect(h.current.dirty).toBe(false);
    act(() => h.set(snap(tree('Edited since'))));
    expect(h.current.dirty).toBe(true);
  });

  it('a restored session with NO mark is dirty — it cannot prove it was ever saved — and is not re-seeded', () => {
    const h = mount(snap(tree('From an old build')), {});
    expect(h.current.dirty).toBe(true);
    expect(h.current.savedMark.current).toBeNull();
  });

  it('a restored session that had flown since its save is still dirty', () => {
    const s = snap(tree('Flown'));
    expect(mount(s, { savedMark: designFingerprint(s), flownSinceSave: true }).current.dirty).toBe(true);
  });
});

describe('useDesignDirty — the starter motor lands a render after the seed', () => {
  it('re-takes the mark over the rocket WITH the motor, so the untouched starter stays clean', () => {
    const bare = snap(tree('Starter'));
    const h = mount(bare, null);
    // What App's loader does: note the motor, then put it in state.
    act(() => {
      h.landing.current = C6;
      h.set(snap(tree('Starter'), { mmt: C6 }));
    });
    expect(h.current.dirty).toBe(false);
    expect(h.current.savedMark.current).toBe(designFingerprint(snap(tree('Starter'), { mmt: C6 })));
    expect(h.landing.current).toBeNull();
  });

  it('does NOT bless an edit that got in before it — that work keeps its prompt', () => {
    const h = mount(snap(tree('Starter')), null);
    act(() => h.set(snap(tree('Edited first'))));
    act(() => {
      h.landing.current = C6;
      h.set(snap(tree('Edited first'), { mmt: C6 }));
    });
    expect(h.current.dirty).toBe(true);
    expect(h.landing.current).toBeNull();
  });

  it('stands down when another motor beat it to the mount — the pick is work', () => {
    const h = mount(snap(tree('Starter')), null);
    const picked: MountMotor = { ...C6, label: 'B6-4' };
    act(() => {
      h.landing.current = C6;
      h.set(snap(tree('Starter'), { mmt: picked }));
    });
    expect(h.current.dirty).toBe(true);
    // It will never be in state now, so it stops waiting.
    expect(h.landing.current).toBeNull();
  });

  it('keeps waiting while the motor is not in state yet', () => {
    const h = mount(snap(tree('Starter')), null);
    act(() => { h.landing.current = C6; h.set(snap(tree('Starter'))); });
    expect(h.landing.current).toBe(C6);
  });
});

describe('useDesignDirty — a save and a flight', () => {
  it('markSaved makes the design on screen the one on disk, and announces it', () => {
    const h = mount(snap(tree('A')), {});
    const tick = h.current.dirtyTick;
    act(() => h.current.markSaved(designFingerprint(snap(tree('A')))));
    expect(h.current.dirty).toBe(false);
    expect(h.current.dirtyTick).toBeGreaterThan(tick);
  });

  it('a flight is work even though the design did not move, until the next save', () => {
    const s = snap(tree('A'));
    const h = mount(s, { savedMark: designFingerprint(s) });
    const tick = h.current.dirtyTick;
    act(() => h.current.markFlown());
    expect(h.current.dirty).toBe(true);
    expect(h.current.flownSinceSave.current).toBe(true);
    expect(h.current.dirtyTick).toBeGreaterThan(tick);
    act(() => h.current.markSaved(designFingerprint(s)));
    expect(h.current.dirty).toBe(false);
    expect(h.current.flownSinceSave.current).toBe(false);
  });

  it('hands out ONE markSaved and ONE markFlown for the life of the design', () => {
    const h = mount(snap(tree('A')), null);
    const { markSaved, markFlown } = h.current;
    act(() => h.set(snap(tree('B'))));
    expect(h.current.markSaved).toBe(markSaved);
    expect(h.current.markFlown).toBe(markFlown);
  });
});
