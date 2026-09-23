// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushSession,
  loadSession,
  onSessionSaveStateChange,
  saveSessionDebounced,
  sessionPredatesThisBuild,
  sessionSaveFailing,
} from './session.js';
import { APP_VERSION } from '../version.js';
import type { MotorSpec, RocketTree } from '@online-openrocket/engine';
import { kernelSimOptions, type LaunchConditions } from '../components/LaunchPanel.js';
import { conditionsKeyOf } from './simReport.js';
import type { MountMotor } from '../model/design.js';
import { designFingerprint, isDirty, type DesignSnapshot } from './dirtyState.js';
import { findDbMotor } from './motorDb.js';
import { mountMotorFromDb } from './motorMatch.js';

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

describe('a saved design reads saved after the autosave round trip (audit 2026-09-22)', () => {
  it('a catalogue motor that lists no case (motorCase: undefined) does not read as unsaved', () => {
    // The audit's measured case: the Estes C6 has no caseInfo, so
    // mountMotorFromDb writes `motorCase: undefined`; the session's JSON drops
    // the key, and a fingerprint that hashed it as null came back from every
    // reload different from the mark taken before it. dirtyState.stableJson
    // now reads such a key as absent (6f741af); this pins the whole path —
    // the real record, the real save and the real load.
    const db = findDbMotor('C6', undefined, undefined, 'Estes')!;
    const spec = { designation: 'C6', ejectionDelay: 5, masses: [0.0241] } as unknown as MotorSpec;
    const c6 = mountMotorFromDb(db, spec, 5, { event: 'automatic', delay: 0 });
    expect('motorCase' in c6.meta! && c6.meta!.motorCase === undefined).toBe(true);
    const snap: DesignSnapshot = {
      ...state(), mountMotors: { m1: c6 }, maxMotorLengthByStage: {}, savedConfigs: [],
      activeConfigId: null, measured: { massKg: null, cgM: null },
    };
    const mark = designFingerprint(snap);
    saveSessionDebounced({ ...snap, savedMark: mark });
    vi.runAllTimers();
    const s = loadSession()!;
    const reloaded: DesignSnapshot = {
      tree: s.tree, mountMotors: s.mountMotors!, launch: s.launch,
      maxMotorLengthByStage: s.maxMotorLengthByStage!, savedConfigs: s.savedConfigs!,
      activeConfigId: s.activeConfigId!, measured: s.measured!,
    };
    expect('motorCase' in reloaded.mountMotors['m1']!.meta!).toBe(false);
    expect(isDirty(designFingerprint(reloaded), s.savedMark, false)).toBe(false);
  });
});

/**
 * ROD AIM (weather build, step 2) is OPTIONAL, and absent means 0. A session
 * saved before the field restores with no key — nothing fills one in — so the
 * design is the same design (fingerprint, conditions key) and flies the same
 * flight (no rodDirection reaches the kernel). A default-fill here would mark
 * every restored design unsaved, which is the trap the field's doc names.
 */
