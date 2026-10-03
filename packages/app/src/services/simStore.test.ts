// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addRun, addRuns, appendImportedRuns, clearRuns, deleteRun, loadRuns, persistFailed, restoreRun, runCapNote, runsEvictedByLastWrite, runsEvictedForUndoByLastWrite,
  runsToCsv, runsToTable, runsUnsavedByLastWrite,
} from './simStore.js';
import { IMPERIAL_UNITS } from '../prefs/units.js';
import { densityAltitudeM } from './atmosphere.js';
import type { SimRun } from './simReport.js';

/**
 * Store tests exercise the persistence round-trip, not simulation output —
 * the store never inspects most SimRun fields, so a cast partial is enough.
 */
const mkRun = (id: string, over: Partial<SimRun> = {}): SimRun =>
  ({
    id,
    when: 1755000000000,
    rocket: 'Alpha III',
    motor: 'C6',
    manufacturer: 'Estes',
    delayS: 5,
    maxAltitude: 300,
    ...over,
  }) as SimRun;

/**
 * Replace localStorage with one whose writes are refused, the way a full
 * origin refuses them — reads still hit the real store so loadRuns() keeps
 * returning the stored truth. Optionally jam removeItem too (blocked site
 * data, not quota: quota never refuses a removeItem).
 */
function jamWrites(opts: { removeToo?: boolean } = {}): void {
  const real = localStorage;
  const boom = () => { throw new DOMException('quota', 'QuotaExceededError'); };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => real.getItem(k),
    setItem: boom,
    removeItem: opts.removeToo ? boom : (k: string) => real.removeItem(k),
  });
}

afterEach(() => {
  // Unstub FIRST so the reset below reaches the real store.
  vi.unstubAllGlobals();
  localStorage.clear();
  clearRuns(); // module-level failure flag survives between tests — reset it
});

