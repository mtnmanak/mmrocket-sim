// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadSession,
  onSessionSaveStateChange,
  saveSessionDebounced,
  sessionPredatesThisBuild,
  sessionSaveFailing,
} from './session.js';
import { APP_VERSION } from '../version.js';
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

describe('a design restored from autosave remembers which build imported it', () => {
  const KEY = 'online-openrocket.session.v1';
  const rewrite = (patch: (raw: Record<string, unknown>) => void) => {
    const raw = JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>;
    patch(raw);
    localStorage.setItem(KEY, JSON.stringify(raw));
  };

  it('stamps the version that saved it', () => {
    saveNow();
    expect(loadSession()!.appVersion).toBe(APP_VERSION);
  });

  it('a session saved by an earlier build is flagged', () => {
    // The tree in localStorage is the PARSED design, not the .ork bytes. An
    // importer fix therefore never reaches a design already open — a tester
    // ran a build that read his stage override correctly and still saw the
    // pre-fix numbers, 8.9 % heavy, because his autosave predated the fix.
    saveNow();
    rewrite((raw) => { raw['appVersion'] = '0.058'; });
    expect(sessionPredatesThisBuild(loadSession()!)).toBe(true);
  });

  it('a session saved before stamping existed is flagged', () => {
    saveNow();
    rewrite((raw) => { delete raw['appVersion']; });
    expect(sessionPredatesThisBuild(loadSession()!)).toBe(true);
  });

  it('a session this build wrote is not flagged', () => {
    saveNow();
    expect(sessionPredatesThisBuild(loadSession()!)).toBe(false);
  });
});

describe('the one-time v0.071 time-step migration fires exactly once', () => {
  const KEY = 'online-openrocket.session.v1';
  /** A session carrying a 0.01 s step, stamped as if written by `version`. */
  const stampFineStep = (version: string | undefined) => {
    saveSessionDebounced({ ...state(), launch: { ...state().launch, timeStepS: 0.01 } });
    vi.runAllTimers();
    const raw = JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>;
    if (version === undefined) delete raw['appVersion'];
    else raw['appVersion'] = version;
    localStorage.setItem(KEY, JSON.stringify(raw));
  };

  it('a pre-0.071 session is raised to the default, once, with the notice flag', () => {
    stampFineStep('0.070');
    const s = loadSession()!;
    expect(s.launch.timeStepS).toBe(0.05);
    expect(s.timeStepWasClamped).toBe(true);
  });

  it('records the step it replaced — the notice has to be able to name it', () => {
    // The clamp overwrites launch.timeStepS in place, so without this the old
    // value survives nowhere and the notice can only offer "it" back.
    stampFineStep('0.070');
    const s = loadSession()!;
    expect(s.timeStepClampedFromS).toBe(0.01);
  });

  it('leaves no replaced-step value on a session it did not clamp', () => {
    stampFineStep('0.071');
    const s = loadSession()!;
    expect(s.timeStepWasClamped).toBeUndefined();
    expect(s.timeStepClampedFromS).toBeUndefined();
  });

  it('a session with no appVersion at all predates the field — raised', () => {
    stampFineStep(undefined);
    const s = loadSession()!;
    expect(s.launch.timeStepS).toBe(0.05);
    expect(s.timeStepWasClamped).toBe(true);
  });

  it('a 0.071 session keeps a fine step — it was typed into the panel', () => {
    stampFineStep('0.071');
    const s = loadSession()!;
    expect(s.launch.timeStepS).toBe(0.01);
    expect(s.timeStepWasClamped).toBeUndefined();
  });

  it('a session from a LATER build is never re-clamped by an upgrade', () => {
    // The original gate was "appVersion !== the running build", which is true
    // after EVERY release — so a step the user chose in v0.071's panel was
    // clamped back on the v0.072 upgrade, with a notice blaming a design file.
    // '0.100' also guards the compare itself: it must sort after '0.071'
    // numerically, not by string luck.
    for (const v of ['0.072', '0.100']) {
      stampFineStep(v);
      const s = loadSession()!;
      expect(s.launch.timeStepS).toBe(0.01);
      expect(s.timeStepWasClamped).toBeUndefined();
    }
  });

  it('a malformed appVersion is treated as old — migrating is the safe side', () => {
    stampFineStep('not-a-version');
    expect(loadSession()!.launch.timeStepS).toBe(0.05);
  });
});