describe('a session saved before Rod aim', () => {
  it('restores with no aim, the same fingerprint and conditions key, and flies no rod direction', () => {
    // A tilted rod, so "no rod direction" is the aim's doing, not the rod's.
    const launch = { ...state().launch, launchRodAngleDeg: 5 };
    const snap: DesignSnapshot = {
      ...state(), launch, mountMotors: {}, maxMotorLengthByStage: {}, savedConfigs: [],
      activeConfigId: null, measured: { massKg: null, cgM: null },
    };
    const mark = designFingerprint(snap);
    saveSessionDebounced({ ...snap, savedMark: mark });
    vi.runAllTimers();
    const s = loadSession()!;
    expect(s.launch).not.toHaveProperty('launchRodAimDeg');
    expect(kernelSimOptions(s.launch)).not.toHaveProperty('launchRodDirection');
    expect(conditionsKeyOf(s.launch)).toBe(conditionsKeyOf(launch));
    const reloaded: DesignSnapshot = {
      tree: s.tree, mountMotors: s.mountMotors!, launch: s.launch,
      maxMotorLengthByStage: s.maxMotorLengthByStage!, savedConfigs: s.savedConfigs!,
      activeConfigId: s.activeConfigId!, measured: s.measured!,
    };
    expect(isDirty(designFingerprint(reloaded), s.savedMark, false)).toBe(false);
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

describe('flushSession closes the debounce window on the way out', () => {
  it('writes a pending save immediately, without running the timer', () => {
    localStorage.clear();
    saveSessionDebounced({ ...state(), tree: { name: 'Unflushed', components: [] } });
    // The debounce has NOT fired: this is the ~400 ms hole a tab close fell into.
    expect(localStorage.getItem('online-openrocket.session.v1')).toBeNull();
    flushSession();
    expect(loadSession()?.tree.name).toBe('Unflushed');
  });

  it('writes the LATEST pending state, not a stale one', () => {
    // The state must live at module level, not in the timer's closure. Cancel
    // the timer without a module-level copy and the flush has nothing to write
    // — worse than no flush at all, because it drops the write silently.
    localStorage.clear();
    saveSessionDebounced({ ...state(), tree: { name: 'First', components: [] } });
    saveSessionDebounced({ ...state(), tree: { name: 'Second', components: [] } });
    flushSession();
    expect(loadSession()?.tree.name).toBe('Second');
  });

  it('does not re-write on a second flush with nothing pending', () => {
    localStorage.clear();
    saveSessionDebounced({ ...state(), tree: { name: 'Once', components: [] } });
    flushSession();
    const first = localStorage.getItem('online-openrocket.session.v1');
    localStorage.removeItem('online-openrocket.session.v1');
    flushSession(); // nothing pending
    expect(localStorage.getItem('online-openrocket.session.v1')).toBeNull();
    expect(first).not.toBeNull();
  });

  it('a flushed save still lands after the timer would have fired', () => {
    localStorage.clear();
    saveSessionDebounced({ ...state(), tree: { name: 'Flushed', components: [] } });
    flushSession();
    vi.runAllTimers(); // the cancelled timer must not resurrect anything
    expect(loadSession()?.tree.name).toBe('Flushed');
  });
});

describe('the design outranks a re-downloadable cache at quota (critic-3)', () => {
  const KEY = 'online-openrocket.session.v1';
  const CACHE = 'tc:samples:v4:';

  /**
   * A store that refuses writes while the disposable cache is present — the
   * shape of the real failure. thrustcurve.ts writes one `tc:samples:v4:<id>`
   * entry per downloaded curve with no count cap, no size cap and no
   * clear-cache path anywhere in the UI, so a flight day spent browsing motors
   * filled the origin and every debounced autosave after that was refused.
   * `alwaysFull` is the case where freeing the cache is not enough.
   */
  function stubStore(opts: { cacheEntries: number; alwaysFull?: boolean }) {
    const map = new Map<string, string>();
    for (let i = 0; i < opts.cacheEntries; i++) map.set(`${CACHE}m${i}`, '[1,2,3]');
    map.set('tc:samples:v5:future', '[4,5]'); // a later cache version must sweep too
    map.set('online-openrocket.prefs.v1', '{}');
    const full = () => opts.alwaysFull === true
      || [...map.keys()].some((k) => k.startsWith('tc:'));
    vi.stubGlobal('localStorage', {
      get length() { return map.size; },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (full()) throw new DOMException('quota', 'QuotaExceededError');
        map.set(k, v);
      },
      removeItem: (k: string) => { map.delete(k); },
    });
    return map;
  }

  it('spends the thrust-curve cache and retries — the unsaved design survives', () => {
    const map = stubStore({ cacheEntries: 200 });
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    saveNow();
    expect(map.has(KEY)).toBe(true);        // it landed on the retry
    expect(sessionSaveFailing()).toBe(false);
    expect(seen).toEqual([]);               // never even reported failing
    // Only re-downloadable data was given up — including a future cache
    // version, because the sweep matches the family prefix, not `v4`.
    expect([...map.keys()].filter((k) => k.startsWith('tc:'))).toEqual([]);
    expect(map.has('online-openrocket.prefs.v1')).toBe(true);
    off();
  });

  it('the sweep is self-limiting: a second refused save frees nothing more', () => {
    const map = stubStore({ cacheEntries: 3, alwaysFull: true });
    saveNow();
    expect(sessionSaveFailing()).toBe(true);          // freeing was not enough
    expect([...map.keys()].filter((k) => k.startsWith('tc:'))).toEqual([]);
    const before = [...map.keys()].sort();
    for (let i = 0; i < 4; i++) saveNow();            // ~2.5 refusals/s while editing
    expect([...map.keys()].sort()).toEqual(before);   // nothing else is ever spent
  });

  it('with nothing disposable to give, it fails honestly and signals ONE edge', () => {
    const map = stubStore({ cacheEntries: 0, alwaysFull: true });
    map.delete('tc:samples:v5:future');
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    for (let i = 0; i < 5; i++) saveNow();
    expect(sessionSaveFailing()).toBe(true);
    expect(seen).toEqual([true]);                       // the edge, not the level
    expect(map.has('online-openrocket.prefs.v1')).toBe(true);
    off();
  });

  it('leaves the cache alone when the write succeeds', () => {
    const map = stubStore({ cacheEntries: 5 });
    // Not full: the sweep must be a quota response, not a routine cost.
    map.clear();
    map.set(`${CACHE}m0`, '[1]');
    vi.stubGlobal('localStorage', {
      get length() { return map.size; },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
    });
    saveNow();
    expect(map.has(`${CACHE}m0`)).toBe(true);
    expect(sessionSaveFailing()).toBe(false);
  });
});

/**
 * WHERE APPLIED WEATHER CAME FROM (weather build, step 3) survives a reload,
 * is dropped when it does not check out, and never touches the design.
 */
describe('the weather provenance record in the session', () => {
  const snapshot = () => ({
    v: 1, provider: 'open-meteo', endpoint: 'forecast', model: 'best_match',
    place: { label: 'Gerlach, Nevada, US', latitudeDeg: 40.65157, longitudeDeg: -119.35519, method: 'search' },
    grid: { latitudeDeg: 40.66386, longitudeDeg: -119.35593 },
    demElevationM: 1202, forAltitudeM: 1202, timezone: 'America/Los_Angeles',
    validUnix: Date.UTC(2026, 8, 26, 21) / 1000, retrievedAt: '2026-09-22T18:00:00.000Z',
    fetched: { temperatureC: 23.3, pressureHPa: 877.2, windSpeedMs: 1.75, windGustMs: 4.6, windFromDeg: 294 },
    applied: { temperatureC: 23.3, pressureHPa: 877.2 },
    before: { temperatureC: null, pressureHPa: null },
  } as const);

  it('round-trips a well-formed record', () => {
    saveSessionDebounced({ ...state(), weather: snapshot() as never });
    vi.runAllTimers();
    expect(loadSession()!.weather).toEqual(snapshot());
  });

  it('drops a malformed one — and nothing else', () => {
    saveSessionDebounced({ ...state(), weather: { ...snapshot(), applied: { windStdDev: 2 } } as never });
    vi.runAllTimers();
    const s = loadSession()!;
    expect(s).not.toHaveProperty('weather');
    expect(s.launch.windAverage).toBe(2);
  });

  // What this file can hold: the loader hands back the SAME design fields
  // (tree and launch conditions, byte for byte) whether or not a weather record
  // rides along — it neither fills a launch key in nor takes one away. That a
  // restored record leaves a saved-clean design clean in App itself is
  // App.weather.test.tsx's "does not make a saved-clean design dirty".
  it('a session from before the feature loads with none, and a record changes none of the design it restores', () => {
    saveNow();
    const s = loadSession()!;
    expect(s.weather).toBeUndefined();
    saveSessionDebounced({ ...state(), weather: snapshot() as never });
    vi.runAllTimers();
    const w = loadSession()!;
    expect(w.weather).toBeDefined();
    expect(JSON.stringify(w.launch)).toBe(JSON.stringify(s.launch));
    expect(JSON.stringify(w.tree)).toBe(JSON.stringify(s.tree));
  });
});