describe('persist under quota — the table must not lie', () => {
  it('round-trips normally and reports no failure', () => {
    const out = addRun(mkRun('a'));
    expect(out.map((r) => r.id)).toEqual(['a']);
    expect(loadRuns().map((r) => r.id)).toEqual(['a']);
    expect(persistFailed()).toBe(false);
  });

  it('addRun on a refused write returns the STORED truth, not the wishful list', () => {
    addRun(mkRun('kept'));
    jamWrites();
    const out = addRun(mkRun('lost'));
    // Before the fix this returned ['lost', 'kept'] — a row that vanished on
    // reload. The store must answer with what localStorage actually holds.
    expect(out.map((r) => r.id)).toEqual(['kept']);
    expect(persistFailed()).toBe(true);
    vi.unstubAllGlobals();
    expect(loadRuns().map((r) => r.id)).toEqual(['kept']);
  });

  it('addRuns (batch) takes the same honest path', () => {
    addRun(mkRun('kept'));
    jamWrites();
    const out = addRuns([mkRun('b1'), mkRun('b2')]);
    expect(out.map((r) => r.id)).toEqual(['kept']);
    expect(persistFailed()).toBe(true);
  });

  it('a write that sticks clears the failure flag', () => {
    jamWrites();
    addRun(mkRun('lost'));
    expect(persistFailed()).toBe(true);
    vi.unstubAllGlobals();
    const out = addRun(mkRun('a'));
    expect(out.map((r) => r.id)).toEqual(['a']);
    expect(persistFailed()).toBe(false);
  });

  it('deleteRun on a refused write keeps the run visible (it IS still stored)', () => {
    addRuns([mkRun('a'), mkRun('b')]);
    jamWrites();
    const out = deleteRun('a');
    // The delete did not stick; showing it gone would un-delete on reload.
    expect(out.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(persistFailed()).toBe(true);
  });

  it('clearRuns succeeds even at quota — removeItem frees space, never needs it', () => {
    addRun(mkRun('a'));
    jamWrites(); // setItem refused, removeItem still real
    const out = clearRuns();
    expect(out).toEqual([]);
    expect(persistFailed()).toBe(false);
    vi.unstubAllGlobals();
    expect(loadRuns()).toEqual([]);
  });

  it('clearRuns with storage blocked outright reports the stored truth', () => {
    addRun(mkRun('a'));
    jamWrites({ removeToo: true });
    const out = clearRuns();
    expect(out.map((r) => r.id)).toEqual(['a']);
    expect(persistFailed()).toBe(true);
  });
});

describe('the 500-run cap says what it removed (audit 2026-09-22)', () => {
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => mkRun(`${prefix}${i}`));

  it('300 hand-flown runs plus a 226-motor sweep: 26 hand-flown runs go, and the count says so', () => {
    for (const r of many('hand', 300).reverse()) addRun(r); // newest first, one Launch at a time
    expect(runsEvictedByLastWrite()).toBe(0);
    const out = addRuns(many('sweep', 226));
    expect(out).toHaveLength(500);
    expect(out.filter((r) => r.id.startsWith('hand'))).toHaveLength(274);
    expect(runsEvictedByLastWrite()).toBe(26);
  });

  it('one Launch at the cap removes one, and the next write under it removes none', () => {
    addRuns(many('old', 500));
    addRun(mkRun('fresh'));
    expect(runsEvictedByLastWrite()).toBe(1);
    deleteRun('fresh');
    expect(runsEvictedByLastWrite()).toBe(0);
  });

  it('a refused write removed nothing — the store still holds every run', () => {
    addRuns(many('old', 500));
    jamWrites();
    addRun(mkRun('lost'));
    expect(runsEvictedByLastWrite()).toBe(0);
    expect(runsUnsavedByLastWrite()).toBe(0);
  });

  it('a batch of 600 over 100 saved runs: 100 saved runs go, and 100 of its own were never saved', () => {
    // The cut at 500 falls inside the batch itself, so what it removed is two
    // different things. One lumped count said "the oldest 200" (from review).
    addRuns(many('saved', 100));
    const out = addRuns(many('batch', 600));
    expect(out.map((r) => r.id)).toEqual(many('batch', 500).map((r) => r.id));
    expect(runsEvictedByLastWrite()).toBe(100);
    expect(runsUnsavedByLastWrite()).toBe(100);
  });

  it('a batch that fits leaves nothing unsaved, and the next write resets both counts', () => {
    addRuns(many('saved', 400));
    addRuns(many('batch', 150));
    expect(runsEvictedByLastWrite()).toBe(50);
    expect(runsUnsavedByLastWrite()).toBe(0);
    addRuns(many('huge', 501));
    expect([runsEvictedByLastWrite(), runsUnsavedByLastWrite()]).toEqual([500, 1]);
    deleteRun('huge0');
    expect([runsEvictedByLastWrite(), runsUnsavedByLastWrite()]).toEqual([0, 0]);
  });
});

describe('runCapNote — the one wording of what the cap did', () => {
  it('says nothing when it did nothing', () => {
    expect(runCapNote(0, 0)).toBe('');
  });

  it('names the saved runs it removed', () => {
    expect(runCapNote(1, 0)).toBe('Saved simulations keeps up to 500 runs, so the oldest 1 was removed to make room.');
    expect(runCapNote(26, 0)).toBe('Saved simulations keeps up to 500 runs, so the oldest 26 were removed to make room.');
  });

  it('names the new runs that never fit, apart from the saved ones', () => {
    expect(runCapNote(100, 100)).toBe('Saved simulations keeps up to 500 runs, so the oldest 100 were removed'
      + ' to make room, and 100 new runs did not fit and were not saved.');
    expect(runCapNote(0, 1)).toBe('Saved simulations keeps up to 500 runs, so 1 new run did not fit and was not saved.');
  });
});

