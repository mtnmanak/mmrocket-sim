// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadSession,
  onSessionSaveStateChange,
  saveSessionDebounced,
  sessionSaveFailing,
} from './session.js';
import type { RocketTree } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';
import type { MountMotor } from '../App.js';

/** Minimal but loadSession-valid state — the save path never inspects more. */
const state = () => ({
  tree: { name: 'Test', components: [] } as RocketTree,
  launch: {
    launchRodLengthM: 1,
    launchRodAngleDeg: 0,
    windAverage: 2,
    windStdDev: 0.2,
    launchAltitudeM: 0,
    temperatureC: null,
    pressureHPa: null,
    latitudeDeg: 45,
  } as LaunchConditions,
});

/** Refuse writes the way a full origin does; reads stay real. */
function jamWrites(): void {
  const real = localStorage;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => real.getItem(k),
    setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
    removeItem: (k: string) => real.removeItem(k),
  });
}

/** Queue a save and run out its debounce timer. */
function saveNow(): void {
  saveSessionDebounced(state());
  vi.runAllTimers();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Unstub FIRST, then flush one clean save: the module-level failing flag
  // survives between tests in this file, and a save that sticks resets it.
  vi.unstubAllGlobals();
  saveNow();
  vi.useRealTimers();
  localStorage.clear();
});

describe('session autosave under quota', () => {
  it('saves after the debounce and reports healthy', () => {
    saveNow();
    expect(loadSession()?.tree.name).toBe('Test');
    expect(sessionSaveFailing()).toBe(false);
  });

  it('a refused write never throws into the timer, but is no longer silent', () => {
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    jamWrites();
    // runAllTimers would surface an exception thrown by the timer callback.
    expect(() => saveNow()).not.toThrow();
    expect(sessionSaveFailing()).toBe(true);
    expect(seen).toEqual([true]);
    off();
  });

  it('dedupes: continuous editing at quota signals the transition once, not 2.5x/s', () => {
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    jamWrites();
    for (let i = 0; i < 5; i++) saveNow(); // five refused saves in a row
    expect(seen).toEqual([true]); // the edge, not the level
    expect(sessionSaveFailing()).toBe(true);
    off();
  });

  it('signals the recovery transition when a save sticks again', () => {
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    jamWrites();
    saveNow();
    vi.unstubAllGlobals(); // quota freed (user cleared runs, etc.)
    saveNow();
    saveNow();
    expect(seen).toEqual([true, false]); // one edge each way
    expect(sessionSaveFailing()).toBe(false);
    expect(loadSession()?.tree.name).toBe('Test');
    off();
  });

  it('unsubscribe stops notifications', () => {
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    off();
    jamWrites();
    saveNow();
    expect(seen).toEqual([]);
    expect(sessionSaveFailing()).toBe(true); // getter still tells the truth
  });
});

describe('session flight-config presets (Stage B)', () => {
  /** The store never inspects motor internals — a cast partial is enough. */
  const mm = (delay: number) => ({
    label: 'C6-5',
    spec: { designation: 'C6', ejectionDelay: delay },
    meta: { label: 'C6-5' },
    ignition: { event: 'automatic', delay: 0 },
  }) as unknown as MountMotor;

  it('round-trips savedConfigs and activeConfigId', () => {
    saveSessionDebounced({
      ...state(),
      savedConfigs: [{ id: 'cfg-a', name: 'Club field C6', isDefault: true, motors: { m1: mm(5) } }],
      activeConfigId: 'cfg-a',
    });
    vi.runAllTimers();
    const s = loadSession()!;
    expect(s.activeConfigId).toBe('cfg-a');
    expect(s.savedConfigs).toHaveLength(1);
    expect(s.savedConfigs![0]!.name).toBe('Club field C6');
    expect(s.savedConfigs![0]!.isDefault).toBe(true);
    expect(s.savedConfigs![0]!.motors['m1']!.spec.ejectionDelay).toBe(5);
  });

  it('revives plugged (Infinity) delays inside config presets, and null active', () => {
    saveSessionDebounced({
      ...state(),
      savedConfigs: [{ id: 'cfg-a', name: null, isDefault: false, motors: { m1: mm(Infinity) } }],
      activeConfigId: null,
    });
    vi.runAllTimers();
    const s = loadSession()!;
    expect(s.activeConfigId).toBeNull();
    expect(s.savedConfigs![0]!.motors['m1']!.spec.ejectionDelay).toBe(Infinity);
  });

  it('sessions saved before Stage B load clean — the fields simply absent', () => {
    saveNow(); // state() carries neither field
    const s = loadSession()!;
    expect(s.tree.name).toBe('Test');
    expect(s.savedConfigs).toBeUndefined();
    expect(s.activeConfigId).toBeUndefined();
  });
});