describe('restoreRun — the ✕\'s Undo (audit 2026-09-22)', () => {
  const ids = () => loadRuns().map((r) => r.id);

  it('puts a run back above the one that sat below it — flights added since stay on top', () => {
    addRuns([mkRun('a'), mkRun('b'), mkRun('c')]);
    const b = loadRuns()[1]!;
    deleteRun('b');
    addRun(mkRun('new'));
    expect(restoreRun(b, 'c').map((r) => r.id)).toEqual(['new', 'a', 'b', 'c']);
    expect(ids()).toEqual(['new', 'a', 'b', 'c']);
  });

  it('the bottom row goes back to the bottom', () => {
    addRuns([mkRun('a'), mkRun('b')]);
    const b = loadRuns()[1]!;
    deleteRun('b');
    expect(restoreRun(b, null).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it.each([null, 'missing-neighbour'])('Undo protects a nonconflicting bottom row at capacity (%s)', (beforeId) => {
    addRuns(Array.from({ length: 500 }, (_, i) => mkRun(`row-${i}`, { when: 500 - i })));
    const bottom = loadRuns()[499]!;
    deleteRun(bottom.id);
    appendImportedRuns([mkRun('replacement', { importedSummary: true, when: 0 })]);
    const restored = restoreRun(bottom, beforeId);
    expect(restored).toHaveLength(500);
    expect(restored[499]).toEqual(bottom);
    expect(restored.map((r) => r.id)).toEqual(Array.from({ length: 500 }, (_, i) => `row-${i}`));
    expect(loadRuns()).toEqual(restored);
    expect(runsEvictedByLastWrite()).toBe(0);
    expect(runsEvictedForUndoByLastWrite()).toBe(1);
    expect(runCapNote(0, 0, runsEvictedForUndoByLastWrite()))
      .toContain('Undo kept the restored run and any conflicting report and removed the oldest 1 other run in history');
  });

  it('with its neighbour gone too, it goes back by its own time', () => {
    addRuns([mkRun('a', { when: 3 }), mkRun('b', { when: 2 }), mkRun('c', { when: 1 }), mkRun('z', { when: 0 })]);
    const b = loadRuns()[1]!;
    deleteRun('b');
    deleteRun('c');
    addRun(mkRun('d', { when: 4 }));
    expect(restoreRun(b, 'c').map((r) => r.id)).toEqual(['d', 'a', 'b', 'z']);
    expect(ids()).toEqual(['d', 'a', 'b', 'z']);
  });

  it('never doubles a run that is already there', () => {
    addRuns([mkRun('a'), mkRun('b')]);
    const a = loadRuns()[0]!;
    expect(restoreRun(a, 'b').map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('a refused collision restore keeps the imported report and reports no eviction', () => {
    const deleted = mkRun('X', { maxAltitude: 123 });
    const imported = mkRun('X', { maxAltitude: 456, importedSummary: true, importedRunId: 'X' });
    addRuns(Array.from({ length: 499 }, (_, i) => mkRun(`other-${i}`)));
    appendImportedRuns([imported]);
    const before = loadRuns();
    jamWrites();
    expect(restoreRun(deleted, null)).toEqual(before);
    expect(persistFailed()).toBe(true);
    expect(runsEvictedForUndoByLastWrite()).toBe(0);
  });

  it('a no-space import clears stale cap counts without writing or evicting history', () => {
    addRuns(Array.from({ length: 501 }, (_, i) => mkRun(`old-${i}`)));
    expect(runsUnsavedByLastWrite()).toBe(1);
    const bytes = localStorage.getItem('online-openrocket.sim-runs.v1');
    expect(appendImportedRuns([mkRun('imported')])).toHaveLength(500);
    expect(localStorage.getItem('online-openrocket.sim-runs.v1')).toBe(bytes);
    expect([runsEvictedByLastWrite(), runsUnsavedByLastWrite(), runsEvictedForUndoByLastWrite()]).toEqual([0, 0, 0]);
  });
});

const KEY = 'online-openrocket.sim-runs.v1';

describe('a corrupt history costs ONE row, not the store (net-storage-6)', () => {
  it('keeps every usable run and drops only the elements that are not runs', () => {
    localStorage.setItem(KEY, JSON.stringify([
      mkRun('good'),
      null,
      {},                      // no id — cannot be shown, selected or deleted
      'not a run',
      [1, 2],
      { id: 42, when: 1 },     // an id, but not a string one
      mkRun('alsoGood'),
    ]));
    expect(loadRuns().map((r) => r.id)).toEqual(['good', 'alsoGood']);
  });

  it('THE DATA LOSS: the next saved flight no longer overwrites the whole history', () => {
    // Before the fix the unguarded revive loop threw a TypeError on the null,
    // the catch returned [], and addRun's `[run, ...loadRuns()]` persisted just
    // the fresh run over everything — silently, with persistFailed() false.
    localStorage.setItem(KEY, JSON.stringify([mkRun('a'), null, mkRun('b')]));
    expect(addRun(mkRun('fresh')).map((r) => r.id)).toEqual(['fresh', 'a', 'b']);
    expect(loadRuns().map((r) => r.id)).toEqual(['fresh', 'a', 'b']);
    expect(persistFailed()).toBe(false);
  });

  it('a row with unusable FIELD values is kept — dropping it would be the same over-reaction', () => {
    const bent = { ...mkRun('bent'), when: 'yesterday', maxAltitude: 'high' };
    localStorage.setItem(KEY, JSON.stringify([bent, mkRun('ok')]));
    expect(loadRuns().map((r) => r.id)).toEqual(['bent', 'ok']);
  });

  it('normalises an array-typed field whose shape is wrong', () => {
    // `?? []` does not catch a value of the wrong SHAPE: a string survives it
    // and throws on .map/.find/.join instead, inside a click handler.
    localStorage.setItem(KEY, JSON.stringify([{
      ...mkRun('x'), deployments: 'nope', boosterMotors: 7, simWarnings: {}, branches: 'no',
    }]));
    const r = loadRuns()[0]!;
    expect(r.deployments).toBeUndefined();
    expect(r.boosterMotors).toBeUndefined();
    expect(r.simWarnings).toBeUndefined();
    expect(r.branches).toBeUndefined();
    expect(() => runsToCsv(loadRuns())).not.toThrow();
  });

  it('still revives plugged delays on the rows it keeps', () => {
    localStorage.setItem(KEY, JSON.stringify([null, { ...mkRun('p'), delayS: 'Infinity' }]));
    expect(loadRuns()[0]!.delayS).toBe(Infinity);
  });

  it('a payload that is not an array at all is still nothing', () => {
    localStorage.setItem(KEY, JSON.stringify({ id: 'a' }));
    expect(loadRuns()).toEqual([]);
    localStorage.setItem(KEY, 'not json');
    expect(loadRuns()).toEqual([]);
  });
});

describe('one corrupt timestamp must not kill BOTH exports (net-storage-4)', () => {
  const dateCell = (r: SimRun): string | number => {
    const { headers, rows } = runsToTable([r]);
    return rows[0]![headers.indexOf('Date')]!;
  };

  it('a good run still exports its ISO date', () => {
    expect(dateCell(mkRun('a'))).toBe(new Date(1755000000000).toISOString());
  });

  // toISOString() throws RangeError on an Invalid Date, and neither export
  // handler has a try/catch — so one bad row made both buttons silent no-ops
  // for the whole table until the user pressed "Clear all".
  const bad: [string, unknown][] = [
    ['absent', undefined],
    ['a string', 'yesterday'],
    ['finite but past the Date range', 1e16], // Number.isFinite alone lets this through
    ['NaN', NaN],
    ['null', null],
  ];
  for (const [label, when] of bad) {
    it(`degrades to an empty cell, and still exports, when \`when\` is ${label}`, () => {
      const r = { ...mkRun('bad'), when } as unknown as SimRun;
      expect(dateCell(r)).toBe('');
      expect(() => runsToCsv([r])).not.toThrow();
      expect(() => runsToTable([r])).not.toThrow();
    });
  }

  it('one bad row does not cost the good rows their export', () => {
    const rows = [mkRun('a'), { ...mkRun('b'), when: 'nope' } as unknown as SimRun, mkRun('c')];
    const csv = runsToCsv(rows);
    expect(csv.split('\n')).toHaveLength(4); // header + three rows
    expect(csv).toContain(new Date(1755000000000).toISOString());
  });
});

/**
 * THE LEAD COLUMNS SAY "MISSING" THE WAY THE DETAIL COLUMNS DO (audit
 * 2026-09-22). `null * k` is 0, so a refused-motor flight — maxAcceleration
 * null — exported "Accel 0" beside a blank m/s² column. Apogee and velocity
 * used the same unguarded product.
 */
describe('the flight-day lead columns', () => {
  const cell = (r: SimRun, header: string): string | number => {
    const { headers, rows } = runsToTable([r]);
    return rows[0]![headers.indexOf(header)]!;
  };

  it('are blank, not 0, when the run has no figure', () => {
    const r = { ...mkRun('refused'), maxAltitude: null, maxVelocity: null, maxAcceleration: null } as unknown as SimRun;
    expect(cell(r, 'Accel (Gs)')).toBe('');
    expect(cell(r, 'Apogee (ft)')).toBe('');
    expect(cell(r, 'Velocity (mph)')).toBe('');
    // ...exactly as the detail column already was.
    expect(cell(r, 'Max acceleration (m/s2)')).toBe('');
  });

  it('still convert a real figure, and a real zero', () => {
    const r = mkRun('ok', { maxAltitude: 300, maxVelocity: 100, maxAcceleration: 9.80665 * 12 });
    expect(cell(r, 'Apogee (ft)')).toBe(984);
    expect(cell(r, 'Velocity (mph)')).toBe(223.7);
    expect(cell(r, 'Accel (Gs)')).toBe(12);
    expect(cell(mkRun('flat', { maxAcceleration: 0 }), 'Accel (Gs)')).toBe(0);
  });
});

/**
 * A STORED RECOVERY WEIGHT FROM THE WRONG INSTANT (audit 2026-09-22 review).
 * Runs saved before `burnoutMassSettled` hold the mass at the FIRST burnout —
 * on a flight with more than one motor mount, possibly the whole stack
 * (154.3 g stored for a sustainer landing at 81.3 g). The series is not
 * stored, so it cannot be re-read: it is blanked, and only where it can
 * differ.
 */
describe('a stored run’s recovery weight', () => {
  const stored = (runs: object[]): SimRun[] => {
    localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify(runs));
    return loadRuns();
  };
  const weight = (r: SimRun, header = 'Recovery Weight (g)') => {
    const { headers, rows } = runsToTable([r]);
    return rows[0]![headers.indexOf(header)];
  };

  it('is blanked on an unstamped run that flew a second mount or a booster branch', () => {
    const [staged, multiMount] = stored([
      mkRun('staged', { burnoutMass: 0.1543, boosterMotors: ['C6'], branches: [{} as never] }),
      mkRun('outboard', { burnoutMass: 0.1543, boosterMotors: ['C6'] }),
    ]);
    expect(staged!.burnoutMass).toBeNull();
    expect(multiMount!.burnoutMass).toBeNull();
    expect(weight(staged!)).toBe('');
    expect(weight(staged!, 'Recovery weight (kg)')).toBe('');
  });

  it('is kept on an unstamped single-mount run — the first burnout is the last', () => {
    const [single] = stored([mkRun('single', { burnoutMass: 0.04 })]);
    expect(single!.burnoutMass).toBe(0.04);
    expect(weight(single!)).toBe(40);
  });

  it('is kept on a stamped run, staged or not', () => {
    const [staged] = stored([
      mkRun('new', { burnoutMass: 0.0813, burnoutMassSettled: true, boosterMotors: ['C6'] }),
    ]);
    expect(staged!.burnoutMass).toBe(0.0813);
    expect(weight(staged!, 'Recovery weight (kg)')).toBe(0.0813);
  });

  it('heads its detail column "Recovery weight", not "Burnout mass" beside "Time to burnout"', () => {
    const { headers } = runsToTable([mkRun('a')]);
    expect(headers).toContain('Recovery weight (kg)');
    expect(headers.some((h) => /burnout mass/i.test(h))).toBe(false);
  });
});

/**
 * DENSITY ALTITUDE (weather build, step 1): the air each run flew, stored at
 * launch. The column trails even "Flight config", so every column a
 * spreadsheet import already keys on keeps its position.
 */
describe('the density-altitude column', () => {
  it('keeps its position before the new winds-aloft column, in the user’s distance unit', () => {
    // The 4,000 ft / 95 °F worked example, as buildSimRun stores it.
    const da = densityAltitudeM({ launchAltitudeM: 1219.2, temperatureC: 35, pressureHPa: null });
    const { headers, rows } = runsToTable([mkRun('a', { densityAltitudeM: da })], IMPERIAL_UNITS);
    expect(headers.at(-4)).toBe('Density altitude (ft)');
    // 2,170.810 m is 7,122.08 ft (the build spec said 7,122.07; re-measured).
    expect(rows[0]!.at(-4)).toBe(7122.08);
    expect(headers.at(-5)).toBe('Flight config');
  });

  it('is an empty cell for a run flown before the field, and for a stored value that is not a number', () => {
    const { rows } = runsToTable([
      mkRun('old'),
      mkRun('bad', { densityAltitudeM: 'x' as unknown as number }),
    ], IMPERIAL_UNITS);
    expect(rows[0]!.at(-4)).toBe('');
    expect(rows[1]!.at(-4)).toBe('');
  });
});


describe('K16 Safe deployment export', () => {
  it.each([[65, 'yes'], [70, 'yes'], [75, 'caution'], [85, 'caution'], [90, 'caution'], [95, 'NO']] as const)(
    'exports %s ft/s as %s in the existing column, including saved booleans and boosters', (fps, expected) => {
      for (const booster of [false, true]) {
        const d = { device: 'Chute', time: 7, velocityAtDeployment: fps * 3048 / 10000,
          descentRate: 4, descentOk: true, openingOk: false } as NonNullable<SimRun['deployments']>[number];
        const r = mkRun('tier', { safeDeployment: false, velocityAtDeployment: 4,
          windLevels: [{ altitude: 10, speed: 4, direction: 0 }, { altitude: 80, speed: 12, direction: 0.2 }],
          deployments: booster ? [] : [d], branches: booster ? [{ name: 'Booster', deployments: [d],
            apogee: 100, tumbles: false, landingRate: 4, safeLandingRate: true }] : [] });
        addRun(r);
        const saved = loadRuns()[0]!;
        const { headers, rows } = runsToTable([saved]);
        const at = headers.indexOf('Safe deployment');
        expect(headers[at - 1]).toBe('Thrust:weight OK');
        expect(headers[at + 1]).toBe('Static margin OK');
        expect(rows[0]![at]).toBe(expected);
        expect(headers.slice(-5, -2)).toEqual(['Flight config', 'Density altitude (m)', 'Winds aloft (levels)']);
        expect(rows[0]!.at(-3)).toBe(2);
        const csv = runsToCsv([saved]).trim().split(/\r?\n/);
        expect(csv[1]!.split(',')[at]).toBe(expected);
        expect(csv[0]!.split(',').at(-3)).toBe('Winds aloft (levels)');
        expect(csv[1]!.split(',').at(-3)).toBe('2');
        if (!booster && expected === 'caution') expect(rows[0]!.join(' ')).toContain('(caution)');
      }
    });
  it('leaves unknown deployment speed blank', () => {
    const { headers, rows } = runsToTable([mkRun('unknown', { velocityAtDeployment: null, deployments: [] })]);
    expect(rows[0]![headers.indexOf('Safe deployment')]).toBe('');
  });
});

it('persists wind levels and provenance, and appends the profile column after every existing column', () => {
  const windLevels = [{ altitude: 10.123456789, speed: 4, direction: 0 }, { altitude: 200, speed: 8, direction: 0.2, standardDeviation: 0.4 }];
  const windProfileSource = { kind: 'ork' as const };
  addRun(mkRun('profile', { windLevels, windProfileSource }));
  const loaded = loadRuns()[0]!;
  expect(loaded.windLevels).toEqual(windLevels);
  expect(loaded.windProfileSource).toEqual(windProfileSource);
  const { headers, rows } = runsToTable([loaded, mkRun('single')]);
  expect(headers.at(-3)).toBe('Winds aloft (levels)');
  expect(rows.map((r) => r.at(-3))).toEqual([2, '']);
});
